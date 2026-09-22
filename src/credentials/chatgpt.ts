/**
 * ChatGPT subscription credentials for the Codex backend.
 *
 * Milestone 2 scope: one account, imported from Codex's own `auth.json`
 * (read-only), refreshed through the same token endpoint Codex uses, quota
 * headers observed. Pools, selection and PKCE login are milestone 3.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedProvider } from "../config.ts";
import type { RouteTarget } from "../route.ts";
import { CredentialError, type AttemptAdvice, type AttemptReport, type Credential, type CredentialProvider } from "./index.ts";
import { loadCredentialStore, saveCredentialStore, type ChatgptAccount, type CredentialStore } from "./store.ts";

export const CHATGPT_BACKEND_URL = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Codex CLI's OAuth client id; the refresh endpoint only honours tokens minted for it. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
const AUTH_CLAIM = "https://api.openai.com/auth";

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Expiry in ms since epoch, or undefined when the token carries no `exp`. */
export function tokenExpiresAt(token: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

function authClaims(token: string | undefined): Record<string, unknown> {
  const claims = token ? decodeJwtPayload(token) : undefined;
  const auth = claims?.[AUTH_CLAIM];
  return auth && typeof auth === "object" ? (auth as Record<string, unknown>) : {};
}

export function defaultCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
}

