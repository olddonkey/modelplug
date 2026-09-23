import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { main } from "../src/main.ts";
import { CredentialError, credentialProviderFor } from "../src/credentials/index.ts";
import { KIMI_CLIENT_ID, kimiCredentials, loginKimi } from "../src/credentials/kimi.ts";
import { loadCredentialStore, saveCredentialStore, type KimiAccount } from "../src/credentials/store.ts";
import { fakeJwt } from "./helpers.ts";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const provider = parseConfig({ providers: { kimi: { preset: "kimi" } } }, "test").providers.kimi!;
const target = { provider: "kimi", model: "k3" };
const access = fakeJwt({ user_id: "user-1", email: "ONE@EXAMPLE.COM" });
const refresh = fakeJwt({ sub: "user-1", email: "refresh@example.com" });

function path(): string {
  return join(mkdtempSync(join(tmpdir(), "modelplug-kimi-")), "credentials.json");
}

function account(over: Partial<KimiAccount> = {}): KimiAccount {
  return { id: "user-1", email: "one@example.com", accessToken: access, refreshToken: refresh, expiresAt: NOW + 60 * 60_000, lastRefresh: new Date(NOW).toISOString(), source: "login", ...over };
}

type Reply = { status?: number; body: Record<string, unknown> | string } | { reject: Error };
function fakeAuth(replies: Reply[]) {
  const calls: Array<{ url: string; headers: Headers; form: URLSearchParams }> = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.match(url, /^https:\/\/fake\.example\/api\/oauth\/(device_authorization|token)$/);
    const response = replies[calls.length];
    assert.ok(response, `unexpected OAuth call ${calls.length + 1}`);
    calls.push({ url, headers: new Headers(init?.headers), form: new URLSearchParams(String(init?.body)) });
    assert.ok(init?.signal, "every OAuth request has a timeout signal");
    if ("reject" in response) throw response.reject;
    return typeof response.body === "string" ? new Response(response.body, { status: response.status ?? 200 }) : Response.json(response.body, { status: response.status ?? 200 });
  };
  return { fetchStub, calls };
}

function assertHeaders(headers: Headers, deviceId: string): void {
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(headers.get("user-agent"), "KimiCLI/0.14.0");
  assert.equal(headers.get("x-msh-platform"), "kimi_code_cli");
  assert.equal(headers.get("x-msh-version"), "0.14.0");
  assert.ok(headers.get("x-msh-device-name"));
  assert.match(headers.get("x-msh-device-model")!, /\S+ \S+ \S+/);
  assert.ok(headers.get("x-msh-os-version"));
  assert.equal(headers.get("x-msh-device-id"), deviceId);
}

test("device login prints URL and code before polling, grows the interval, and persists one device id", async () => {
  const storePath = path();
  const lines: string[] = [];
  const waits: number[] = [];
  const auth = fakeAuth([
    { body: { user_code: "ABCD-EFGH", device_code: "device-code", verification_uri: "https://fake.example/activate", expires_in: 120, interval: 2 } },
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down", interval: 6 } },
    { body: { access_token: access, refresh_token: refresh, expires_in: 3600 } },
    { body: { user_code: "SECOND", device_code: "again", verification_uri: "https://fake.example/activate", expires_in: 120, interval: 2 } },
    { body: { access_token: access, refresh_token: refresh, expires_in: 3600 } },
  ]);
  const deps = { storePath, oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, log: (line: string) => lines.push(line), sleep: async (ms: number) => { waits.push(ms); } };
  const first = await loginKimi(deps);
  assert.deepEqual(lines, ["Open this URL to approve the login: https://fake.example/activate", "Enter this code: ABCD-EFGH"]);
  assert.deepEqual(waits, [2_000, 2_000, 7_000]);
  assert.equal(first.id, "user-1");
  assert.equal(first.email, "one@example.com");
  assert.equal(first.expiresAt, NOW + 3_600_000 - 300_000);
  assert.equal(first.source, "login");
  const deviceId = loadCredentialStore(storePath).kimi?.deviceId;
  assert.match(deviceId!, /^[0-9a-f]{32}$/);
  assert.equal(statSync(storePath).mode & 0o777, 0o600);
  for (const call of auth.calls) assertHeaders(call.headers, deviceId!);
  assert.equal(auth.calls[0]!.form.get("client_id"), KIMI_CLIENT_ID);
  assert.equal(auth.calls[1]!.form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(auth.calls[1]!.form.get("device_code"), "device-code");
  assert.equal(auth.calls[1]!.form.get("client_id"), KIMI_CLIENT_ID);
  await loginKimi(deps);
  assert.equal(loadCredentialStore(storePath).kimi?.deviceId, deviceId);
  for (const call of auth.calls) assertHeaders(call.headers, deviceId!);
});

test("device login honors the larger server slow_down interval and its deadline", async () => {
  const auth = fakeAuth([
    { body: { user_code: "CODE", device_code: "d", verification_uri: "https://fake.example/v", expires_in: 25, interval: 1 } },
    { status: 400, body: { error: "slow_down", interval: 12 } },
    { status: 400, body: { error: "authorization_pending" } },
  ]);
  const waits: number[] = [];
  await assert.rejects(loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, log: () => {}, sleep: async ms => { waits.push(ms); } }),
    (err: unknown) => err instanceof CredentialError && err.kind === "kimi" && /login timed out/.test(err.message));
  assert.deepEqual(waits, [1_000, 12_000]);
});

