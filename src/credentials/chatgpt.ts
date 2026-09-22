/**
 * ChatGPT subscription credentials for the Codex backend: a pool of accounts.
 *
 * Accounts come from Codex's own `auth.json` (imported read-only) or from the
 * PKCE login in `./chatgpt-login.ts`; tokens are refreshed through the same
 * endpoint Codex uses; quota headers are observed on every answer.
 *
 * Selection, conversation affinity and cooldowns live in memory and are lost
 * on restart, deliberately. Rotation is `resolve()` handing out a different
 * account on the next attempt of the same target after `report()` asked for a
 * retry; the attempt loop does not know pools exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedProvider } from "../config.ts";
import type { RouteTarget } from "../route.ts";
import { CredentialError, type AttemptAdvice, type AttemptReport, type Credential, type CredentialProvider } from "./index.ts";
import type { AccountStrategy } from "./kinds.ts";
import { loadCredentialStore, saveCredentialStore, type ChatgptAccount, type CredentialStore } from "./store.ts";

export const CHATGPT_BACKEND_URL = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Codex CLI's OAuth client id; the token endpoint only honours tokens minted for it. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
const AUTH_CLAIM = "https://api.openai.com/auth";
/** A conversation stays on its account this long after its last request. */
export const AFFINITY_TTL_MS = 60 * 60 * 1000;
/** Cooldown when a usage-limit answer carries no reset hint at all. */
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_COOLDOWN_MS = 30 * 1000;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** When the source states it (Codex's auth.json does); otherwise read from the token claims. */
  accountId?: string;
}

