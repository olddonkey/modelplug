/** Grok subscription OIDC login and single-account credentials. */
import type { ResolvedProvider } from "../config.ts";
import type { RouteTarget } from "../route.ts";
import { decodeJwtPayload } from "./chatgpt.ts";
import { CredentialError, type AttemptAdvice, type AttemptReport, type Credential, type CredentialProvider } from "./index.ts";
import { runCallbackLogin } from "./oauth.ts";
import { loadCredentialStore, saveCredentialStore, type GrokAccount } from "./store.ts";

export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const GROK_CALLBACK_PORT = 56121;
export const GROK_CALLBACK_PATH = "/callback";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const SKEW_MS = 2 * 60 * 1000;

export interface GrokDeps {
  fetch?: typeof fetch;
  now?: () => number;
  discoveryUrl?: string;
  port?: number;
  open?: (url: string) => void | Promise<void>;
  log?: (message: string) => void;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface GrokCredentialDeps extends GrokDeps {
  storePath: string;
}

function endpoint(value: unknown): string {
  if (typeof value !== "string") throw new CredentialError("grok", "unexpected endpoint in OIDC discovery");
  // Check the literal authority too: URL normalizes an explicit :443 away.
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || !/^(auth|accounts)\.x\.ai$/i.test(authority)) throw new CredentialError("grok", `unexpected endpoint: ${value}`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["auth.x.ai", "accounts.x.ai"].includes(url.hostname) || url.port || url.username || url.password) throw new Error("invalid authority");
  } catch {
    throw new CredentialError("grok", `unexpected endpoint: ${value}`);
  }
  return value;
}

async function discovery(deps: GrokDeps): Promise<{ authorization: string; token: string }> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(deps.discoveryUrl ?? GROK_DISCOVERY_URL, { redirect: "error", signal: AbortSignal.timeout(deps.requestTimeoutMs ?? 30_000) });
  } catch (err) {
    throw new CredentialError("grok", `OIDC discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) throw new CredentialError("grok", `OIDC discovery failed (${response.status})`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new CredentialError("grok", "OIDC discovery returned invalid JSON"); }
  const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return { authorization: endpoint(fields.authorization_endpoint), token: endpoint(fields.token_endpoint) };
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
}

async function tokenRequest(url: string, params: URLSearchParams, deps: GrokDeps, operation: string): Promise<TokenAnswer> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params.toString(), redirect: "error", signal: AbortSignal.timeout(deps.requestTimeoutMs ?? 30_000) });
  } catch (err) {
    throw new CredentialError("grok", `${operation} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    throw Object.assign(new CredentialError("grok", `${operation} failed (${response.status})`), { status: response.status });
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new CredentialError("grok", `${operation} returned invalid JSON`); }
  return body && typeof body === "object" ? body as TokenAnswer : {};
}

function expiresIn(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && Number.isFinite(seconds * 1000) ? seconds : undefined;
}

function identity(accessToken: string, idToken?: string): { id: string; email?: string } {
  const idClaims = idToken ? decodeJwtPayload(idToken) : undefined;
  const accessClaims = decodeJwtPayload(accessToken);
  const sub = typeof idClaims?.sub === "string" && idClaims.sub ? idClaims.sub : accessClaims?.sub;
  if (typeof sub !== "string" || !sub) throw new CredentialError("grok", "could not determine the Grok account id from the tokens");
  const email = typeof idClaims?.email === "string" && idClaims.email ? idClaims.email : accessClaims?.email;
  return { id: sub, ...(typeof email === "string" ? { email: email.toLowerCase() } : {}) };
}

function accountFromAnswer(answer: TokenAnswer, now: () => number, previous?: GrokAccount): GrokAccount {
  const accessToken = answer.access_token;
  const lifetime = expiresIn(answer.expires_in);
  if (typeof accessToken !== "string" || !accessToken || lifetime === undefined) throw new CredentialError("grok", "token response returned an invalid access_token or expires_in");
  const refreshToken = typeof answer.refresh_token === "string" && answer.refresh_token ? answer.refresh_token : previous?.refreshToken;
  if (!refreshToken) throw new CredentialError("grok", "token exchange returned no refresh_token");
  const idToken = typeof answer.id_token === "string" ? answer.id_token : previous?.idToken;
  let who: { id: string; email?: string };
  try { who = identity(accessToken, typeof answer.id_token === "string" ? answer.id_token : undefined); }
  catch (err) {
    if (!previous || !(err instanceof CredentialError)) throw err;
    who = { id: previous.id, ...(previous.email ? { email: previous.email } : {}) };
  }
  return {
    id: who.id,
    ...(who.email ? { email: who.email } : {}),
    accessToken,
    refreshToken,
    expiresAt: now() + lifetime * 1000 - SKEW_MS,
    lastRefresh: new Date(now()).toISOString(),
    source: "login",
    ...(idToken ? { idToken } : {}),
  };
}