test("device login defaults to five-second polls and honors timeoutMs", async () => {
  const auth = fakeAuth([
    { body: { user_code: "CODE", device_code: "d", verification_uri: "https://fake.example/v" } },
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "authorization_pending" } },
  ]);
  const waits: number[] = [];
  await assert.rejects(loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, timeoutMs: 12_000, log: () => {}, sleep: async ms => { waits.push(ms); } }), /login timed out/);
  assert.deepEqual(waits, [5_000, 5_000]);
  assert.equal(auth.calls.length, 3);
});

test("device login clamps a long server lifetime to fifteen minutes", async () => {
  const auth = fakeAuth([
    { body: { user_code: "CODE", device_code: "d", verification_uri: "https://fake.example/v", expires_in: "3600", interval: 300 } },
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "authorization_pending" } },
  ]);
  const waits: number[] = [];
  await assert.rejects(loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, log: () => {}, sleep: async ms => { waits.push(ms); } }), /login timed out/);
  assert.deepEqual(waits, [300_000, 300_000]);
});

test("device login accepts numeric expires_in strings, falls back on an invalid device expiry, and validates the URL", async () => {
  const lines: string[] = [];
  const auth = fakeAuth([
    { body: { user_code: "CODE", device_code: "d", verification_uri: "https://fake.example/basic", verification_uri_complete: "https://fake.example/complete?code=CODE", expires_in: "bad", interval: 1 } },
    { body: { access_token: access, refresh_token: refresh, expires_in: "3600" } },
  ]);
  const result = await loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, log: line => lines.push(line), sleep: async () => {} });
  assert.deepEqual(lines, ["Open this URL to approve the login: https://fake.example/complete?code=CODE", "Enter this code: CODE"]);
  assert.equal(result.expiresAt, NOW + 3_300_000);
  const invalid = fakeAuth([{ body: { user_code: "CODE", device_code: "d", verification_uri: "http://fake.example/v" } }]);
  await assert.rejects(loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: invalid.fetchStub, log: () => {} }), /not https/);
});

test("polling survives a transport blip and stops after five consecutive failures", async () => {
  const auth = fakeAuth([
    { body: { user_code: "CODE", device_code: "d", verification_uri: "https://fake.example/v", interval: 1 } },
    { status: 400, body: { error: "authorization_pending" } },
    { reject: new Error("temporary network loss") },
    { status: 400, body: { error: "authorization_pending" } },
    { body: { access_token: access, refresh_token: refresh, expires_in: 3600 } },
  ]);
  const result = await loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, log: () => {}, sleep: async () => {} });
  assert.equal(result.id, "user-1");
  const failures = fakeAuth([
    { body: { user_code: "CODE", device_code: "d", verification_uri: "https://fake.example/v", interval: 1 } },
    ...Array.from({ length: 5 }, (_, i) => ({ reject: new Error(`network ${i + 1}`) })),
  ]);
  await assert.rejects(loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: failures.fetchStub, now: () => NOW, log: () => {}, sleep: async () => {} }), /network 5/);
  assert.equal(failures.calls.length, 6);
});

