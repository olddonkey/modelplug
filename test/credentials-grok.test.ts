import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { GROK_CALLBACK_PATH, GROK_CLIENT_ID, grokCredentials, loginGrok } from "../src/credentials/grok.ts";
import { CredentialError, credentialProviderFor } from "../src/credentials/index.ts";
import { runCallbackLogin } from "../src/credentials/oauth.ts";
import { loadCredentialStore, saveCredentialStore, type GrokAccount } from "../src/credentials/store.ts";
import { main } from "../src/main.ts";
import { fakeJwt } from "./helpers.ts";

const NOW = 1_800_000_000_000;
const provider = parseConfig({ providers: { grok: { preset: "grok" } } }, "test").providers.grok!;
const target = { provider: "grok", model: "grok-4" };
const discoveryUrl = "https://fake.invalid/discovery";
const authorization = "https://auth.x.ai/oauth/authorize?prompt=login";
const token = "https://accounts.x.ai/oauth/token";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function path(): string { return join(mkdtempSync(join(tmpdir(), "modelplug-grok-")), "credentials.json"); }

function account(over: Partial<GrokAccount> = {}): GrokAccount {
  return { id: "sub-1", email: "user@example.com", accessToken: fakeJwt({ sub: "sub-1" }), refreshToken: "r1", expiresAt: NOW + 3_600_000, lastRefresh: new Date(NOW).toISOString(), source: "login", ...over };
}

function fakeFetch(handler?: (input: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (url === discoveryUrl) return json({ authorization_endpoint: authorization, token_endpoint: token });
    if (handler) return handler(url, init);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const authError = { kind: "auth" as const, provider: "grok", message: "rejected", retryable: false, status: 401 };

test("discovery rejects http, foreign hosts, explicit ports, and userinfo before browser login", async () => {
  for (const bad of ["http://auth.x.ai/a", "https://evil.example/a", "https://auth.x.ai:443/a", "https://auth.x.ai:8443/a", "https://user@accounts.x.ai/a"]) {
    for (const field of ["authorization_endpoint", "token_endpoint"] as const) {
      const fetch = (async () => json({ authorization_endpoint: authorization, token_endpoint: token, [field]: bad })) as typeof globalThis.fetch;
      await assert.rejects(loginGrok({ fetch, discoveryUrl, open: () => assert.fail("browser must not open") }), (err: unknown) => err instanceof CredentialError && err.kind === "grok" && /unexpected endpoint/.test(err.message));
    }
  }
});

test("login exchanges callback code and PKCE verifier, taking identity from id_token", async () => {
  const port = 56129;
  let requests = 0;
  let challenge = "";
  const log: string[] = [];
  const fetch = fakeFetch((url, init) => {
    assert.equal(url, token);
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)["content-type"], "application/x-www-form-urlencoded");
    const body = new URLSearchParams(init?.body as string);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "browser-code");
    assert.equal(body.get("redirect_uri"), `http://localhost:${port}${GROK_CALLBACK_PATH}`);
    assert.equal(body.get("client_id"), GROK_CLIENT_ID);
    assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), challenge);
    requests++;
    return json({ access_token: fakeJwt({ sub: "access-sub", email: "ACCESS@EXAMPLE.COM" }), refresh_token: "refresh-1", expires_in: 3600, id_token: fakeJwt({ sub: "id-sub", email: "ID@EXAMPLE.COM" }) });
  });
  const result = await loginGrok({ discoveryUrl, fetch, port, now: () => NOW, log: m => log.push(m), open: async url => {
    const authorize = new URL(url);
    assert.equal(authorize.origin, "https://auth.x.ai");
    assert.equal(authorize.searchParams.get("prompt"), "login");
    assert.equal(authorize.searchParams.get("response_type"), "code");
    assert.equal(authorize.searchParams.get("client_id"), GROK_CLIENT_ID);
    assert.equal(authorize.searchParams.get("redirect_uri"), `http://localhost:${port}${GROK_CALLBACK_PATH}`);
    assert.equal(authorize.searchParams.get("scope"), "openid profile email offline_access grok-cli:access api:access");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    challenge = authorize.searchParams.get("code_challenge")!;
    const state = authorize.searchParams.get("state")!;
    const wrong = await globalThis.fetch(`http://127.0.0.1:${port}${GROK_CALLBACK_PATH}?code=stray&state=bad`);
    assert.equal(wrong.status, 400);
    await wrong.text();
    const good = await globalThis.fetch(`http://127.0.0.1:${port}${GROK_CALLBACK_PATH}?code=browser-code&state=${state}`);
    assert.equal(good.status, 200);
    assert.match(await good.text(), /Login complete/);
  } });
  assert.equal(result.id, "id-sub");
  assert.equal(result.email, "id@example.com");
  assert.equal(result.refreshToken, "refresh-1");
  assert.equal(result.expiresAt, NOW + 3_600_000 - 120_000);
  assert.equal(requests, 1);
  assert.match(log[0]!, /Open this URL/);
});