export async function loginGrok(deps: GrokDeps = {}): Promise<GrokAccount> {
  const { authorization, token } = await discovery(deps);
  const port = deps.port ?? GROK_CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}${GROK_CALLBACK_PATH}`;
  const { code, verifier } = await runCallbackLogin({
    kind: "grok", port, path: GROK_CALLBACK_PATH,
    buildAuthorizeUrl: (state, challenge) => {
      const url = new URL(authorization);
      for (const [name, value] of Object.entries({ response_type: "code", client_id: GROK_CLIENT_ID, redirect_uri: redirectUri, scope: SCOPE, code_challenge: challenge, code_challenge_method: "S256", state })) url.searchParams.set(name, value);
      return url.toString();
    },
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.open ? { open: deps.open } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
  const answer = await tokenRequest(token, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: GROK_CLIENT_ID, code_verifier: verifier }), deps, "token exchange");
  return accountFromAnswer(answer, deps.now ?? Date.now);
}

export function grokCredentials(_provider: ResolvedProvider, deps: GrokCredentialDeps): CredentialProvider {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let forceRefresh = false;
  let refreshedFrom: string | undefined;
  let refreshedToken: string | undefined;
  let discovered: Promise<{ authorization: string; token: string }> | undefined;
  const inflight = new Map<string, Promise<GrokAccount>>();

  function endpoints(): Promise<{ authorization: string; token: string }> {
    if (!discovered) discovered = discovery(deps).catch(err => { discovered = undefined; throw err; });
    return discovered;
  }

  function markNeedsLogin(id: string): void {
    const store = loadCredentialStore(deps.storePath);
    const account = store.grok?.accounts.find(a => a.id === id);
    if (account && !account.needsLogin) {
      account.needsLogin = true;
      saveCredentialStore(deps.storePath, store);
    }
  }

  async function refresh(account: GrokAccount): Promise<GrokAccount> {
    const existing = inflight.get(account.accessToken);
    if (existing) return existing;
    const job = (async () => {
      const { token } = await endpoints();
      let answer: TokenAnswer;
      try {
        answer = await tokenRequest(token, new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: GROK_CLIENT_ID }), deps, "token refresh");
      } catch (err) {
        const latest = loadCredentialStore(deps.storePath).grok?.accounts[0];
        if (!latest) throw new CredentialError("grok", "the Grok account was removed during a token refresh; run `modelplug login grok`");
        if (latest.accessToken !== account.accessToken) return latest;
        const status = err instanceof CredentialError && "status" in err ? err.status : undefined;
        if (status === 400 || status === 401) markNeedsLogin(account.id);
        throw err;
      }
      const store = loadCredentialStore(deps.storePath);
      const stored = store.grok?.accounts[0];
      if (!stored) throw new CredentialError("grok", "the Grok account was removed during a token refresh; run `modelplug login grok`");
      if (stored.accessToken !== account.accessToken) {
        refreshedFrom = undefined;
        refreshedToken = undefined;
        return stored;
      }
      if (typeof answer.refresh_token === "string" && answer.refresh_token && answer.refresh_token !== stored.refreshToken) {
        stored.refreshToken = answer.refresh_token;
        saveCredentialStore(deps.storePath, store);
      }
      const updated = accountFromAnswer(answer, now, stored);
      store.grok!.accounts[0] = updated;
      saveCredentialStore(deps.storePath, store);
      if (refreshedFrom === account.accessToken) refreshedToken = updated.accessToken;
      return updated;
    })();
    inflight.set(account.accessToken, job);
    try { return await job; } finally { inflight.delete(account.accessToken); }
  }

  return {
    kind: "grok",
    status(): string[] {
      try {
        const accounts = loadCredentialStore(deps.storePath).grok?.accounts ?? [];
        return accounts.length ? accounts.map(a => `${a.email ?? a.id} (grok) ${a.needsLogin ? "NEEDS LOGIN" : a.expiresAt <= now() ? "expired" : `token valid until ${new Date(a.expiresAt).toISOString()}`}`) : ["no Grok account (run: modelplug login grok)"];
      } catch (err) { return [err instanceof Error ? err.message : String(err)]; }
    },
    async resolve(_target: RouteTarget, _attempt: number): Promise<Credential> {
      let account = loadCredentialStore(deps.storePath).grok?.accounts[0];
      if (!account) throw new CredentialError("grok", "no Grok account; run `modelplug login grok`");
      if (account.needsLogin) throw new CredentialError("grok", `account ${account.id} needs a new login; run \`modelplug login grok\``);
      if (forceRefresh || account.expiresAt - now() < SKEW_MS) {
        const old = account;
        const forced = forceRefresh;
        try { account = await refresh(account); }
        catch (err) {
          const current = loadCredentialStore(deps.storePath).grok?.accounts[0];
          if (forced || forceRefresh) {
            refreshedFrom = undefined;
            refreshedToken = undefined;
            throw err;
          }
          if (!current || current.needsLogin || current.accessToken !== old.accessToken || current.expiresAt <= now()) throw err;
          log(`grok: token refresh failed; using the current token: ${err instanceof Error ? err.message : String(err)}`);
          account = current;
        } finally { forceRefresh = false; }
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
        const stored = loadCredentialStore(deps.storePath).grok?.accounts.find(a => a.id === credential.id);
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