test("device login names access_denied and expired_token", async () => {
  for (const reason of ["access_denied", "expired_token"]) {
    const auth = fakeAuth([
      { body: { user_code: "CODE", device_code: "d", verification_uri: "https://fake.example/v", expires_in: 60, interval: 1 } },
      { status: 400, body: { error: reason, error_description: "reason from server" } },
    ]);
    await assert.rejects(loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, log: () => {}, sleep: async () => {} }),
      (err: unknown) => err instanceof CredentialError && err.kind === "kimi" && err.message.includes(reason) && err.message.includes("reason from server"));
  }
});

test("identity falls back to refresh JWT, and invalid expires_in is rejected", async () => {
  const auth = fakeAuth([
    { body: { user_code: "C", device_code: "d", verification_uri: "https://fake.example/v" } },
    { body: { access_token: "opaque-access", refresh_token: fakeJwt({ sub: "refresh-id", email: "FALLBACK@EXAMPLE.COM" }), expires_in: 900 } },
  ]);
  const result = await loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, log: () => {}, sleep: async () => {} });
  assert.equal(result.id, "refresh-id");
  assert.equal(result.email, "fallback@example.com");
  for (const invalid of [-1, "NaN", null, "Infinity"]) {
    const bad = fakeAuth([
      { body: { user_code: "C", device_code: "d", verification_uri: "https://fake.example/v" } },
      { body: { access_token: access, refresh_token: refresh, expires_in: invalid } },
    ]);
    await assert.rejects(loginKimi({ storePath: path(), oauthHost: "https://fake.example", fetch: bad.fetchStub, now: () => NOW, log: () => {}, sleep: async () => {} }), /invalid expires_in/);
  }
});

test("old stores load; proactive refresh keeps an omitted refresh token and returns a bare bearer key", async () => {
  const storePath = path();
  writeFileSync(storePath, JSON.stringify({ schemaVersion: 1, chatgpt: { accounts: [] } }));
  assert.equal(loadCredentialStore(storePath).kimi, undefined);
  const a = account({ expiresAt: NOW + 299_999 });
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [a] } });
  const newAccess = fakeJwt({ sub: "user-1" });
  const auth = fakeAuth([{ body: { access_token: newAccess, expires_in: 3600 } }]);
  const creds = credentialProviderFor(provider, { storePath, oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW });
  assert.equal(creds.kind, "kimi");
  assert.deepEqual(await creds.resolve(target, 1), { id: "user-1", apiKey: newAccess });
  assert.equal(loadCredentialStore(storePath).kimi?.accounts[0]?.refreshToken, refresh);
  assert.equal(loadCredentialStore(storePath).kimi?.accounts[0]?.expiresAt, NOW + 3_300_000);
  assert.equal(auth.calls[0]!.form.get("grant_type"), "refresh_token");
  assert.equal(auth.calls[0]!.form.get("refresh_token"), refresh);
  assertHeaders(auth.calls[0]!.headers, loadCredentialStore(storePath).kimi!.deviceId!);
});

test("concurrent 401 reports for one stale token retry; one refresh serves both and a refreshed-token 401 marks NEEDS LOGIN", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account()] } });
  const newAccess = fakeJwt({ user_id: "user-1" });
  const auth = fakeAuth([{ body: { access_token: newAccess, refresh_token: "new-refresh", expires_in: 3600 } }]);
  const creds = kimiCredentials(provider, { storePath, oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW });
  const before = await creds.resolve(target, 1);
  assert.equal(before.apiKey, access);
  const unauthorized = { outcome: "error" as const, error: { kind: "auth" as const, status: 401, message: "unauthorized", provider: "kimi", retryable: false } };
  assert.deepEqual(await creds.report(target, before, unauthorized), { retry: true });
  assert.deepEqual(await creds.report(target, before, unauthorized), { retry: true });
  assert.equal(loadCredentialStore(storePath).kimi?.accounts[0]?.needsLogin, undefined);
  const [after, other] = await Promise.all([creds.resolve(target, 2), creds.resolve(target, 2)]);
  assert.equal(after.apiKey, newAccess);
  assert.equal(other.apiKey, newAccess);
  assert.equal(loadCredentialStore(storePath).kimi?.accounts[0]?.refreshToken, "new-refresh");
  assert.equal(auth.calls.length, 1);
  assert.deepEqual(await creds.report(target, before, unauthorized), { retry: true }, "a late stale-token 401 does not mark the new token bad");
  assert.deepEqual(await creds.report(target, after, unauthorized), { retry: false });
  assert.equal(loadCredentialStore(storePath).kimi?.accounts[0]?.needsLogin, true);
  assert.match(creds.status!()[0]!, /one@example\.com \(kimi\)  NEEDS LOGIN/);
  await assert.rejects(creds.resolve(target, 3), /needs a new login/);
  assert.equal(auth.calls.length, 1);
});

