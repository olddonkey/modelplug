/**
 * OpenAI Responses wire. Today only `classifyError` is real: the responses
 * ingress reaches this wire through the same-protocol passthrough, which
 * relays bytes. `encode` and `decode` arrive with the IR path in milestone 7.
 */
import type { Capabilities, ErrorKind, ProviderTarget, Turn, Wire, WireError, WireRequest, Event } from "../ir.ts";

const NOT_YET = "openai-responses encode/decode arrive in milestone 7; this build relays Responses requests as-is";

export function retryAfterMsFrom(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  if (Number.isFinite(Number(raw))) return Math.max(0, Number(raw) * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Pull a human message out of the OpenAI `{error:{message}}`, the Codex backend `{detail}`, or raw text. */
export function upstreamErrorMessage(bodyText: string): { message: string; code?: string; type?: string } {
  const text = bodyText.trim();
  if (text.length === 0) return { message: "" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const error = obj.error;
      if (error && typeof error === "object") {
        const e = error as Record<string, unknown>;
        const out: { message: string; code?: string; type?: string } = { message: typeof e.message === "string" ? e.message : text.slice(0, 300) };
        if (typeof e.code === "string") out.code = e.code;
        if (typeof e.type === "string") out.type = e.type;
        return out;
      }
      if (typeof error === "string") return { message: error };
      const detail = obj.detail;
      if (typeof detail === "string") return { message: detail };
      if (detail && typeof detail === "object") {
        const d = detail as Record<string, unknown>;
        const out: { message: string; code?: string; type?: string } = { message: typeof d.message === "string" ? d.message : JSON.stringify(detail).slice(0, 300) };
        if (typeof d.code === "string") out.code = d.code;
        if (typeof d.type === "string") out.type = d.type;
        return out;
      }
      if (typeof obj.message === "string") return { message: obj.message };
    }
  } catch {
    /* not JSON */
  }
  return { message: text.slice(0, 300) };
}

export function classifyResponsesError(status: number, headers: Headers, bodyText: string, provider: string, now: number = Date.now()): WireError {
  const { message, code, type } = upstreamErrorMessage(bodyText);
  const lower = `${message} ${code ?? ""} ${type ?? ""}`.toLowerCase();
  const retryAfterMs = retryAfterMsFrom(headers, now);
  const base = (kind: ErrorKind, retryable: boolean): WireError => {
    const err: WireError = { kind, message: message || `HTTP ${status}`, provider, status, retryable };
    if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
    return err;
  };
  if (status === 401 || status === 403) return base("auth", false);
  if (status === 402) return base("quota", false);
  if (status === 429) {
    if (/usage[_ ]limit|quota|insufficient|billing|exceeded your current/.test(lower)) return base("quota", false);
    return base("rate_limit", true);
  }
  if (status === 404) return base("not_found", false);
  if (status === 400 || status === 413 || status === 422) {
    if (/context|too long|maximum.*tokens|token limit|exceeds the (context|model)/.test(lower)) return base("context_length", false);
    if (/model.*(not supported|not found|does not exist|unknown)|unknown model|unsupported model/.test(lower)) return base("not_found", false);
    if (/content_filter|content policy|safety/.test(lower)) return base("content_filter", false);
    return base("invalid_request", false);
  }
  if (status === 503 || status === 529 || /overloaded|capacity/.test(lower)) return base("overloaded", true);
  if (status === 408 || status >= 500) return base("upstream", true);
  return base("upstream", false);
}

export const openaiResponsesWire: Wire = {
  name: "openai-responses",
  encode(_turn: Turn, _caps: Capabilities, _target: ProviderTarget, _stream: boolean): WireRequest {
    throw new Error(NOT_YET);
  },
  // eslint-disable-next-line require-yield
  async *decode(_response: Response, _caps: Capabilities, _target: ProviderTarget): AsyncIterable<Event> {
    throw new Error(NOT_YET);
  },
  classifyError(status: number, headers: Headers, bodyText: string, target: ProviderTarget): WireError {
    return classifyResponsesError(status, headers, bodyText, target.name);
  },
};
