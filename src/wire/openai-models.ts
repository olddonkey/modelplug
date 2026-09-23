/** `GET /models` as both OpenAI-shaped wires speak it; used by `check` and to fill `/v1/models`. */
import type { ProviderTarget } from "../ir.ts";

/**
 * The Codex backend (chatgpt.com/backend-api/codex) refuses `/models` without
 * a `client_version` and gates the list by it: an old version sees nothing.
 * api.openai.com ignores the parameter. Bump it together with the recorded
 * fixtures after a Codex upgrade; it is only ever sent on the probe path.
 */
export const CODEX_MODELS_CLIENT_VERSION = "0.155.1";

export function openaiModelsRequest(target: ProviderTarget): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { accept: "application/json", ...(target.headers ?? {}) };
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
  return { url: `${target.baseUrl}/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`, headers };
}

/**
 * `{ data: [{ id }] }` from OpenAI-compatible servers; `{ models: [{ slug }] }`
 * from the Codex backend; a bare array of `{ id }` or strings from looser
 * gateways. Sorted, deduplicated.
 */
export function parseOpenaiModels(body: unknown): string[] {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as { data?: unknown; models?: unknown }) : undefined;
  const list = Array.isArray(body) ? body : Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : [];
  const ids = new Set<string>();
  for (const entry of list) {
    if (typeof entry === "string" && entry) ids.add(entry);
    else if (entry && typeof entry === "object") {
      const e = entry as { id?: unknown; slug?: unknown };
      const id = typeof e.id === "string" ? e.id : typeof e.slug === "string" ? e.slug : undefined;
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}