test("refresh 400 marks needsLogin; status reports valid and expired tokens", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account({ expiresAt: NOW + 299_999 })] } });
  const auth = fakeAuth([{ status: 400, body: { error: "invalid_grant" } }]);
  const creds = kimiCredentials(provider, { storePath, oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW });
  assert.match(creds.status!()[0]!, /token valid until 2026-09-23T12:04:59\.999Z/);
  await assert.rejects(creds.resolve(target, 1), /token refresh failed \(400\)/);
  assert.equal(loadCredentialStore(storePath).kimi?.accounts[0]?.needsLogin, true);
  assert.match(creds.status!()[0]!, /NEEDS LOGIN/);
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account({ expiresAt: NOW - 1 })] } });
  assert.match(creds.status!()[0]!, /expired/);
});

test("refresh 401 with a non-JSON body still marks needsLogin", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account({ expiresAt: NOW })] } });
  const auth = fakeAuth([{ status: 401, body: "unauthorized" }]);
  const creds = kimiCredentials(provider, { storePath, oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW });
  await assert.rejects(creds.resolve(target, 1), /token refresh failed \(401\)/);
  assert.equal(loadCredentialStore(storePath).kimi?.accounts[0]?.needsLogin, true);
});

test("an unforced 503 refresh uses a still-valid token and logs the failure", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account({ expiresAt: NOW + 4 * 60_000 })] } });
  const auth = fakeAuth([{ status: 503, body: { error: "unavailable" } }]);
  const lines: string[] = [];
  const creds = kimiCredentials(provider, { storePath, oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, log: line => lines.push(line) });
  assert.deepEqual(await creds.resolve(target, 1), { id: "user-1", apiKey: access });
  assert.match(lines[0]!, /token refresh failed.*503/);
  assert.equal(loadCredentialStore(storePath).kimi?.accounts[0]?.needsLogin, undefined);
});

test("an OAuth request timeout clears in-flight refresh so a later resolve can retry", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account({ expiresAt: NOW })] } });
  let calls = 0;
  const fetchStub: typeof fetch = async (_input, init) => {
    calls++;
    if (calls === 2) return Response.json({ access_token: fakeJwt({ sub: "user-1" }), expires_in: 3600 });
    const signal = init?.signal;
    assert.ok(signal);
    return await new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("abort did not fire")), 200);
      signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    });
  };
  const creds = kimiCredentials(provider, { storePath, oauthHost: "https://fake.example", fetch: fetchStub, now: () => NOW, requestTimeoutMs: 20 });
  await assert.rejects(creds.resolve(target, 1), (err: unknown) => err instanceof CredentialError && /OAuth request failed/.test(err.message));
  assert.deepEqual(await creds.resolve(target, 2), { id: "user-1", apiKey: fakeJwt({ sub: "user-1" }) });
  assert.equal(calls, 2);
});

test("a removed Kimi account is not restored by an in-flight refresh", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account({ expiresAt: NOW })] } });
  let release!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const fetchStub: typeof fetch = async () => {
    started();
    return await new Promise<Response>(resolve => { release = resolve; });
  };
  const creds = kimiCredentials(provider, { storePath, oauthHost: "https://fake.example", fetch: fetchStub, now: () => NOW });
  const pending = creds.resolve(target, 1);
  await entered;
  const store = loadCredentialStore(storePath);
  store.kimi!.accounts = [];
  saveCredentialStore(storePath, store);
  release(Response.json({ access_token: fakeJwt({ sub: "user-1" }), refresh_token: "rotated", expires_in: 3600 }));
  await assert.rejects(pending, /the Kimi account was removed during a token refresh; run `modelplug login kimi`/);
  assert.deepEqual(loadCredentialStore(storePath).kimi?.accounts, []);
});

