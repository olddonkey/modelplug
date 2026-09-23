/**
 * `modelplug login chatgpt`: the PKCE flow Codex itself runs, with Codex's
 * client id and its registered callback `http://localhost:1455/auth/callback`.
 * The port is fixed by that registration, so a busy port is an error, not a
 * retry on another port. Nothing here touches `~/.codex`.
 */
import { accountFromTokens, CHATGPT_TOKEN_URL, CODEX_CLIENT_ID } from "./chatgpt.ts";
import { CredentialError } from "./index.ts";
import { runCallbackLogin } from "./oauth.ts";
import type { ChatgptAccount } from "./store.ts";

export { pkcePair } from "./oauth.ts";

export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const LOGIN_CALLBACK_PORT = 1455;
export const LOGIN_CALLBACK_PATH = "/auth/callback";

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

/** Run the browser login and return the account. The caller stores it. */
export async function loginChatgpt(deps: LoginDeps = {}): Promise<ChatgptAccount> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const port = deps.port ?? LOGIN_CALLBACK_PORT;
  const log = deps.log ?? (() => {});
  const redirectUri = `http://localhost:${port}${LOGIN_CALLBACK_PATH}`;
  const { code, verifier } = await runCallbackLogin({
    kind: "chatgpt",
    port,
    path: LOGIN_CALLBACK_PATH,
    buildAuthorizeUrl: (state, challenge) => buildAuthorizeUrl(deps.authorizeUrl ?? CHATGPT_AUTHORIZE_URL, { challenge, state, redirectUri }),
    log,
    ...(deps.open ? { open: deps.open } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
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
}
