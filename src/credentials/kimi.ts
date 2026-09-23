/** Kimi Code subscription credentials and its copy-and-visit device login. */
import { randomBytes } from "node:crypto";
import { arch, hostname, release } from "node:os";
import type { ResolvedProvider } from "../config.ts";
import type { RouteTarget } from "../route.ts";
import { decodeJwtPayload } from "./chatgpt.ts";
import { CredentialError, type AttemptAdvice, type AttemptReport, type Credential, type CredentialProvider } from "./index.ts";
import { defaultCredentialStorePath, loadCredentialStore, saveCredentialStore, type KimiAccount } from "./store.ts";

export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_OAUTH_HOST = "https://auth.kimi.com";
const REFRESH_AHEAD_MS = 5 * 60_000;
const EXPIRY_SKEW_MS = 5 * 60_000;
const DEFAULT_DEVICE_EXPIRY_MS = 15 * 60_000;

export interface KimiDeps {
  storePath?: string;
  fetch?: typeof fetch;
  now?: () => number;
  oauthHost?: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  log?: (message: string) => void;
  deviceId?: string;
  sleep?: (ms: number) => Promise<void>;
}

const transportErrors = new WeakSet<CredentialError>();

function deviceIdFor(deps: KimiDeps): string {
  const path = deps.storePath ?? defaultCredentialStorePath();
  const store = loadCredentialStore(path);
  store.kimi ??= { accounts: [] };
  if (!store.kimi.deviceId) {
    const id = deps.deviceId ?? randomBytes(16).toString("hex");
    if (!/^[0-9a-f]{32}$/.test(id)) throw new CredentialError("kimi", "invalid Kimi device id; expected 32 lowercase hex characters");
    store.kimi.deviceId = id;
    saveCredentialStore(path, store);
  }
  return store.kimi.deviceId;
}

function deviceHeaders(deviceId: string): Record<string, string> {
  const os = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  return {
    "content-type": "application/x-www-form-urlencoded",
    "User-Agent": "KimiCLI/0.14.0",
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": "0.14.0",
    "X-Msh-Device-Name": hostname(),
    "X-Msh-Device-Model": `${os} ${release()} ${arch()}`,
    "X-Msh-Os-Version": release(),
    "X-Msh-Device-Id": deviceId,
  };
}

async function post(deps: KimiDeps, path: string, params: URLSearchParams): Promise<{ response: Response; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${deps.oauthHost ?? KIMI_OAUTH_HOST}${path}`, {
      method: "POST",
      headers: deviceHeaders(deviceIdFor(deps)),
      body: params.toString(),
      signal: AbortSignal.timeout(deps.requestTimeoutMs ?? 30_000),
    });
  } catch (err) {
    const failure = new CredentialError("kimi", `Kimi OAuth request failed: ${err instanceof Error ? err.message : String(err)}`);
    transportErrors.add(failure);
    throw failure;
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    if (!response.ok) return { response, body: {} };
    throw new CredentialError("kimi", `Kimi OAuth returned invalid JSON (${response.status})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (!response.ok) return { response, body: {} };
    throw new CredentialError("kimi", "Kimi OAuth returned an invalid response");
  }
  return { response, body: raw as Record<string, unknown> };
}

function expiresIn(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(seconds * 1000) ? seconds : undefined;
}

function intervalSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function claim(tokens: string[], name: "user_id" | "sub" | "email"): string | undefined {
  for (const token of tokens) {
    const value = decodeJwtPayload(token)?.[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function accountFromResponse(body: Record<string, unknown>, now: () => number, previous?: KimiAccount, invalidExpiryLog?: (message: string) => void): KimiAccount {
  const accessToken = body.access_token;
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous?.refreshToken;
  if (typeof accessToken !== "string" || !accessToken || !refreshToken) {
    throw new CredentialError("kimi", "Kimi OAuth returned no access_token or refresh_token; run `modelplug login kimi` again");
  }
  const tokens = [accessToken, refreshToken];
  const id = tokens.map(token => claim([token], "user_id") ?? claim([token], "sub")).find(Boolean) ?? previous?.id;
  if (!id) throw new CredentialError("kimi", "could not determine the Kimi account id from the tokens");
  const email = claim(tokens, "email")?.toLowerCase() ?? previous?.email;
  const lifetime = expiresIn(body.expires_in);
  if (lifetime === undefined && !invalidExpiryLog) throw new CredentialError("kimi", "Kimi OAuth returned an invalid expires_in");
  if (lifetime === undefined) invalidExpiryLog?.("kimi: token refresh returned an invalid expires_in; treating the token as expired now");
  const account: KimiAccount = {
    id,
    accessToken,
    refreshToken,
    expiresAt: lifetime === undefined ? now() : now() + lifetime * 1000 - EXPIRY_SKEW_MS,
    lastRefresh: new Date(now()).toISOString(),
    source: "login",
  };
  if (email) account.email = email;
  return account;
}

/** Start device authorization, print the visit URL and code, then poll until approved. Caller stores the account. */
export async function loginKimi(deps: KimiDeps = {}): Promise<KimiAccount> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const { response, body } = await post(deps, "/api/oauth/device_authorization", new URLSearchParams({ client_id: KIMI_CLIENT_ID }));
  if (!response.ok) throw new CredentialError("kimi", `device authorization failed (${response.status}); run \`modelplug login kimi\` again`);
  if (typeof body.device_code !== "string" || !body.device_code || typeof body.user_code !== "string" || !body.user_code || typeof body.verification_uri !== "string" || !body.verification_uri) {
    throw new CredentialError("kimi", "device authorization returned no verification URL, user code or device code");
  }
  const deviceCode = body.device_code;
  const started = now();
  const lifetime = expiresIn(body.expires_in);
  const deadlineMs = Math.min(lifetime === undefined ? DEFAULT_DEVICE_EXPIRY_MS : lifetime * 1000, DEFAULT_DEVICE_EXPIRY_MS, deps.timeoutMs ?? Infinity);
  let intervalMs = intervalSeconds(body.interval, 5) * 1000;
  let waitedMs = 0;
  const verificationUrl = typeof body.verification_uri_complete === "string" && body.verification_uri_complete ? body.verification_uri_complete : body.verification_uri;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(verificationUrl);
  } catch {
    throw new CredentialError("kimi", "device authorization returned an invalid verification URL");
  }
  if (parsedUrl.protocol !== "https:") throw new CredentialError("kimi", "device authorization returned a verification URL that is not https");
  log(`Open this URL to approve the login: ${verificationUrl}`);
  log(`Enter this code: ${body.user_code}`);
  let consecutiveTransportFailures = 0;
  while (true) {
    const elapsed = Math.max(now() - started, waitedMs);
    if (elapsed + intervalMs >= deadlineMs) throw new CredentialError("kimi", "login timed out");
    await sleep(intervalMs);
    waitedMs += intervalMs;
    if (Math.max(now() - started, waitedMs) >= deadlineMs) throw new CredentialError("kimi", "login timed out");
    let poll: Awaited<ReturnType<typeof post>>;
    try {
      poll = await post(deps, "/api/oauth/token", new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: KIMI_CLIENT_ID,
      }));
    } catch (err) {
      if (!(err instanceof CredentialError) || !transportErrors.has(err) || ++consecutiveTransportFailures >= 5) throw err;
      continue;
    }
    consecutiveTransportFailures = 0;
    if (poll.response.ok && typeof poll.body.access_token === "string") return accountFromResponse(poll.body, now);
    const reason = poll.body.error;
    if (reason === "authorization_pending") continue;
    if (reason === "slow_down") {
      intervalMs = Math.max(intervalMs + 5_000, intervalSeconds(poll.body.interval, 0) * 1000);
      continue;
    }
    if (reason === "access_denied" || reason === "expired_token") {
      throw new CredentialError("kimi", `login failed: ${reason}${typeof poll.body.error_description === "string" ? ` (${poll.body.error_description})` : ""}`);
    }
    throw new CredentialError("kimi", `device token request failed (${poll.response.status})${typeof reason === "string" ? `: ${reason}` : ""}`);
  }
}

