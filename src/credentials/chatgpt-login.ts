/**
 * `modelplug login chatgpt`: the PKCE flow Codex itself runs, with Codex's
 * client id and its registered callback `http://localhost:1455/auth/callback`.
 * The port is fixed by that registration, so a busy port is an error, not a
 * retry on another port. Nothing here touches `~/.codex`.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { accountFromTokens, CHATGPT_TOKEN_URL, CODEX_CLIENT_ID } from "./chatgpt.ts";
import { CredentialError } from "./index.ts";
import type { ChatgptAccount } from "./store.ts";

export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const LOGIN_CALLBACK_PORT = 1455;
export const LOGIN_CALLBACK_PATH = "/auth/callback";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface LoginDeps {
  fetch?: typeof fetch;
  now?: () => number;
  port?: number;
  authorizeUrl?: string;
  tokenUrl?: string;
  /** Receives the URL the user must visit. The default opens the system browser, best effort. */
  open?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(base: string, params: { challenge: string; state: string; redirectUri: string }): string {
  const url = new URL(base);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: params.redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: params.state,
    originator: "codex_cli_rs",
  }).toString();
  return url.toString();
}

function page(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>modelplug</title><body style="font-family:system-ui;margin:3em"><h1>modelplug</h1><p>${text}</p></body>`);
}

function listenOrRefuse(server: Server, host: string, port: number, required: boolean): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (!required) return resolve(false);
      reject(
        err.code === "EADDRINUSE"
          ? new CredentialError("chatgpt", `port ${port} is busy; the login callback is registered for http://localhost:${port} and cannot move. Is another login (Codex's or modelplug's) still running?`)
          : new CredentialError("chatgpt", `cannot listen on ${host}:${port}: ${err.message}`),
      );
    });
    server.listen(port, host, () => resolve(true));
  });
}

/** Best-effort system browser; the URL was built by us from a fixed base and percent-encoded parameters. */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    execFile(cmd, args, () => {
      /* a failure here only means the user has to click the printed URL */
    }).unref();
  } catch {
    /* same */
  }
}

/** Run the browser login and return the account. The caller stores it. */
export async function loginChatgpt(deps: LoginDeps = {}): Promise<ChatgptAccount> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const port = deps.port ?? LOGIN_CALLBACK_PORT;
  const log = deps.log ?? (() => {});
  const redirectUri = `http://localhost:${port}${LOGIN_CALLBACK_PATH}`;
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("hex");
  const url = buildAuthorizeUrl(deps.authorizeUrl ?? CHATGPT_AUTHORIZE_URL, { challenge, state, redirectUri });

  let settle: (outcome: { code: string } | Error) => void = () => {};
  const received = new Promise<{ code: string }>((resolve, reject) => {
    settle = outcome => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
  });
  // The callback may settle while the browser is still being opened; the rejection is consumed below, not unhandled.
  received.catch(() => {});
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const u = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (u.pathname !== LOGIN_CALLBACK_PATH) {
      page(res, 404, "Not the login callback.");
      return;
    }
    const failure = u.searchParams.get("error");
    if (failure) {
      const description = u.searchParams.get("error_description") ?? "";
      page(res, 400, `Login failed: ${failure} ${description}`.trim());
      settle(new CredentialError("chatgpt", `login failed: ${failure}${description ? ` (${description})` : ""}`));
      return;
    }
    if (u.searchParams.get("state") !== state) {
      page(res, 400, "This callback does not belong to the login in progress (state mismatch). Start again from the terminal.");
      return;
    }
    const code = u.searchParams.get("code");
    if (!code) {
      page(res, 400, "The callback carried no authorization code.");
      return;
    }
    page(res, 200, "Login complete. You can close this window and go back to the terminal.");
    settle({ code });
  };
  // Browsers resolve "localhost" to either address family; answer on both when we can.
  const servers = [createServer(handler), createServer(handler)];
  await listenOrRefuse(servers[0]!, "127.0.0.1", port, true);
  await listenOrRefuse(servers[1]!, "::1", port, false).catch(() => false);
  const timer = setTimeout(() => settle(new CredentialError("chatgpt", `login timed out after ${Math.round((deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} minutes`)), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref();
  try {
    log(`Open this URL in your browser to log in:\n\n  ${url}\n\nWaiting for the callback on ${redirectUri} …`);
    await (deps.open ?? openBrowser)(url);
    const { code } = await received;
    let response: Response;
    try {
      response = await doFetch(deps.tokenUrl ?? CHATGPT_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: CODEX_CLIENT_ID, code_verifier: verifier }).toString(),
      });
    } catch (err) {
      throw new CredentialError("chatgpt", `token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new CredentialError("chatgpt", `token exchange failed (${response.status}): ${text.slice(0, 200)}`);
    let body: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new CredentialError("chatgpt", "token exchange returned something other than JSON");
    }
    if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") throw new CredentialError("chatgpt", "token exchange returned no access_token and refresh_token");
    return accountFromTokens({ accessToken: body.access_token, refreshToken: body.refresh_token, ...(typeof body.id_token === "string" ? { idToken: body.id_token } : {}) }, "login", now);
  } finally {
    clearTimeout(timer);
    for (const server of servers) server.close();
    for (const server of servers) server.closeAllConnections();
  }
}