/** Build an account record from a token set: the account id, email and plan come from the JWT claims. */
export function accountFromTokens(tokens: TokenSet, source: ChatgptAccount["source"], now: () => number = Date.now): ChatgptAccount {
  const fromId = authClaims(tokens.idToken);
  const fromAccess = authClaims(tokens.accessToken);
  const accountId =
    tokens.accountId || (typeof fromId.chatgpt_account_id === "string" && fromId.chatgpt_account_id) || (typeof fromAccess.chatgpt_account_id === "string" && fromAccess.chatgpt_account_id) || undefined;
  if (!accountId) throw new CredentialError("chatgpt", "could not determine the ChatGPT account id from the tokens");
  const email = tokens.idToken ? decodeJwtPayload(tokens.idToken)?.email : undefined;
  const planType = fromId.chatgpt_plan_type ?? fromAccess.chatgpt_plan_type;
  const account: ChatgptAccount = {
    id: accountId,
    accountId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    lastRefresh: new Date(now()).toISOString(),
    source,
  };
  if (typeof email === "string") account.email = email;
  if (typeof planType === "string") account.planType = planType;
  if (tokens.idToken) account.idToken = tokens.idToken;
  return account;
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
  const set: TokenSet = { accessToken, refreshToken };
  if (typeof tokens?.id_token === "string") set.idToken = tokens.id_token;
  if (typeof tokens?.account_id === "string" && tokens.account_id) set.accountId = tokens.account_id;
  try {
    return accountFromTokens(set, "import", now);
  } catch (err) {
    throw new CredentialError("chatgpt", `${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Add or replace an account in the store. Never pins it; `account use` does that. */
export function upsertAccount(store: CredentialStore, account: ChatgptAccount): void {
  const index = store.chatgpt.accounts.findIndex(a => a.id === account.id);
  if (index >= 0) store.chatgpt.accounts[index] = account;
  else store.chatgpt.accounts.push(account);
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

/**
 * The busiest window's used percent, or -1 when nothing has been observed yet
 * (untested accounts go first). A window whose reset time has passed counts as
 * empty: the snapshot is stale, not the account.
 */
export function usageScore(snapshot: QuotaSnapshot | undefined, now: number): number {
  if (!snapshot) return -1;
  let score = -1;
  for (const name of WINDOWS) {
    const window = snapshot[name];
    if (!window || window.usedPercent === undefined) continue;
    const used = window.resetAt !== undefined && window.resetAt <= now ? 0 : window.usedPercent;
    if (used > score) score = used;
  }
  return score;
}

/** When a usage-limited account may be tried again: the exhausted window's reset, else the nearest reset, else a default. */
function cooldownUntil(now: number, error: { retryAfterMs?: number } | undefined, snapshot: QuotaSnapshot | undefined): number {
  let until: number | undefined;
  if (error?.retryAfterMs !== undefined && error.retryAfterMs > 0) until = now + error.retryAfterMs;
  else if (snapshot) {
    const windows = WINDOWS.map(n => snapshot[n]).filter((w): w is QuotaWindow => !!w && w.resetAt !== undefined && w.resetAt > now);
    const exhausted = windows.filter(w => (w.usedPercent ?? 0) >= 99);
    const pick = (exhausted.length > 0 ? exhausted : windows).sort((a, b) => a.resetAt! - b.resetAt!)[0];
    if (pick) until = pick.resetAt;
  }
  const span = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, (until ?? now + DEFAULT_COOLDOWN_MS) - now));
  return now + span;
}

/* ------------------------------------------------------------ provider */

export interface ChatgptDeps {
  storePath: string;
  fetch?: typeof fetch;
  now?: () => number;
  tokenUrl?: string;
  log?: (message: string) => void;
}

export interface Cooldown {
  until: number;
  reason: string;
}

export interface ChatgptCredentialProvider extends CredentialProvider {
  accounts(): ChatgptAccount[];
  quota(): Map<string, QuotaSnapshot>;
  cooldowns(): Map<string, Cooldown>;
}

export function chatgptCredentials(provider: ResolvedProvider, deps: ChatgptDeps): ChatgptCredentialProvider {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const tokenUrl = deps.tokenUrl ?? CHATGPT_TOKEN_URL;
  const log = deps.log ?? (() => {});
  const strategy: AccountStrategy = provider.strategy ?? "lowest-usage";
  const forceRefresh = new Set<string>();
  const refreshedSinceSuccess = new Set<string>();
  const inflight = new Map<string, Promise<ChatgptAccount>>();
  const quota = new Map<string, QuotaSnapshot>();
  const cooldown = new Map<string, Cooldown>();
  const affinity = new Map<string, { accountId: string; lastUsed: number }>();
  let roundRobin = 0;

  const label = (account: ChatgptAccount): string => account.email ?? account.id;

  function usable(store: CredentialStore): ChatgptAccount[] {
    const t = now();
    for (const [id, c] of cooldown) if (c.until <= t) cooldown.delete(id);
    return store.chatgpt.accounts.filter(a => !a.needsLogin && !cooldown.has(a.id));
  }

  function nothingUsable(store: CredentialStore): CredentialError {
    const total = store.chatgpt.accounts.length;
    if (total === 0) return new CredentialError("chatgpt", `provider "${provider.name}": no ChatGPT account; run \`modelplug login chatgpt --import\``);
    const cooling = store.chatgpt.accounts.filter(a => cooldown.has(a.id));
    if (cooling.length > 0 && cooling.length + store.chatgpt.accounts.filter(a => a.needsLogin).length === total) {
      const soonest = Math.min(...cooling.map(a => cooldown.get(a.id)!.until));
      return new CredentialError("chatgpt", `provider "${provider.name}": every usable ChatGPT account is at its usage limit; the next one resets in ${formatDuration(soonest - now())}`);
    }
    return new CredentialError("chatgpt", `provider "${provider.name}": every ChatGPT account needs a new login; run \`modelplug login chatgpt\``);
  }

  function sweepAffinity(): void {
    if (affinity.size < 1024) return;
    const t = now();
    for (const [k, v] of affinity) if (v.lastUsed + AFFINITY_TTL_MS <= t) affinity.delete(k);
  }

  /** Pinned account, then the conversation's account, then the strategy. */
  function select(store: CredentialStore, conversationId: string | undefined): ChatgptAccount {
    const candidates = usable(store);
    if (candidates.length === 0) throw nothingUsable(store);
    const t = now();
    let chosen = store.chatgpt.active ? candidates.find(a => a.id === store.chatgpt.active) : undefined;
    if (!chosen && conversationId) {
      const bound = affinity.get(conversationId);
      if (bound && bound.lastUsed + AFFINITY_TTL_MS > t) chosen = candidates.find(a => a.id === bound.accountId);
    }
    if (!chosen) {
      switch (strategy) {
        case "fill-first":
          chosen = candidates[0]!;
          break;
        case "round-robin":
          chosen = candidates[roundRobin++ % candidates.length]!;
          break;
        default: {
          const scored = candidates.map((a, i) => ({ a, i, score: usageScore(quota.get(a.id), t) }));
          scored.sort((x, y) => x.score - y.score || x.i - y.i);
          chosen = scored[0]!.a;
        }
      }
    }
    if (conversationId) {
      sweepAffinity();
      affinity.set(conversationId, { accountId: chosen.id, lastUsed: t });
    }
    return chosen;
  }

  function markNeedsLogin(id: string): void {
    const store = loadCredentialStore(deps.storePath);
    const stored = store.chatgpt.accounts.find(a => a.id === id);
    if (stored && !stored.needsLogin) {
      stored.needsLogin = true;
      saveCredentialStore(deps.storePath, store);
    }
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
        if (response.status === 400 || response.status === 401) markNeedsLogin(account.id);
        throw new CredentialError("chatgpt", `token refresh failed (${response.status}) for ${label(account)}: ${text.slice(0, 200)}; run \`modelplug login chatgpt\` again`);
      }
      const body = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
      if (typeof body.access_token !== "string") throw new CredentialError("chatgpt", "token refresh returned no access_token");
      const store = loadCredentialStore(deps.storePath);
      const stored = store.chatgpt.accounts.find(a => a.id === account.id);
      const updated: ChatgptAccount = { ...(stored ?? account), accessToken: body.access_token, lastRefresh: new Date(now()).toISOString() };
      if (typeof body.refresh_token === "string") updated.refreshToken = body.refresh_token;
      if (typeof body.id_token === "string") updated.idToken = body.id_token;
      delete updated.needsLogin;
      upsertAccount(store, updated);
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
    cooldowns: () => cooldown,
    status(): string[] {
      let store: CredentialStore;
      try {
        store = loadCredentialStore(deps.storePath);
      } catch (err) {
        return [err instanceof Error ? err.message : String(err)];
      }
      if (store.chatgpt.accounts.length === 0) return ["no ChatGPT account (run: modelplug login chatgpt --import)"];
      const t = now();
      return store.chatgpt.accounts.map(account => {
        const snapshot = quota.get(account.id);
        const cooling = cooldown.get(account.id);
        const marks = [
          account.id === store.chatgpt.active ? "pinned" : "",
          account.needsLogin ? "NEEDS LOGIN" : "",
          cooling && cooling.until > t ? `cooling down, ${formatDuration(cooling.until - t)} left` : "",
        ].filter(Boolean);
        const who = `${label(account)}${account.planType ? ` (${account.planType})` : ""}${marks.length > 0 ? `  [${marks.join(", ")}]` : ""}`;
        return `${who}  ${describeWindow("primary", snapshot?.primary, t)}  ${describeWindow("secondary", snapshot?.secondary, t)}`;
      });
    },
    async resolve(_target: RouteTarget, _attempt: number, conversationId?: string): Promise<Credential> {
      let store = loadCredentialStore(deps.storePath);
      for (let tries = store.chatgpt.accounts.length; tries > 0; tries--) {
        let account = select(store, conversationId);
        const expiresAt = tokenExpiresAt(account.accessToken);
        const expiring = expiresAt !== undefined && expiresAt - now() < REFRESH_AHEAD_MS;
        if (forceRefresh.has(account.id) || expiring) {
          try {
            account = await refresh(account);
          } catch (err) {
            if (!(err instanceof CredentialError)) throw err;
            store = loadCredentialStore(deps.storePath);
            const dead = store.chatgpt.accounts.find(a => a.id === account.id)?.needsLogin === true;
            if (!dead || usable(store).length === 0) throw err;
            log(`chatgpt: ${err.message}; trying another account`);
            if (conversationId) affinity.delete(conversationId);
            continue;
          } finally {
            forceRefresh.delete(account.id);
          }
        }
        return { id: account.id, apiKey: account.accessToken, headers: { "chatgpt-account-id": account.accountId } };
      }
      throw nothingUsable(store);
    },
    async report(_target: RouteTarget, credential: Credential, report: AttemptReport): Promise<AttemptAdvice> {
      const t = now();
      let snapshot: QuotaSnapshot | undefined;
      if (report.headers) {
        snapshot = parseQuotaHeaders(report.headers, t);
        if (snapshot) quota.set(credential.id, snapshot);
      }
      if (report.outcome === "ok") {
        refreshedSinceSuccess.delete(credential.id);
        return { retry: false };
      }
      const error = report.error;
      if (error?.kind === "auth") {
        if (!refreshedSinceSuccess.has(credential.id)) {
          forceRefresh.add(credential.id);
          refreshedSinceSuccess.add(credential.id);
          return { retry: true };
        }
        // A second 401 after a fresh token: this account is out until someone logs it in again.
        markNeedsLogin(credential.id);
        refreshedSinceSuccess.delete(credential.id);
        if (report.conversationId) affinity.delete(report.conversationId);
        const others = usable(loadCredentialStore(deps.storePath)).length > 0;
        log(`chatgpt: account ${credential.id} still rejected after a token refresh; marked as needing login${others ? "; rotating" : ""}`);
        return { retry: others };
      }
      if (error?.kind === "quota") {
        const until = cooldownUntil(t, error, snapshot ?? quota.get(credential.id));
        cooldown.set(credential.id, { until, reason: error.message });
        if (report.conversationId) affinity.delete(report.conversationId);
        const others = usable(loadCredentialStore(deps.storePath)).length > 0;
        log(`chatgpt: account ${credential.id} hit its usage limit; cooling down for ${formatDuration(until - t)}${others ? "; rotating" : ""}`);
        return { retry: others, retryAfterMs: 0 };
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

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