/** The Kimi kind has one account; another login replaces it. */
export function kimiCredentials(provider: ResolvedProvider, deps: KimiDeps = {}): CredentialProvider {
  const path = deps.storePath ?? defaultCredentialStorePath();
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let forceRefresh = false;
  let refreshedFrom: string | undefined;
  let refreshedToken: string | undefined;
  let inflight: Promise<KimiAccount> | undefined;

  function markNeedsLogin(id: string): void {
    const store = loadCredentialStore(path);
    const account = store.kimi?.accounts.find(a => a.id === id);
    if (account && !account.needsLogin) {
      account.needsLogin = true;
      saveCredentialStore(path, store);
    }
  }

  async function refresh(account: KimiAccount): Promise<KimiAccount> {
    if (inflight) return inflight;
    const job = (async () => {
      const { response, body } = await post({ ...deps, storePath: path }, "/api/oauth/token", new URLSearchParams({
        grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: KIMI_CLIENT_ID,
      }));
      const current = loadCredentialStore(path);
      const kimi = current.kimi;
      const stored = kimi?.accounts.find(a => a.id === account.id);
      if (!kimi || !stored) throw new CredentialError("kimi", "the Kimi account was removed during a token refresh; run `modelplug login kimi`");
      // A newer login for the same account wins over an older in-flight refresh.
      if (stored.accessToken !== account.accessToken) return stored;
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) markNeedsLogin(account.id);
        throw new CredentialError("kimi", `token refresh failed (${response.status}) for ${account.email ?? account.id}; run \`modelplug login kimi\` again`);
      }
      if (typeof body.refresh_token === "string" && body.refresh_token) {
        stored.refreshToken = body.refresh_token;
        saveCredentialStore(path, current);
      }
      const updated = accountFromResponse(body, now, stored, log);
      kimi.accounts = [updated];
      saveCredentialStore(path, current);
      if (refreshedFrom === account.accessToken) refreshedToken = updated.accessToken;
      return updated;
    })();
    inflight = job;
    try {
      return await job;
    } finally {
      inflight = undefined;
    }
  }

  return {
    kind: "kimi",
    status(): string[] {
      try {
        const accounts = loadCredentialStore(path).kimi?.accounts ?? [];
        if (accounts.length === 0) return ["no Kimi account (run: modelplug login kimi)"];
        return accounts.map(a => `${a.email ?? a.id} (kimi)  ${a.needsLogin ? "NEEDS LOGIN" : a.expiresAt <= now() ? "expired" : `token valid until ${new Date(a.expiresAt).toISOString()}`}`);
      } catch (err) {
        return [err instanceof Error ? err.message : String(err)];
      }
    },
    async resolve(_target: RouteTarget, _attempt: number): Promise<Credential> {
      let account = loadCredentialStore(path).kimi?.accounts[0];
      if (!account) throw new CredentialError("kimi", `provider "${provider.name}": no Kimi account; run \`modelplug login kimi\``);
      if (account.needsLogin) throw new CredentialError("kimi", `provider "${provider.name}": Kimi account needs a new login; run \`modelplug login kimi\``);
      if (forceRefresh || account.expiresAt - now() < REFRESH_AHEAD_MS) {
        const oldAccount = account;
        const forced = forceRefresh;
        try {
          account = await refresh(account);
        } catch (err) {
          const current = loadCredentialStore(path).kimi?.accounts.find(a => a.id === oldAccount.id);
          if (forced || forceRefresh) {
            refreshedFrom = undefined;
            refreshedToken = undefined;
            throw err;
          }
          if (!current || current.needsLogin || current.accessToken !== oldAccount.accessToken || oldAccount.expiresAt <= now()) throw err;
          log(`kimi: token refresh failed; using the current token: ${err instanceof Error ? err.message : String(err)}`);
          account = current;
        } finally {
          forceRefresh = false;
        }
      }
      return { id: account.id, apiKey: account.accessToken };
    },
    async report(_target: RouteTarget, credential: Credential, report: AttemptReport): Promise<AttemptAdvice> {
      if (report.outcome === "ok") {
        refreshedFrom = undefined;
        refreshedToken = undefined;
        forceRefresh = false;
        return { retry: false };
      }
      if (report.error?.kind === "auth" && report.error.status === 401) {
        const stored = loadCredentialStore(path).kimi?.accounts.find(a => a.id === credential.id);
        if (!stored || !credential.apiKey) return { retry: false };
        if (credential.apiKey !== stored.accessToken) return { retry: true };
        if (stored.needsLogin) return { retry: false };
        if (forceRefresh && refreshedFrom === credential.apiKey) return { retry: true };
        if (refreshedToken === credential.apiKey) {
          markNeedsLogin(credential.id);
          refreshedFrom = undefined;
          refreshedToken = undefined;
          return { retry: false };
        }
        forceRefresh = true;
        refreshedFrom = credential.apiKey;
        refreshedToken = undefined;
        return { retry: true };
      }
      return { retry: false };
    },
  };
}
