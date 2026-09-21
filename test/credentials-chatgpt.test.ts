import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { chatgptCredentials, importCodexAuth, parseQuotaHeaders, tokenExpiresAt } from "../src/credentials/chatgpt.ts";
import { CredentialError } from "../src/credentials/index.ts";
import { loadCredentialStore, saveCredentialStore, type ChatgptAccount } from "../src/credentials/store.ts";
import { AUTH_CLAIM, close, fakeJwt, fakeUpstream } from "./helpers.ts";

const FAR = Math.floor(Date.now() / 1000) + 86_400;
const SOON = Math.floor(Date.now() / 1000) + 60;
const target = { provider: "chatgpt", model: "gpt-5.6-sol" };
const provider = parseConfig({ providers: { chatgpt: { preset: "chatgpt" } } }, "test").providers.chatgpt!;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wb-cred-"));
}

function account(over: Partial<ChatgptAccount> = {}): ChatgptAccount {
  return {
    id: "acc-1",
    accountId: "acc-1",
    email: "a@example.com",
    accessToken: fakeJwt({ exp: FAR, [AUTH_CLAIM]: { chatgpt_account_id: "acc-1" } }),
    refreshToken: "refresh-1",
    lastRefresh: new Date().toISOString(),
    source: "import",
    ...over,
  };
}

test("importCodexAuth reads tokens, account id, email and plan without writing", () => {
  const dir = tempDir();
  const path = join(dir, "auth.json");
  writeFileSync(
    path,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      last_refresh: "2026-09-21T06:39:40Z",
      tokens: {
        access_token: fakeJwt({ exp: FAR, [AUTH_CLAIM]: { chatgpt_account_id: "acc-9", chatgpt_plan_type: "pro" } }),
        refresh_token: "r9",
        id_token: fakeJwt({ email: "me@example.com", [AUTH_CLAIM]: { chatgpt_account_id: "acc-9", chatgpt_plan_type: "pro" } }),
        account_id: "acc-9",
      },
    }),
  );
  const before = readFileSync(path, "utf8");
  const imported = importCodexAuth(path, () => 1_000);
  assert.equal(imported.accountId, "acc-9");
  assert.equal(imported.email, "me@example.com");
  assert.equal(imported.planType, "pro");
  assert.equal(imported.refreshToken, "r9");
  assert.equal(imported.source, "import");
  assert.equal(readFileSync(path, "utf8"), before);
  writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: "sk-only" }));
  assert.throws(() => importCodexAuth(path), CredentialError);
  assert.throws(() => importCodexAuth(join(dir, "missing.json")), /not found/);
});

test("the store is written with mode 0600 and round-trips", { skip: process.platform === "win32" }, () => {
  const path = join(tempDir(), "credentials.json");
  saveCredentialStore(path, { schemaVersion: 1, chatgpt: { accounts: [account()], active: "acc-1" } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(loadCredentialStore(path).chatgpt.accounts[0]!.email, "a@example.com");
  writeFileSync(path, "{not json");
  assert.throws(() => loadCredentialStore(path), /credentials.json/);
});

test("resolve hands out the bearer token and account header; no account is a clear error", async () => {
  const path = join(tempDir(), "credentials.json");
  const creds = chatgptCredentials(provider, { storePath: path });
  await assert.rejects(creds.resolve(target, 1), /no ChatGPT account; run `modelplug login chatgpt --import`/);
  const a = account();
  saveCredentialStore(path, { schemaVersion: 1, chatgpt: { accounts: [a] } });
  const credential = await creds.resolve(target, 1, "conv");
  assert.deepEqual(credential, { id: "acc-1", apiKey: a.accessToken, headers: { "chatgpt-account-id": "acc-1" } });
});

test("an expiring token is refreshed through the token endpoint and persisted", async () => {
  const path = join(tempDir(), "credentials.json");
  const newAccess = fakeJwt({ exp: FAR, [AUTH_CLAIM]: { chatgpt_account_id: "acc-1" } });
  const token = await fakeUpstream([
    (req, res, body) => {
      const params = new URLSearchParams(body);
      assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("refresh_token"), "refresh-1");
      assert.equal(params.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: newAccess, refresh_token: "refresh-2", id_token: fakeJwt({ email: "a@example.com" }) }));
    },
  ]);
  try {
    saveCredentialStore(path, { schemaVersion: 1, chatgpt: { accounts: [account({ accessToken: fakeJwt({ exp: SOON }) })] } });
    const creds = chatgptCredentials(provider, { storePath: path, tokenUrl: `http://127.0.0.1:${token.port}/oauth/token` });
    const credential = await creds.resolve(target, 1);
    assert.equal(credential.apiKey, newAccess);
    assert.equal(token.calls, 1);
    const stored = loadCredentialStore(path).chatgpt.accounts[0]!;
    assert.equal(stored.refreshToken, "refresh-2");
    assert.ok(tokenExpiresAt(stored.accessToken)! > Date.now() + 3_600_000);
    await creds.resolve(target, 2);
    assert.equal(token.calls, 1, "a fresh token is not refreshed again");
  } finally {
    await close(token.server);
  }
});

