import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { buildAuthorizeUrl, LOGIN_CALLBACK_PATH, loginChatgpt, pkcePair } from "../src/credentials/chatgpt-login.ts";
import { CODEX_CLIENT_ID } from "../src/credentials/chatgpt.ts";
import { CredentialError } from "../src/credentials/index.ts";
import { AUTH_CLAIM, close, fakeJwt, fakeUpstream, listen } from "./helpers.ts";

const FAR = Math.floor(Date.now() / 1000) + 86_400;

test("pkce: the challenge is the S256 hash of the verifier; the authorize URL carries Codex's client id and the callback", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  const url = new URL(buildAuthorizeUrl("https://auth.example/oauth/authorize", { challenge, state: "s1", redirectUri: "http://localhost:1455/auth/callback" }));
  assert.equal(url.searchParams.get("client_id"), CODEX_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "s1");
  assert.match(url.searchParams.get("scope")!, /offline_access/);
});

/** Stand in for the browser: read state from the authorize URL and hit the callback like the provider would. */
function browser(port: number, code: string, options: { wrongStateFirst?: boolean } = {}) {
  return async (url: string): Promise<void> => {
    const state = new URL(url).searchParams.get("state")!;
    if (options.wrongStateFirst) {
      const stray = await fetch(`http://127.0.0.1:${port}${LOGIN_CALLBACK_PATH}?code=stray&state=nope`);
      assert.equal(stray.status, 400);
      await stray.text();
    }
    const res = await fetch(`http://127.0.0.1:${port}${LOGIN_CALLBACK_PATH}?code=${code}&state=${state}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Login complete/);
  };
}

test("login: the callback code is exchanged with the PKCE verifier and becomes an account", async () => {
  const seen: Record<string, string | null> = {};
  let challengeSeen = "";
  const token = await fakeUpstream([
    (req, res, body) => {
      const params = new URLSearchParams(body);
      seen.grant = params.get("grant_type");
      seen.code = params.get("code");
      seen.redirect = params.get("redirect_uri");
      seen.client = params.get("client_id");
      seen.verifier = params.get("code_verifier");
      seen.contentType = req.headers["content-type"] ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: fakeJwt({ exp: FAR, [AUTH_CLAIM]: { chatgpt_account_id: "acc-login", chatgpt_plan_type: "plus" } }),
          refresh_token: "refresh-login",
          id_token: fakeJwt({ email: "login@example.com", [AUTH_CLAIM]: { chatgpt_account_id: "acc-login", chatgpt_plan_type: "plus" } }),
        }),
      );
    },
  ]);
  const port = 14555;
  const lines: string[] = [];
  try {
    const account = await loginChatgpt({
      port,
      tokenUrl: `http://127.0.0.1:${token.port}/oauth/token`,
      authorizeUrl: "https://auth.example/oauth/authorize",
      now: () => 5_000,
      log: m => {
        lines.push(m);
        challengeSeen = new URL(m.match(/https:\S+/)![0]).searchParams.get("code_challenge")!;
      },
      open: browser(port, "the-code", { wrongStateFirst: true }),
    });
    assert.equal(account.id, "acc-login");
    assert.equal(account.email, "login@example.com");
    assert.equal(account.planType, "plus");
    assert.equal(account.refreshToken, "refresh-login");
    assert.equal(account.source, "login");
    assert.equal(account.lastRefresh, new Date(5_000).toISOString());
    assert.equal(seen.grant, "authorization_code");
    assert.equal(seen.code, "the-code");
    assert.equal(seen.redirect, `http://localhost:${port}${LOGIN_CALLBACK_PATH}`);
    assert.equal(seen.client, CODEX_CLIENT_ID);
    assert.equal(seen.contentType, "application/x-www-form-urlencoded");
    assert.equal(createHash("sha256").update(seen.verifier!).digest("base64url"), challengeSeen, "the verifier matches the challenge the browser saw");
    assert.equal(token.calls, 1);
    assert.match(lines[0]!, /Open this URL/);
  } finally {
    await close(token.server);
  }
  // The callback server is gone once the login settles.
  await assert.rejects(fetch(`http://127.0.0.1:${port}${LOGIN_CALLBACK_PATH}`));
});

test("login: a provider error on the callback fails the login; a busy port is refused; the exchange failing is reported", async () => {
  const port = 14556;
  await assert.rejects(
    loginChatgpt({ port, authorizeUrl: "https://auth.example/a", tokenUrl: "http://127.0.0.1:1/t", open: async url => {
      const missing = await fetch(`http://127.0.0.1:${port}${LOGIN_CALLBACK_PATH}?error=access_denied&error_description=nope`);
      assert.equal(missing.status, 400);
      assert.match(await missing.text(), /state mismatch/);
      const state = new URL(url).searchParams.get("state")!;
      const failed = await fetch(`http://127.0.0.1:${port}${LOGIN_CALLBACK_PATH}?error=access_denied&error_description=nope&state=${encodeURIComponent(state)}`);
      assert.equal(failed.status, 400);
      await failed.text();
    } }),
    (err: unknown) => err instanceof CredentialError && /login failed: access_denied \(nope\)/.test(err.message),
  );

  const squatter = createServer(() => {});
  await new Promise<void>(resolve => squatter.listen(port, "127.0.0.1", () => resolve()));
  try {
    await assert.rejects(loginChatgpt({ port, open: () => assert.fail("must not open the browser when the port is busy") }), /port 14556 is busy/);
  } finally {
    await close(squatter);
  }

  const token = await fakeUpstream([
    (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
    },
  ]);
  try {
    await assert.rejects(loginChatgpt({ port, authorizeUrl: "https://auth.example/a", tokenUrl: `http://127.0.0.1:${token.port}/t`, open: browser(port, "c") }), /token exchange failed \(400\)/);
  } finally {
    await close(token.server);
  }
});

test("login: times out when nobody comes back", async () => {
  const port = 14557;
  await assert.rejects(loginChatgpt({ port, authorizeUrl: "https://auth.example/a", timeoutMs: 50, open: () => {} }), /login timed out/);
  const probe = createServer(() => {});
  await listen(probe);
  await close(probe);
});