test("callback ignores a wrong-state error and escapes provider markup", async () => {
  const port = 56131;
  await assert.rejects(runCallbackLogin({ kind: "grok", port, path: GROK_CALLBACK_PATH,
    buildAuthorizeUrl: (state, challenge) => `https://auth.x.ai/authorize?state=${state}&code_challenge=${challenge}`,
    open: async url => {
      const state = new URL(url).searchParams.get("state")!;
      const wrong = await globalThis.fetch(`http://127.0.0.1:${port}${GROK_CALLBACK_PATH}?state=wrong&error=denied`);
      assert.equal(wrong.status, 400);
      assert.equal(wrong.headers.get("connection"), "close");
      assert.match(await wrong.text(), /state mismatch/);
      const failed = await globalThis.fetch(`http://127.0.0.1:${port}${GROK_CALLBACK_PATH}?state=${state}&error=%3Cscript%3E&error_description=%26%22`);
      assert.equal(failed.status, 400);
      const html = await failed.text();
      assert.match(html, /&lt;script&gt;/);
      assert.match(html, /&amp;&quot;/);
      assert.doesNotMatch(html, /<script>/);
    },
  }), /login failed: <script>/);
});

test("proactive refresh keeps the old refresh token and persists the new access token", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account({ expiresAt: NOW + 60_000 })] } });
  let calls = 0;
  const fetch = fakeFetch((url, init) => {
    assert.equal(url, token);
    const body = new URLSearchParams(init?.body as string);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "r1");
    assert.equal(body.get("client_id"), GROK_CLIENT_ID);
    calls++;
    return json({ access_token: fakeJwt({ sub: "sub-1", email: "NEW@EXAMPLE.COM" }), expires_in: 3600 });
  });
  const creds = credentialProviderFor(provider, { storePath, fetch, discoveryUrl, now: () => NOW });
  const resolved = await creds.resolve(target, 1);
  assert.equal(resolved.id, "sub-1");
  assert.equal(resolved.apiKey, loadCredentialStore(storePath).grok!.accounts[0]!.accessToken);
  assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.refreshToken, "r1");
  assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.email, "new@example.com");
  assert.equal(calls, 1);
  await creds.resolve(target, 2);
  assert.equal(calls, 1);
  assert.match(creds.status!()[0]!, /new@example.com \(grok\) token valid until/);
});

test("one 401 forces refresh; a second 401 marks needsLogin", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account()] } });
  let calls = 0;
  const fetch = fakeFetch(() => { calls++; return json({ access_token: fakeJwt({ sub: "sub-1", version: 1 }), refresh_token: "r2", expires_in: 3600 }); });
  const creds = grokCredentials(provider, { storePath, fetch, discoveryUrl, now: () => NOW });
  const first = await creds.resolve(target, 1);
  assert.deepEqual(await creds.report(target, first, { outcome: "error", error: authError }), { retry: true });
  const second = await creds.resolve(target, 2);
  assert.notEqual(second.apiKey, first.apiKey);
  assert.equal(calls, 1);
  assert.deepEqual(await creds.report(target, second, { outcome: "error", error: authError }), { retry: false });
  assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.needsLogin, true);
  assert.match(creds.status!()[0]!, /NEEDS LOGIN/);
  await assert.rejects(creds.resolve(target, 3), /needs a new login/);
});

test("concurrent 401s for one token share one refresh and only the refreshed token can mark needsLogin", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account()] } });
  let calls = 0;
  const creds = grokCredentials(provider, { storePath, discoveryUrl, now: () => NOW, fetch: fakeFetch(() => {
    calls++;
    return json({ access_token: fakeJwt({ sub: "sub-1", version: 1 }), expires_in: 3600 });
  }) });
  const [a, b] = await Promise.all([creds.resolve(target, 1), creds.resolve(target, 1)]);
  assert.equal(a.apiKey, b.apiKey);
  assert.deepEqual(await creds.report(target, a, { outcome: "error", error: authError }), { retry: true });
  assert.deepEqual(await creds.report(target, b, { outcome: "error", error: authError }), { retry: true });
  assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.needsLogin, undefined);
  const [aRetry, bRetry] = await Promise.all([creds.resolve(target, 2), creds.resolve(target, 2)]);
  assert.equal(calls, 1);
  assert.equal(aRetry.apiKey, bRetry.apiKey);
  assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.needsLogin, undefined);
  assert.deepEqual(await creds.report(target, aRetry, { outcome: "error", error: authError }), { retry: false });
  assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.needsLogin, true);
});

