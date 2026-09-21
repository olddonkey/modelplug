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