test("a rotated refresh token survives malformed expires_in and the access token expires now", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account({ expiresAt: NOW })] } });
  const nextAccess = fakeJwt({ sub: "user-1" });
  const auth = fakeAuth([{ body: { access_token: nextAccess, refresh_token: "rotated-refresh", expires_in: "bad" } }]);
  const lines: string[] = [];
  const creds = kimiCredentials(provider, { storePath, oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW, log: line => lines.push(line) });
  assert.deepEqual(await creds.resolve(target, 1), { id: "user-1", apiKey: nextAccess });
  const stored = loadCredentialStore(storePath).kimi!.accounts[0]!;
  assert.equal(stored.refreshToken, "rotated-refresh");
  assert.equal(stored.expiresAt, NOW);
  assert.match(lines[0]!, /invalid expires_in/);
});

test("a successful report re-arms one reactive refresh, and a failed forced refresh clears its memory", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account()] } });
  const next = fakeJwt({ sub: "user-1", nonce: 2 });
  const newest = fakeJwt({ sub: "user-1", nonce: 3 });
  const auth = fakeAuth([
    { body: { access_token: next, expires_in: 3600 } },
    { status: 503, body: { error: "unavailable" } },
    { body: { access_token: newest, expires_in: 3600 } },
  ]);
  const creds = kimiCredentials(provider, { storePath, oauthHost: "https://fake.example", fetch: auth.fetchStub, now: () => NOW });
  const unauthorized = { outcome: "error" as const, error: { kind: "auth" as const, status: 401, message: "unauthorized", provider: "kimi", retryable: false } };
  const first = await creds.resolve(target, 1);
  assert.deepEqual(await creds.report(target, first, unauthorized), { retry: true });
  const second = await creds.resolve(target, 2);
  assert.equal(second.apiKey, next);
  assert.deepEqual(await creds.report(target, second, { outcome: "ok" }), { retry: false });
  assert.deepEqual(await creds.report(target, second, unauthorized), { retry: true });
  await assert.rejects(creds.resolve(target, 3), /token refresh failed \(503\)/);
  // A new login replaces the token after the failed forced refresh.
  const store = loadCredentialStore(storePath);
  store.kimi!.accounts = [account({ accessToken: next, expiresAt: NOW + 60 * 60_000 })];
  saveCredentialStore(storePath, store);
  assert.deepEqual(await creds.report(target, second, unauthorized), { retry: true });
  const third = await creds.resolve(target, 4);
  assert.equal(third.apiKey, newest);
  assert.equal(auth.calls.length, 3);
});

test("concurrent resolve calls share one in-flight refresh request", async () => {
  const storePath = path();
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account({ expiresAt: NOW })] } });
  let calls = 0;
  let release!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const fetchStub: typeof fetch = async () => {
    calls++;
    started();
    return await new Promise<Response>(resolve => { release = resolve; });
  };
  const creds = kimiCredentials(provider, { storePath, oauthHost: "https://fake.example", fetch: fetchStub, now: () => NOW });
  const a = creds.resolve(target, 1);
  const b = creds.resolve(target, 2);
  await entered;
  release(Response.json({ access_token: fakeJwt({ sub: "user-1", nonce: 4 }), expires_in: 3600 }));
  const [left, right] = await Promise.all([a, b]);
  assert.deepEqual(left, right);
  assert.equal(calls, 1);
});

test("CLI lists both kinds, uses and removes ids, logs out Kimi, and checks its account count offline", async () => {
  const storePath = path();
  const configPath = join(mkdtempSync(join(tmpdir(), "modelplug-kimi-config-")), "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: { kimi: { preset: "kimi" } } }));
  saveCredentialStore(storePath, {
    schemaVersion: 1,
    chatgpt: { accounts: [{ id: "chat-1", accountId: "chat-1", email: "chat@example.com", accessToken: fakeJwt({ exp: Math.floor(NOW / 1000) + 3600 }), refreshToken: "chat-refresh", lastRefresh: new Date(NOW).toISOString(), source: "login" }] },
    kimi: { accounts: [account()] },
  });
  const previousPath = process.env.MODELPLUG_CREDENTIALS;
  const originalLog = console.log;
  const lines: string[] = [];
  process.env.MODELPLUG_CREDENTIALS = storePath;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await main(["account", "list"]);
    assert.ok(lines.some(line => /^chat-1  chatgpt  /.test(line)));
    assert.ok(lines.some(line => /^user-1  kimi  /.test(line)));
    lines.length = 0;
    await main(["account", "use", "chat-1"]);
    assert.equal(loadCredentialStore(storePath).chatgpt.active, "chat-1");
    await main(["account", "use", "auto"]);
    assert.equal(loadCredentialStore(storePath).chatgpt.active, undefined);
    const beforeKimiUse = readFileSync(storePath, "utf8");
    await main(["account", "use", "user-1"]);
    assert.ok(lines.includes("Kimi has one account; nothing to pin"));
    assert.equal(readFileSync(storePath, "utf8"), beforeKimiUse);
    await main(["check", "--offline", "--config", configPath]);
    assert.ok(lines.some(line => line.includes("kimi accounts=1")));
    await main(["account", "remove", "user-1"]);
    assert.equal(loadCredentialStore(storePath).kimi?.accounts.length, 0);
    saveCredentialStore(storePath, { ...loadCredentialStore(storePath), kimi: { accounts: [account()], deviceId: "a".repeat(32) } });
    await main(["logout", "kimi"]);
    assert.equal(loadCredentialStore(storePath).kimi?.accounts.length, 0);
    assert.equal(loadCredentialStore(storePath).kimi?.deviceId, "a".repeat(32));
    assert.equal(loadCredentialStore(storePath).chatgpt.accounts.length, 1);
  } finally {
    console.log = originalLog;
    if (previousPath === undefined) delete process.env.MODELPLUG_CREDENTIALS;
    else process.env.MODELPLUG_CREDENTIALS = previousPath;
  }
});

