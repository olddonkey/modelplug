/**
 * Network probes for `check` and for filling `/v1/models`: one `GET /models`
 * per provider through its wire and credential, with a short timeout. Never on
 * the request path, never blocking `start`.
 */
import type { ResolvedConfig, ResolvedProvider } from "./config.ts";
import { CredentialError, credentialProviderFor, type CredentialDeps, type CredentialProvider } from "./credentials/index.ts";
import type { ProviderTarget } from "./ir.ts";
import { WIRES } from "./wire/index.ts";

export type ProbeState = "reachable" | "auth_failed" | "unreachable" | "no_credential" | "unsupported";

export interface ProbeResult {
  provider: string;
  state: ProbeState;
  /** One human-readable clause, e.g. "14 models" or "HTTP 401: invalid api key". */
  detail: string;
  models: string[];
  durationMs: number;
}

export interface ProbeDeps extends CredentialDeps {
  timeoutMs?: number;
  /** Reuse the pipeline's credential providers so quota headers land on the status page. */
  credentialProvider?: (provider: ResolvedProvider) => CredentialProvider;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export async function probeProvider(provider: ResolvedProvider, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const started = now();
  const result = (state: ProbeState, detail: string, models: string[] = []): ProbeResult => ({ provider: provider.name, state, detail, models, durationMs: now() - started });

  const wire = WIRES[provider.wire];
  if (!wire) return result("unsupported", `wire "${provider.wire}" is not served in this build`);
  if (!wire.modelsRequest || !wire.parseModels) return result("unsupported", `wire "${provider.wire}" has no model list`);

  const creds = deps.credentialProvider ? deps.credentialProvider(provider) : credentialProviderFor(provider, deps);
  const routeTarget = { provider: provider.name, model: "" };
  let credential;
  try {
    credential = await creds.resolve(routeTarget, 1);
  } catch (err) {
    if (err instanceof CredentialError) return result("no_credential", err.message);
    throw err;
  }
  const target: ProviderTarget = { name: provider.name, baseUrl: credential.baseUrl ?? provider.baseUrl, headers: { ...provider.headers, ...(credential.headers ?? {}) } };
  if (credential.apiKey !== undefined) target.apiKey = credential.apiKey;
  const request = wire.modelsRequest(target);

  let response: Response;
  try {
    response = await doFetch(request.url, { method: "GET", headers: request.headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const message = err instanceof Error && err.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)}s` : networkErrorMessage(err);
    return result("unreachable", `${request.url}: ${message}`);
  }
  const text = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    return result("auth_failed", `HTTP ${response.status}: ${wire.classifyError(response.status, response.headers, text, target).message}`);
  }
  if (response.status >= 500) return result("unreachable", `HTTP ${response.status}: ${wire.classifyError(response.status, response.headers, text, target).message}`);
  if (response.status === 404) return result("reachable", "no model list at /models");
  if (!response.ok) return result("reachable", `HTTP ${response.status}: ${wire.classifyError(response.status, response.headers, text, target).message}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return result("reachable", "model list is not JSON");
  }
  const models = wire.parseModels(body);
  await creds.report(routeTarget, credential, { outcome: "ok", headers: response.headers });
  return result("reachable", models.length === 0 ? "empty model list" : `${models.length} model${models.length === 1 ? "" : "s"}`, models);
}

/** `fetch failed` hides the useful part in `cause`, which for a localhost refusal is an AggregateError with an empty message and a `code`. */
function networkErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error) {
    const inner = cause instanceof AggregateError ? cause.errors.find((e): e is Error => e instanceof Error) : undefined;
    const code = [cause, inner].map(e => (e as { code?: unknown } | undefined)?.code).find(c => typeof c === "string") as string | undefined;
    const text = cause.message || inner?.message || "";
    const combined = code && !text.includes(code) ? `${code}${text ? `: ${text}` : ""}` : text;
    if (combined) return combined;
  }
  return err.message;
}

/** Probe every provider in parallel. A provider that throws is reported, never thrown. */
export async function probeProviders(config: ResolvedConfig, deps: ProbeDeps = {}): Promise<ProbeResult[]> {
  return Promise.all(
    Object.values(config.providers).map(provider =>
      probeProvider(provider, deps).catch((err: unknown): ProbeResult => ({
        provider: provider.name,
        state: "unreachable",
        detail: err instanceof Error ? err.message : String(err),
        models: [],
        durationMs: 0,
      })),
    ),
  );
}

export function describeProbe(result: ProbeResult): string {
  const label: Record<ProbeState, string> = {
    reachable: "reachable",
    auth_failed: "auth failed",
    unreachable: "unreachable",
    no_credential: "no credential",
    unsupported: "not probed",
  };
  return `${label[result.state]}, ${result.detail} (${result.durationMs}ms)`;
}

/** `/v1/models` fills from these for providers that list no models in config. */
export function discoveredModels(results: ProbeResult[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of results) if (r.models.length > 0) out[r.provider] = r.models;
  return out;
}
