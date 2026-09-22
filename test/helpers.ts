import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export function fakeJwt(claims: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

export const AUTH_CLAIM = "https://api.openai.com/auth";

export function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

export function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

export async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

export type FakeHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>;

export interface SseEvent {
  type: string;
  data: Record<string, any>;
}

/** Split a text/event-stream body into `{type, data}` frames (event name from `event:`, else `data.type`). */
export function parseSseText(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .filter(frame => frame.includes("data:"))
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(l => l.startsWith("event:"))?.slice(6).trim();
      const data = JSON.parse(lines.filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n")) as Record<string, any>;
      return { type: event ?? String(data.type ?? ""), data };
    });
}

/**
 * Write `text` to the response in several TCP-sized pieces with a pause between
 * them, cutting one byte into the first occurrence of `splitInside` (a multibyte
 * character) and once more in the middle, so the reader sees UTF-8 sequences and
 * SSE frames split across chunks.
 */
export function writeInPieces(res: ServerResponse, text: string, splitInside?: string): void {
  const bytes = Buffer.from(text, "utf8");
  const cuts = new Set<number>([Math.floor(bytes.length / 2)]);
  if (splitInside) {
    const at = bytes.indexOf(Buffer.from(splitInside, "utf8"));
    if (at >= 0) cuts.add(at + 1);
  }
  const points = [...cuts].filter(p => p > 0 && p < bytes.length).sort((a, b) => a - b);
  const pieces: Buffer[] = [];
  let start = 0;
  for (const p of points) {
    pieces.push(bytes.subarray(start, p));
    start = p;
  }
  pieces.push(bytes.subarray(start));
  pieces.forEach((piece, i) => {
    setTimeout(() => {
      res.write(piece);
      if (i === pieces.length - 1) res.end();
    }, i * 5);
  });
}

/** A scripted upstream: each request pops the next handler; the last one repeats. */
export async function fakeUpstream(handlers: FakeHandler[]): Promise<{ port: number; server: Server; calls: number }> {
  const state = { port: 0, server: undefined as unknown as Server, calls: 0 };
  const server = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    const handler = handlers[Math.min(state.calls, handlers.length - 1)]!;
    state.calls += 1;
    await handler(req, res, body);
  });
  state.server = server;
  state.port = await listen(server);
  return state;
}
