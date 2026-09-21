/** Header and body relay helpers shared by the passthrough and the `--forward` recorder. */
import type { IncomingHttpHeaders, ServerResponse } from "node:http";

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "authorization",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "proxy-authorization",
  "te",
  "upgrade",
  "expect",
]);

const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"]);

/** Client headers worth forwarding upstream: everything but hop-by-hop, framing, and the client's own auth. */
export function forwardableHeaders(incoming: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export function relayableHeaders(upstream: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of upstream) if (!DROPPED_RESPONSE_HEADERS.has(name)) out[name] = value;
  return out;
}

/**
 * Pipe an upstream body to the client as it arrives. `onChunk` observes bytes
 * without buffering them. Resolves when the upstream ends or the client goes
 * away; the caller ends the response, so bookkeeping can run before the client
 * sees the end of the stream.
 */
export async function relayBody(upstream: Response, res: ServerResponse, onChunk?: (chunk: Uint8Array) => void): Promise<void> {
  if (!upstream.body) return;
  try {
    for await (const chunk of upstream.body) {
      onChunk?.(chunk);
      if (res.destroyed) return;
      if (!res.write(chunk)) await new Promise<void>(resolve => res.once("drain", resolve));
    }
  } catch {
    /* client went away or upstream cut the stream; the client sees a truncated body either way */
  }
}