/** Read Codex's `auth.json` without writing to it. */
export function importCodexAuth(path: string, now: () => number = Date.now): ChatgptAccount {
  if (!existsSync(path)) throw new CredentialError("chatgpt", `${path} not found; log in with \`codex login\` first, then import`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CredentialError("chatgpt", `${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tokens = (raw as { tokens?: Record<string, unknown> } | null)?.tokens;
  const accessToken = tokens?.access_token;
  const refreshToken = tokens?.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new CredentialError("chatgpt", `${path} has no ChatGPT tokens (API-key logins cannot be imported)`);
  }
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : undefined;
  const fromId = authClaims(idToken);
  const fromAccess = authClaims(accessToken);
  const accountId =
    (typeof tokens?.account_id === "string" && tokens.account_id) ||
    (typeof fromId.chatgpt_account_id === "string" && fromId.chatgpt_account_id) ||
    (typeof fromAccess.chatgpt_account_id === "string" && fromAccess.chatgpt_account_id) ||
    undefined;
  if (!accountId) throw new CredentialError("chatgpt", `${path}: could not determine the ChatGPT account id`);
  const email = idToken ? decodeJwtPayload(idToken)?.email : undefined;
  const planType = fromId.chatgpt_plan_type ?? fromAccess.chatgpt_plan_type;
  const account: ChatgptAccount = {
    id: accountId,
    accountId,
    accessToken,
    refreshToken,
    lastRefresh: new Date(now()).toISOString(),
    source: "import",
  };
  if (typeof email === "string") account.email = email;
  if (typeof planType === "string") account.planType = planType;
  if (idToken) account.idToken = idToken;
  return account;
}

/* --------------------------------------------------------------- quota */

export interface QuotaWindow {
  usedPercent?: number;
  /** ms since epoch */
  resetAt?: number;
  windowMinutes?: number;
}

export interface QuotaSnapshot {
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
  tertiary?: QuotaWindow;
  observedAt: number;
}

const WINDOWS = ["primary", "secondary", "tertiary"] as const;

export function parseQuotaHeaders(headers: Headers, now: number): QuotaSnapshot | undefined {
  const snapshot: QuotaSnapshot = { observedAt: now };
  let any = false;
  for (const name of WINDOWS) {
    const window: QuotaWindow = {};
    const used = headers.get(`x-codex-${name}-used-percent`);
    if (used !== null && Number.isFinite(Number(used))) window.usedPercent = Number(used);
    const resetAt = headers.get(`x-codex-${name}-reset-at`);
    if (resetAt !== null) {
      const numeric = Number(resetAt);
      const ms = Number.isFinite(numeric) ? (numeric > 1e12 ? numeric : numeric * 1000) : Date.parse(resetAt);
      if (Number.isFinite(ms)) window.resetAt = ms;
    }
    const resetAfter = headers.get(`x-codex-${name}-reset-after-seconds`);
    if (resetAfter !== null && Number.isFinite(Number(resetAfter)) && window.resetAt === undefined) window.resetAt = now + Number(resetAfter) * 1000;
    const minutes = headers.get(`x-codex-${name}-window-minutes`);
    if (minutes !== null && Number.isFinite(Number(minutes))) window.windowMinutes = Number(minutes);
    if (Object.keys(window).length > 0) {
      snapshot[name] = window;
      any = true;
    }
  }
  return any ? snapshot : undefined;
}

/* ------------------------------------------------------------ provider */

export interface ChatgptDeps {
  storePath: string;
  fetch?: typeof fetch;
  now?: () => number;
  tokenUrl?: string;
}

export interface ChatgptCredentialProvider extends CredentialProvider {
  accounts(): ChatgptAccount[];
  quota(): Map<string, QuotaSnapshot>;
}

export function chatgptCredentials(provider: ResolvedProvider, deps: ChatgptDeps): ChatgptCredentialProvider {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const tokenUrl = deps.tokenUrl ?? CHATGPT_TOKEN_URL;
  const forceRefresh = new Set<string>();
  const refreshedSinceSuccess = new Set<string>();
  const inflight = new Map<string, Promise<ChatgptAccount>>();
  const quota = new Map<string, QuotaSnapshot>();

  function pick(store: CredentialStore): ChatgptAccount {
    const usable = store.chatgpt.accounts.filter(a => !a.needsLogin);
    if (usable.length === 0) {
      const stale = store.chatgpt.accounts.length;
      throw new CredentialError(
        "chatgpt",
        stale > 0
          ? `provider "${provider.name}": every ChatGPT account needs a new login; run \`modelplug login chatgpt --import\``
          : `provider "${provider.name}": no ChatGPT account; run \`modelplug login chatgpt --import\``,
      );
    }
    return usable.find(a => a.id === store.chatgpt.active) ?? usable[0]!;
  }

  async function refresh(account: ChatgptAccount): Promise<ChatgptAccount> {
    const pending = inflight.get(account.id);
    if (pending) return pending;
    const job = (async () => {
      let response: Response;
      try {
        response = await doFetch(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: account.refreshToken }).toString(),
        });
      } catch (err) {
        throw new CredentialError("chatgpt", `token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status === 400 || response.status === 401) {
          const store = loadCredentialStore(deps.storePath);
          const stored = store.chatgpt.accounts.find(a => a.id === account.id);
          if (stored) {
            stored.needsLogin = true;
            saveCredentialStore(deps.storePath, store);
          }
        }
        throw new CredentialError("chatgpt", `token refresh failed (${response.status}) for ${account.email ?? account.id}: ${text.slice(0, 200)}; run \`modelplug login chatgpt --import\` again`);
      }
      const body = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
      if (typeof body.access_token !== "string") throw new CredentialError("chatgpt", "token refresh returned no access_token");
      const store = loadCredentialStore(deps.storePath);
      const stored = store.chatgpt.accounts.find(a => a.id === account.id);
      const updated: ChatgptAccount = { ...(stored ?? account), accessToken: body.access_token, lastRefresh: new Date(now()).toISOString() };
      if (typeof body.refresh_token === "string") updated.refreshToken = body.refresh_token;
      if (typeof body.id_token === "string") updated.idToken = body.id_token;
      delete updated.needsLogin;
      store.chatgpt.accounts = store.chatgpt.accounts.map(a => (a.id === account.id ? updated : a));
      if (!stored) store.chatgpt.accounts.push(updated);
      saveCredentialStore(deps.storePath, store);
      return updated;
    })();
    inflight.set(account.id, job);
    try {
      return await job;
    } finally {
      inflight.delete(account.id);
    }
  }

  return {
    kind: "chatgpt",
    accounts: () => loadCredentialStore(deps.storePath).chatgpt.accounts,
    quota: () => quota,
    status(): string[] {
      let accounts: ChatgptAccount[];
      try {
        accounts = loadCredentialStore(deps.storePath).chatgpt.accounts;
      } catch (err) {
        return [err instanceof Error ? err.message : String(err)];
      }
      if (accounts.length === 0) return ["no ChatGPT account (run: modelplug login chatgpt --import)"];
      return accounts.map(account => {
        const snapshot = quota.get(account.id);
        const who = `${account.email ?? account.id}${account.planType ? ` (${account.planType})` : ""}${account.needsLogin ? "  NEEDS LOGIN" : ""}`;
        return `${who}  ${describeWindow("primary", snapshot?.primary, now())}  ${describeWindow("secondary", snapshot?.secondary, now())}`;
      });
    },
    async resolve(_target: RouteTarget, _attempt: number): Promise<Credential> {
      let account = pick(loadCredentialStore(deps.storePath));
      const expiresAt = tokenExpiresAt(account.accessToken);
      const expiring = expiresAt !== undefined && expiresAt - now() < REFRESH_AHEAD_MS;
      if (forceRefresh.has(account.id) || expiring) {
        account = await refresh(account);
        forceRefresh.delete(account.id);
      }
      return { id: account.id, apiKey: account.accessToken, headers: { "chatgpt-account-id": account.accountId } };
    },
    async report(_target: RouteTarget, credential: Credential, report: AttemptReport): Promise<AttemptAdvice> {
      if (report.headers) {
        const snapshot = parseQuotaHeaders(report.headers, now());
        if (snapshot) quota.set(credential.id, snapshot);
      }
      if (report.outcome === "ok") {
        refreshedSinceSuccess.delete(credential.id);
        return { retry: false };
      }
      if (report.error?.kind === "auth" && !refreshedSinceSuccess.has(credential.id)) {
        forceRefresh.add(credential.id);
        refreshedSinceSuccess.add(credential.id);
        return { retry: true };
      }
      return { retry: false };
    },
  };
}

function describeWindow(fallback: string, window: QuotaWindow | undefined, now: number): string {
  const label = window?.windowMinutes === 300 ? "5h" : window?.windowMinutes === 10080 ? "weekly" : window?.windowMinutes ? `${window.windowMinutes}m` : fallback;
  if (!window || window.usedPercent === undefined) return `${label}: n/a`;
  const reset = window.resetAt !== undefined ? `, resets in ${formatDuration(window.resetAt - now)}` : "";
  return `${label}: ${window.usedPercent}% used${reset}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
