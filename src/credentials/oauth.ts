/** Shared PKCE browser callback flow for public OAuth clients. */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CredentialError } from "./index.ts";
import type { CredentialKind } from "./kinds.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function page(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
  const safe = message.replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
  res.end(`<!doctype html><meta charset="utf-8"><title>modelplug</title><body style="font-family:system-ui;margin:3em"><h1>modelplug</h1><p>${safe}</p></body>`);
}

function listenOrRefuse(server: Server, host: string, port: number, required: boolean, kind: CredentialKind): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (!required) return resolve(false);
      reject(err.code === "EADDRINUSE"
        ? new CredentialError(kind, `port ${port} is busy; the login callback is registered for http://localhost:${port} and cannot move. Is another login ${kind === "chatgpt" ? "(Codex's or modelplug's) " : ""}still running?`)
        : new CredentialError(kind, `cannot listen on ${host}:${port}: ${err.message}`));
    });
    server.listen(port, host, () => resolve(true));
  });
}

/** Best-effort system browser. */
export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    execFile(cmd, args, () => { /* user can visit the printed URL if this fails */ }).unref();
  } catch { /* same */ }
}

export interface CallbackLoginOptions {
  kind: CredentialKind;
  port: number;
  path: string;
  buildAuthorizeUrl: (state: string, challenge: string) => string;
  log?: (message: string) => void;
  open?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
}

export async function runCallbackLogin(options: CallbackLoginOptions): Promise<{ code: string; verifier: string }> {
  const { kind, port, path } = options;
  const redirectUri = `http://localhost:${port}${path}`;
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("hex");
  const url = options.buildAuthorizeUrl(state, challenge);
  let settle: (outcome: { code: string } | Error) => void = () => {};
  const received = new Promise<{ code: string }>((resolve, reject) => {
    settle = outcome => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
  });
  received.catch(() => {});
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const u = new URL(req.url ?? "/", redirectUri);
    if (u.pathname !== path) return page(res, 404, "Not the login callback.");
    if (u.searchParams.get("state") !== state) return page(res, 400, "This callback does not belong to the login in progress (state mismatch). Start again from the terminal.");
    const failure = u.searchParams.get("error");
    if (failure) {
      const description = u.searchParams.get("error_description") ?? "";
      page(res, 400, `Login failed: ${failure} ${description}`.trim());
      settle(new CredentialError(kind, `login failed: ${failure}${description ? ` (${description})` : ""}`));
      return;
    }
    const code = u.searchParams.get("code");
    if (!code) return page(res, 400, "The callback carried no authorization code.");
    page(res, 200, "Login complete. You can close this window and go back to the terminal.");
    settle({ code });
  };
  const servers = [createServer(handler), createServer(handler)];
  let timer: NodeJS.Timeout | undefined;
  try {
    await listenOrRefuse(servers[0]!, "127.0.0.1", port, true, kind);
    await listenOrRefuse(servers[1]!, "::1", port, false, kind).catch(() => false);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    timer = setTimeout(() => settle(new CredentialError(kind, `login timed out after ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs);
    timer.unref();
    options.log?.(`Open this URL in your browser to log in:\n\n  ${url}\n\nWaiting for the callback on ${redirectUri} …`);
    await (options.open ?? openBrowser)(url);
    const { code } = await received;
    return { code, verifier };
  } finally {
    if (timer) clearTimeout(timer);
    for (const server of servers) {
      if (!server.listening) continue;
      server.close();
      server.closeAllConnections();
    }
  }
}