test("a 401 report asks for one retry with a forced refresh, then gives up", async () => {
  const path = join(tempDir(), "credentials.json");
  const token = await fakeUpstream([
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: fakeJwt({ exp: FAR }), refresh_token: "refresh-3" }));
    },
  ]);
  try {
    saveCredentialStore(path, { schemaVersion: 1, chatgpt: { accounts: [account()] } });
    const creds = chatgptCredentials(provider, { storePath: path, tokenUrl: `http://127.0.0.1:${token.port}/t` });
    const first = await creds.resolve(target, 1);
    const authError = { kind: "auth" as const, message: "expired", provider: "chatgpt", retryable: false, status: 401 };
    const advice = await creds.report(target, first, { outcome: "error", error: authError });
    assert.deepEqual(advice, { retry: true });
    const second = await creds.resolve(target, 2);
    assert.notEqual(second.apiKey, first.apiKey);
    assert.equal(token.calls, 1);
    const again = await creds.report(target, second, { outcome: "error", error: authError });
    assert.deepEqual(again, { retry: false });
    await creds.report(target, second, { outcome: "ok" });
    assert.deepEqual(await creds.report(target, second, { outcome: "error", error: authError }), { retry: true }, "a success re-arms the single refresh");
  } finally {
    await close(token.server);
  }
});

test("a rejected refresh marks the account as needing login", async () => {
  const path = join(tempDir(), "credentials.json");
  const token = await fakeUpstream([
    (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
    },
  ]);
  try {
    saveCredentialStore(path, { schemaVersion: 1, chatgpt: { accounts: [account({ accessToken: fakeJwt({ exp: SOON }) })] } });
    const creds = chatgptCredentials(provider, { storePath: path, tokenUrl: `http://127.0.0.1:${token.port}/t` });
    await assert.rejects(creds.resolve(target, 1), /token refresh failed \(400\)/);
    assert.equal(loadCredentialStore(path).chatgpt.accounts[0]!.needsLogin, true);
    await assert.rejects(creds.resolve(target, 2), /needs a new login/);
  } finally {
    await close(token.server);
  }
});

test("quota headers are parsed into windows", () => {
  const now = 1_700_000_000_000;
  const headers = new Headers({
    "x-codex-primary-used-percent": "42",
    "x-codex-primary-reset-at": String(Math.floor(now / 1000) + 3600),
    "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "7.5",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-after-seconds": "600",
  });
  const q = parseQuotaHeaders(headers, now)!;
  assert.deepEqual(q.primary, { usedPercent: 42, resetAt: now + 3_600_000, windowMinutes: 300 });
  assert.deepEqual(q.secondary, { usedPercent: 7.5, windowMinutes: 10080, resetAt: now + 600_000 });
  assert.equal(q.tertiary, undefined);
  assert.equal(parseQuotaHeaders(new Headers({ "content-type": "text/plain" }), now), undefined);
});
