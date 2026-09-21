/**
 * Development helpers behind `modelplug start --record / --forward`.
 * `--record` saves what clients send and what they get back, as fixtures.
 * `--forward` relays requests byte for byte to a real upstream so a client
 * can hold a multi-turn conversation before any wire exists. Neither is part
 * of the product path; the milestone 3 passthrough replaces `--forward`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { forwardableHeaders, relayBody, relayableHeaders } from "./relay.ts";
import { error, sendJson, type BodyHandler } from "./server.ts";

export interface Recorder {
  readonly dir: string;
  begin(route: string, body: unknown, requestHeaders: Record<string, unknown>): string;
}

export function createRecorder(dir: string): Recorder {
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  return {
    dir,
    begin(route, body, requestHeaders) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const stem = join(dir, `${stamp}-${String(++seq).padStart(3, "0")}-${route}`);
      writeFileSync(`${stem}.request.json`, JSON.stringify(body, null, 2));
      writeFileSync(`${stem}.meta.json`, JSON.stringify({ request: { headers: requestHeaders } }, null, 2));
      return stem;
    },
  };
}

/** Save the request body and tee everything written to the client into `<stem>.response.sse`. */
export function withRecording(recorder: Recorder, route: string, handler: BodyHandler): BodyHandler {
  return async (body, req, res) => {
    const stem = recorder.begin(route, body, req.headers);
    const ssePath = `${stem}.response.sse`;
    writeFileSync(ssePath, "");
    const tee = (chunk: unknown): void => {
      if (typeof chunk === "string") appendFileSync(ssePath, chunk);
      else if (chunk instanceof Uint8Array) appendFileSync(ssePath, chunk);
    };
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = function (this: ServerResponse, chunk: any, encodingOrCb?: any, cb?: any) {
      tee(chunk);
      return write(chunk, encodingOrCb, cb);
    } as typeof res.write;
    res.end = function (this: ServerResponse, chunk?: any, encodingOrCb?: any, cb?: any) {
      if (typeof chunk !== "function") tee(chunk);
      return end(chunk, encodingOrCb, cb);
    } as typeof res.end;
    let headHeaders: Record<string, unknown> = {};
    const writeHead = res.writeHead.bind(res);
    res.writeHead = function (this: ServerResponse, status: number, a?: any, b?: any) {
      const given = (typeof a === "object" && a !== null && !Array.isArray(a) ? a : b) as Record<string, unknown> | undefined;
      if (given) headHeaders = { ...given };
      return writeHead(status, a, b);
    } as typeof res.writeHead;
    const writeMeta = (): void => {
      writeFileSync(
        `${stem}.meta.json`,
        JSON.stringify(
          { request: { headers: req.headers }, response: { status: res.statusCode, headers: { ...res.getHeaders(), ...headHeaders } } },
          null,
          2,
        ),
      );
    };
    res.once("finish", writeMeta);
    try {
      await handler(body, req, res);
    } finally {
      if (res.headersSent) writeMeta();
    }
  };
}

export interface ForwardOptions {
  /** The directory that contains `responses` / `messages`, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Recording aid: rename `model` in the outgoing body so the client's dialect can be captured against an upstream that only knows its own models. */
  model?: string;
}

/** Raw relay: client headers minus hop-by-hop, our auth, the body re-serialized, the stream piped back. */
export function forwardHandler(options: ForwardOptions): BodyHandler {
  const base = options.baseUrl.replace(/\/+$/, "");
  return async (body, req, res) => {
    const incoming = new URL(req.url ?? "/", "http://local").pathname;
    const url = base + incoming.replace(/^\/v1(?=\/)/, "");
    const headers: Record<string, string> = forwardableHeaders(req.headers);
    headers["content-type"] = "application/json";
    if (options.apiKey) {
      headers.authorization = `Bearer ${options.apiKey}`;
      if (incoming.endsWith("/messages")) {
        headers["x-api-key"] = options.apiKey;
        headers["anthropic-version"] ??= "2023-06-01";
      }
    }
    Object.assign(headers, options.headers ?? {});

    const payload = options.model && body && typeof body === "object" && "model" in body ? { ...body, model: options.model } : body;
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    let upstream: Response;
    try {
      upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 502, error("upstream_unreachable", `${url}: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    res.writeHead(upstream.status, relayableHeaders(upstream.headers));
    await relayBody(upstream, res);
    res.end();
  };
}