test("CLI login kimi replaces the prior account, keeps its device id, and rejects import flags", async () => {
  const storePath = path();
  const previousPath = process.env.MODELPLUG_CREDENTIALS;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const lines: string[] = [];
  const errors: string[] = [];
  let calls = 0;
  process.env.MODELPLUG_CREDENTIALS = storePath;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal);
    const step = calls++;
    if (step % 2 === 0) return Response.json({ user_code: "CODE", device_code: "device", verification_uri: "https://fake.example/verify", interval: 0.001, expires_in: 60 });
    return Response.json({ access_token: fakeJwt({ sub: `user-${step}`, email: "KIMI@EXAMPLE.COM" }), refresh_token: `refresh-${step}`, expires_in: "3600" });
  };
  try {
    await main(["login", "kimi"]);
    const first = loadCredentialStore(storePath);
    assert.equal(first.kimi?.accounts[0]?.id, "user-1");
    assert.match(first.kimi?.deviceId ?? "", /^[0-9a-f]{32}$/);
    assert.deepEqual(lines.slice(0, 2), ["Open this URL to approve the login: https://fake.example/verify", "Enter this code: CODE"]);
    await main(["login", "kimi"]);
    const second = loadCredentialStore(storePath);
    assert.equal(second.kimi?.accounts.length, 1);
    assert.equal(second.kimi?.accounts[0]?.id, "user-3");
    assert.equal(second.kimi?.deviceId, first.kimi?.deviceId);
    const before = readFileSync(storePath, "utf8");
    await main(["login", "kimi", "--import"]);
    await main(["login", "kimi", "--from", "unused.json"]);
    assert.equal(readFileSync(storePath, "utf8"), before);
    assert.equal(calls, 4);
    assert.equal(errors.filter(line => /does not support --import or --from/.test(line)).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
    if (previousPath === undefined) delete process.env.MODELPLUG_CREDENTIALS;
    else process.env.MODELPLUG_CREDENTIALS = previousPath;
  }
});

test("CLI account list shows Kimi alone and an accurate empty hint; logout chatgpt keeps Kimi", async () => {
  const storePath = path();
  const previousPath = process.env.MODELPLUG_CREDENTIALS;
  const originalLog = console.log;
  const lines: string[] = [];
  process.env.MODELPLUG_CREDENTIALS = storePath;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await main(["account", "list"]);
    assert.deepEqual(lines, ["no accounts. Run: modelplug login chatgpt --import, modelplug login chatgpt, or modelplug login kimi"]);
    saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [] }, kimi: { accounts: [account()], deviceId: "b".repeat(32) } });
    lines.length = 0;
    await main(["account", "list"]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^user-1  kimi  one@example.com/);
    await main(["logout", "chatgpt"]);
    assert.equal(loadCredentialStore(storePath).kimi?.accounts[0]?.id, "user-1");
    assert.equal(loadCredentialStore(storePath).kimi?.deviceId, "b".repeat(32));
  } finally {
    console.log = originalLog;
    if (previousPath === undefined) delete process.env.MODELPLUG_CREDENTIALS;
    else process.env.MODELPLUG_CREDENTIALS = previousPath;
  }
});
