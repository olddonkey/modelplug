/**
 * The credentials layer: the only part of modelplug that holds secrets or
 * per-account state. The kernel calls `resolve` once per attempt and `report`
 * once per outcome; nothing else in the kernel or the wires sees a token.
 *
 * A pool implements rotation by returning a different credential on a later
 * attempt of the same target, and asks for that attempt by answering
 * `{ retry: true }` from `report`. The retry loop does not know pools exist.
 */
import type { ResolvedProvider } from "../config.ts";
import type { WireError } from "../ir.ts";
import type { RouteTarget } from "../route.ts";
import { apiKeyCredentials } from "./api-key.ts";
import { chatgptCredentials } from "./chatgpt.ts";
import { grokCredentials } from "./grok.ts";
import { kimiCredentials } from "./kimi.ts";
import type { CredentialKind } from "./kinds.ts";
import { defaultCredentialStorePath } from "./store.ts";

export { CREDENTIAL_KINDS, type CredentialKind } from "./kinds.ts";

export interface Credential {
  /** Stable, non-secret id for logs and affinity: "key" for API keys, an account id for pools. */
  id: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Some credential kinds move the request elsewhere, e.g. the ChatGPT backend. */
  baseUrl?: string;
}

export interface AttemptReport {
  outcome: "ok" | "error";
  error?: WireError;
  /** Upstream response headers when a response arrived. Quota accounting reads them. */
  headers?: Headers;
  conversationId?: string;
}

/** What the credential layer wants the attempt loop to do next. */
export interface AttemptAdvice {
  /** Try the same target again; `resolve` will hand out a refreshed or different credential. */
  retry: boolean;
  retryAfterMs?: number;
}

export interface CredentialProvider {
  readonly kind: CredentialKind;
  /** Throws `CredentialError` when nothing usable exists (no account, refresh failed). */
  resolve(target: RouteTarget, attempt: number, conversationId?: string): Promise<Credential>;
  report(target: RouteTarget, credential: Credential, report: AttemptReport): Promise<AttemptAdvice | void>;
  /** Human-readable account and quota lines for the `/` status page. Kinds with nothing to show omit it. */
  status?(): string[];
}

export class CredentialError extends Error {
  readonly kind: CredentialKind;
  constructor(kind: CredentialKind, message: string) {
    super(message);
    this.name = "CredentialError";
    this.kind = kind;
  }
}

export interface CredentialDeps {
  storePath?: string;
  fetch?: typeof fetch;
  now?: () => number;
  tokenUrl?: string;
  oauthHost?: string;
  deviceId?: string;
  discoveryUrl?: string;
  requestTimeoutMs?: number;
  log?: (message: string) => void;
}

export function credentialProviderFor(provider: ResolvedProvider, deps: CredentialDeps = {}): CredentialProvider {
  switch (provider.credential) {
    case "api-key":
      return apiKeyCredentials(provider);
    case "chatgpt": {
      const chatgptDeps = { storePath: deps.storePath ?? defaultCredentialStorePath(), ...stripUndefined(deps) };
      return chatgptCredentials(provider, chatgptDeps);
    }
    case "kimi": {
      const kimiDeps = { storePath: deps.storePath ?? defaultCredentialStorePath(), ...stripUndefined(deps) };
      return kimiCredentials(provider, kimiDeps);
    }
    case "grok":
      return grokCredentials(provider, { storePath: deps.storePath ?? defaultCredentialStorePath(), ...stripUndefined(deps) });
  }
}

function stripUndefined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