test("refresh cannot resurrect a logged-out account or overwrite a newer login", async () => {
  for (const change of ["logout", "login"] as const) {
    const storePath = path();
    saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account({ expiresAt: NOW })] } });
    const newer = account({ id: "new", accessToken: fakeJwt({ sub: "new" }), refreshToken: "new-refresh" });
    const creds = grokCredentials(provider, { storePath, discoveryUrl, now: () => NOW, fetch: fakeFetch(() => {
      const store = loadCredentialStore(storePath);
      if (change === "logout") delete store.grok;
      else store.grok = { accounts: [newer] };
      saveCredentialStore(storePath, store);
      return json({ access_token: fakeJwt({ sub: "sub-1", version: 2 }), expires_in: 3600 });
    }) });
    if (change === "logout") {
      await assert.rejects(creds.resolve(target, 1), /removed during a token refresh; run `modelplug login grok`/);
      assert.equal(loadCredentialStore(storePath).grok, undefined);
    } else {
      assert.deepEqual(await creds.resolve(target, 1), { id: "new", apiKey: newer.accessToken });
      assert.deepEqual(loadCredentialStore(storePath).grok!.accounts[0], newer);
    }
  }
});

test("proactive refresh survives HTTP and transport failures while a forced refresh fails", async () => {
  for (const failure of ["http", "transport"] as const) {
    const storePath = path();
    const original = account({ expiresAt: NOW + 100_000 });
    saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [original] } });
    const lines: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      if (String(input) === discoveryUrl) return json({ authorization_endpoint: authorization, token_endpoint: token });
      if (failure === "http") return json({ error: "unavailable" }, 503);
      throw new Error("ECONNRESET");
    }) as typeof globalThis.fetch;
    const creds = grokCredentials(provider, { storePath, fetch, discoveryUrl, now: () => NOW, log: m => lines.push(m) });
    assert.equal((await creds.resolve(target, 1)).apiKey, original.accessToken);
    assert.match(lines[0]!, /using the current token/);
    assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.needsLogin, undefined);
    assert.deepEqual(await creds.report(target, { id: original.id, apiKey: original.accessToken }, { outcome: "error", error: authError }), { retry: true });
    await assert.rejects(creds.resolve(target, 2), /token refresh failed/);
  }
});

test("discovery failure falls back proactively and discovery is cached across refreshes", async () => {
  const storePath = path();
  const original = account({ expiresAt: NOW + 100_000 });
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [original] } });
  let discoveryCalls = 0;
  let tokenCalls = 0;
  const lines: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    if (String(input) === discoveryUrl) {
      discoveryCalls++;
      return discoveryCalls === 1 ? json({}, 503) : json({ authorization_endpoint: authorization, token_endpoint: token });
    }
    tokenCalls++;
    return json({ access_token: fakeJwt({ sub: "sub-1", version: tokenCalls }), expires_in: 180 });
  }) as typeof globalThis.fetch;
  const creds = grokCredentials(provider, { storePath, fetch, discoveryUrl, now: () => NOW, log: m => lines.push(m) });
  assert.equal((await creds.resolve(target, 1)).apiKey, original.accessToken);
  assert.match(lines[0]!, /OIDC discovery failed/);
  await creds.resolve(target, 2);
  await creds.resolve(target, 3);
  assert.equal(discoveryCalls, 2, "the failed discovery is retried, then cached");
  assert.equal(tokenCalls, 2);
});

test("token requests time out with an operation-specific CredentialError", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account({ expiresAt: NOW })] } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === discoveryUrl) return json({ authorization_endpoint: authorization, token_endpoint: token });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof globalThis.fetch;
  const creds = grokCredentials(provider, { storePath, discoveryUrl, fetch, now: () => NOW, requestTimeoutMs: 20 });
  await assert.rejects(creds.resolve(target, 1), (err: unknown) => err instanceof CredentialError && /token refresh failed: aborted/.test(err.message));
});

test("refresh accepts numeric-string expiry and saves a rotated token before later validation fails", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account({ expiresAt: NOW })] } });
  let calls = 0;
  const creds = grokCredentials(provider, { storePath, discoveryUrl, now: () => NOW, fetch: fakeFetch(() => {
    calls++;
    return calls === 1
      ? json({ access_token: fakeJwt({ sub: "sub-1", version: 1 }), refresh_token: "r-rotated", expires_in: "3600" })
      : json({ refresh_token: "r-rotated-again", expires_in: "invalid" });
  }) });
  await creds.resolve(target, 1);
  assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.refreshToken, "r-rotated");
  const current = await creds.resolve(target, 2);
  assert.deepEqual(await creds.report(target, current, { outcome: "error", error: authError }), { retry: true });
  await assert.rejects(creds.resolve(target, 3), /invalid access_token or expires_in/);
  assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.refreshToken, "r-rotated-again");
});

