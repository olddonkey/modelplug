/** `GET /models` as both OpenAI-shaped wires speak it; used by `check` and to fill `/v1/models`. */
import type { ProviderTarget } from "../ir.ts";

export function openaiModelsRequest(target: ProviderTarget): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { accept: "application/json", ...(target.headers ?? {}) };
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
  return { url: `${target.baseUrl}/models`, headers };
}

/** `{ data: [{ id }] }`, or a bare array of `{ id }` / strings from looser gateways. Sorted, deduplicated. */
export function parseOpenaiModels(body: unknown): string[] {
  const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data) ? ((body as { data: unknown[] }).data) : [];
  const ids = new Set<string>();
  for (const entry of list) {
    if (typeof entry === "string" && entry) ids.add(entry);
    else if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") ids.add((entry as { id: string }).id);
  }
  return [...ids].sort();
}
