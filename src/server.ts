import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ResolvedConfig } from "./config.ts";

export type BodyHandler = (body: unknown, req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Ingress modules plug in here. A missing handler answers 501. */
export interface Handlers {
  responses?: BodyHandler;
  compact?: BodyHandler;
  messages?: BodyHandler;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ServerOptions {
  /** Extra lines for the `/` status page, e.g. accounts and quota. */
  statusLines?: () => string[];
}

export function createServer(config: ResolvedConfig, handlers: Handlers, version: string, options: ServerOptions = {}): Server {
  return createHttpServer((req, res) => {
    handle(config, handlers, version, options, req, res).catch(err => {
      if (!res.headersSent) {
        sendJson(res, 500, error("internal_error", err instanceof Error ? err.message : String(err)));
      } else {
        res.end();
      }
    });
  });
}

async function handle(
  config: ResolvedConfig,
  handlers: Handlers,
  version: string,
  options: ServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (path === "/healthz" && method === "GET") {
    return sendJson(res, 200, { ok: true, version, providers: Object.keys(config.providers).length });
  }
  if (path === "/" && method === "GET") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(statusText(config, version, options.statusLines?.() ?? []));
    return;
  }
  if (path === "/v1/models" && method === "GET") {
    return sendJson(res, 200, modelList(config));
  }

  const route = ROUTES[path];
  if (route) {
    if (method !== "POST") {
      res.setHeader("allow", "POST");
      return sendJson(res, 405, error("method_not_allowed", `${path} accepts POST`));
    }
    const handler = handlers[route] ?? notImplementedHandler(path);
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err instanceof BodyError ? err.status : 400, error("invalid_request_error", err instanceof Error ? err.message : "bad body"));
    }
    return handler(body, req, res);
  }

  if (path.startsWith("/v1/")) {
    return sendJson(res, 404, error("not_found", `no route for ${method} ${path}`));
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
}

export function notImplementedHandler(path: string): BodyHandler {
  return async (_body, _req, res) => {
    sendJson(res, 501, error("not_implemented", `${path} is not implemented yet in this build`));
  };
}

export const ROUTE_PATHS: Record<keyof Handlers, string> = {
  responses: "/v1/responses",
  compact: "/v1/responses/compact",
  messages: "/v1/messages",
};

const ROUTES: Record<string, keyof Handlers> = {
  "/v1/responses": "responses",
  "/v1/responses/compact": "compact",
  "/v1/messages": "messages",
};

class BodyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new BodyError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw new BodyError(400, "empty request body");
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError(400, "request body is not valid JSON");
  }
}

export function modelList(config: ResolvedConfig): { object: "list"; data: Array<{ id: string; object: "model"; owned_by: string }> } {
  const data: Array<{ id: string; object: "model"; owned_by: string }> = [];
  for (const provider of Object.values(config.providers)) {
    for (const model of provider.models) data.push({ id: `${provider.name}/${model}`, object: "model", owned_by: provider.name });
  }
  for (const alias of Object.keys(config.aliases)) data.push({ id: alias, object: "model", owned_by: "alias" });
  return { object: "list", data };
}

function statusText(config: ResolvedConfig, version: string, extra: string[]): string {
  const lines = [`modelplug ${version}`, `config: ${config.source}`, ""];
  for (const p of Object.values(config.providers)) {
    const auth = p.credential === "chatgpt" ? "   (chatgpt login)" : p.apiKey ? "" : "   (no key)";
    lines.push(`${p.name.padEnd(14)} ${p.wire.padEnd(17)} ${p.baseUrl}${auth}`);
  }
  if (Object.keys(config.aliases).length > 0) {
    lines.push("");
    for (const [alias, targets] of Object.entries(config.aliases)) lines.push(`${alias.padEnd(14)} -> ${targets.join(", ")}`);
  }
  if (extra.length > 0) lines.push("", ...extra);
  return lines.join("\n") + "\n";
}

export function error(code: string, message: string): { error: { message: string; type: string; code: string } } {
  return { error: { message, type: code, code } };
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