test("a rejected refresh marks needsLogin", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account({ expiresAt: NOW })] } });
  const creds = grokCredentials(provider, { storePath, discoveryUrl, now: () => NOW, fetch: fakeFetch(() => json({ error: "invalid_grant" }, 400)) });
  await assert.rejects(creds.resolve(target, 1), /token refresh failed \(400\)/);
  assert.equal(loadCredentialStore(storePath).grok!.accounts[0]!.needsLogin, true);
});

test("status reports an expired Grok token", () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account({ expiresAt: NOW - 1 })] } });
  const creds = grokCredentials(provider, { storePath, now: () => NOW });
  assert.deepEqual(creds.status!(), ["user@example.com (grok) expired"]);
});

test("identity falls back to access_token when id_token lacks claims", async () => {
  const port = 56130;
  const fetch = fakeFetch(() => json({ access_token: fakeJwt({ sub: "access-only", email: "ACCESS@EXAMPLE.COM" }), refresh_token: "r", expires_in: 600, id_token: fakeJwt({}) }));
  const result = await loginGrok({ discoveryUrl, fetch, port, now: () => NOW, open: async url => {
    const state = new URL(url).searchParams.get("state")!;
    await (await globalThis.fetch(`http://127.0.0.1:${port}${GROK_CALLBACK_PATH}?code=c&state=${state}`)).text();
  } });
  assert.equal(result.id, "access-only");
  assert.equal(result.email, "access@example.com");
});

test("CLI lists, refuses Grok pinning, removes, logs out, and counts Grok accounts", async () => {
  const storePath = path();
  const configPath = join(storePath, "..", "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: { grok: { preset: "grok" } } }));
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account()] } });
  const oldPath = process.env.MODELPLUG_CREDENTIALS;
  const oldLog = console.log;
  const oldError = console.error;
  const oldExitCode = process.exitCode;
  const lines: string[] = [];
  process.env.MODELPLUG_CREDENTIALS = storePath;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await main(["account", "list"]);
    assert.match(lines.join("\n"), /sub-1  grok/);
    const before = loadCredentialStore(storePath);
    process.exitCode = 0;
    await main(["account", "use", "sub-1"]);
    assert.equal(process.exitCode, 1);
    assert.match(lines.join("\n"), /grok holds one account and has nothing to pin/);
    assert.deepEqual(loadCredentialStore(storePath), before);
    process.exitCode = 0;
    await main(["account", "use", "auto"]);
    await main(["check", "--config", configPath, "--offline"]);
    assert.match(lines.join("\n"), /grok accounts=1/);
    await main(["account", "remove", "sub-1"]);
    assert.equal(loadCredentialStore(storePath).grok?.accounts.length, 0);
    saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, grok: { accounts: [account()] } });
    await main(["logout", "grok"]);
    assert.equal(loadCredentialStore(storePath).grok, undefined);
  } finally {
    console.log = oldLog;
    console.error = oldError;
    process.exitCode = oldExitCode;
    if (oldPath === undefined) delete process.env.MODELPLUG_CREDENTIALS;
    else process.env.MODELPLUG_CREDENTIALS = oldPath;
  }
});

test("account remove rejects unknown and missing ids with and without a Grok section", async () => {
  const storePath = path();
  const oldPath = process.env.MODELPLUG_CREDENTIALS;
  const oldError = console.error;
  const oldLog = console.log;
  const oldExitCode = process.exitCode;
  const errors: string[] = [];
  process.env.MODELPLUG_CREDENTIALS = storePath;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  console.log = () => assert.fail("unknown account must not print success");
  try {
    for (const grok of [undefined, { accounts: [account()] }]) {
      saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, ...(grok ? { grok } : {}) });
      for (const args of [["account", "remove", "does-not-exist"], ["account", "remove"]]) {
        process.exitCode = 0;
        await main(args);
        assert.equal(process.exitCode, 1);
        assert.match(errors.at(-1)!, /no account with id/);
      }
      assert.equal(loadCredentialStore(storePath).grok?.accounts.length, grok?.accounts.length);
    }
  } finally {
    console.error = oldError;
    console.log = oldLog;
    process.exitCode = oldExitCode;
    if (oldPath === undefined) delete process.env.MODELPLUG_CREDENTIALS;
    else process.env.MODELPLUG_CREDENTIALS = oldPath;
  }
});
