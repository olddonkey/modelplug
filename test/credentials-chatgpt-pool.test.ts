import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { AFFINITY_TTL_MS, chatgptCredentials, usageScore, type ChatgptCredentialProvider } from "../src/credentials/chatgpt.ts";
import { CredentialError } from "../src/credentials/index.ts";
import { loadCredentialStore, saveCredentialStore, type ChatgptAccount } from "../src/credentials/store.ts";
import type { WireError } from "../src/ir.ts";
import { AUTH_CLAIM, close, fakeJwt, fakeUpstream } from "./helpers.ts";

const FAR = Math.floor(Date.now() / 1000) + 86_400;
const target = { provider: "chatgpt", model: "gpt-5.6-sol" };

function account(id: string, over: Partial<ChatgptAccount> = {}): ChatgptAccount {
  return {
    id,
    accountId: id,
    email: `${id}@example.com`,
    accessToken: fakeJwt({ exp: FAR, [AUTH_CLAIM]: { chatgpt_account_id: id } }),
    refreshToken: `refresh-${id}`,
    lastRefresh: new Date().toISOString(),
    source: "login",
    ...over,
  };
}

function pool(ids: string[], options: { strategy?: "lowest-usage" | "round-robin" | "fill-first"; active?: string; tokenUrl?: string; log?: (m: string) => void } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "wb-pool-")), "credentials.json");
  saveCredentialStore(path, { schemaVersion: 1, chatgpt: { accounts: ids.map(id => account(id)), ...(options.active ? { active: options.active } : {}) } });
  const provider = parseConfig({ providers: { chatgpt: { preset: "chatgpt", ...(options.strategy ? { strategy: options.strategy } : {}) } } }, "test").providers.chatgpt!;
  let clock = 1_000_000;
  const creds = chatgptCredentials(provider, { storePath: path, now: () => clock, ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}), ...(options.log ? { log: options.log } : {}) });
  return { creds, path, advance: (ms: number) => void (clock += ms), now: () => clock };
}

const quotaHeaders = (used: number, resetAfterSeconds = 3600): Headers =>
  new Headers({ "x-codex-primary-used-percent": String(used), "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": String(resetAfterSeconds) });
const quotaError = (over: Partial<WireError> = {}): WireError => ({ kind: "quota", message: "You have hit your usage limit", provider: "chatgpt", status: 429, retryable: false, ...over });
const authError: WireError = { kind: "auth", message: "expired", provider: "chatgpt", status: 401, retryable: false };

test("lowest-usage: untested accounts go first, then the one with the emptiest busiest window", async () => {
  const p = pool(["a", "b", "c"]);
  assert.equal(usageScore(undefined, 0), -1);
  const first = await p.creds.resolve(target, 1, "conv-1");
  assert.equal(first.id, "a", "no quota known: store order");
  await p.creds.report(target, first, { outcome: "ok", headers: quotaHeaders(60) });
  const second = await p.creds.resolve(target, 1, "conv-2");
  assert.equal(second.id, "b", "b is still untested");
  await p.creds.report(target, second, { outcome: "ok", headers: quotaHeaders(20) });
  const third = await p.creds.resolve(target, 1, "conv-3");
  assert.equal(third.id, "c");
  await p.creds.report(target, third, { outcome: "ok", headers: quotaHeaders(90) });
  const fourth = await p.creds.resolve(target, 1, "conv-4");
  assert.equal(fourth.id, "b", "the least used account wins once every account has a quota snapshot");
});

test("round-robin cycles across conversations; fill-first always takes the first usable; a pin beats both", async () => {
  const rr = pool(["a", "b", "c"], { strategy: "round-robin" });
  const picks = [];
  for (let i = 0; i < 5; i++) picks.push((await rr.creds.resolve(target, 1, `conv-${i}`)).id);
  assert.deepEqual(picks, ["a", "b", "c", "a", "b"]);

  const ff = pool(["a", "b"], { strategy: "fill-first" });
  assert.equal((await ff.creds.resolve(target, 1, "x")).id, "a");
  assert.equal((await ff.creds.resolve(target, 1, "y")).id, "a");

  const pinned = pool(["a", "b"], { strategy: "round-robin", active: "b" });
  assert.equal((await pinned.creds.resolve(target, 1, "x")).id, "b");
  assert.equal((await pinned.creds.resolve(target, 1, "y")).id, "b");
  assert.match(pinned.creds.status!().join("\n"), /b@example.com.*\[pinned\]/);
});

test("a conversation stays on its account for an hour after its last request, then the strategy picks again", async () => {
  const p = pool(["a", "b"], { strategy: "round-robin" });
  assert.equal((await p.creds.resolve(target, 1, "conv-1")).id, "a");
  assert.equal((await p.creds.resolve(target, 1, "conv-2")).id, "b");
  assert.equal((await p.creds.resolve(target, 1, "conv-1")).id, "a", "affinity, not the round robin");
  p.advance(AFFINITY_TTL_MS - 1);
  assert.equal((await p.creds.resolve(target, 1, "conv-1")).id, "a", "the TTL slides with every request");
  p.advance(AFFINITY_TTL_MS + 1);
  assert.equal((await p.creds.resolve(target, 1, "conv-1")).id, "a", "expired affinity falls back to the strategy (round robin is at a)");
  assert.equal((await p.creds.resolve(target, 1, "conv-3")).id, "b");
  assert.equal((await p.creds.resolve(target, 2)).id, "a", "no conversation id: no affinity, the strategy picks");
});

test("a usage-limit 429 cools the account down until its window resets, breaks affinity, and rotates when another account is usable", async () => {
  const lines: string[] = [];
  const p = pool(["a", "b"], { log: m => lines.push(m) });
  const first = await p.creds.resolve(target, 1, "conv-1");
  assert.equal(first.id, "a");
  const advice = await p.creds.report(target, first, { outcome: "error", error: quotaError(), headers: quotaHeaders(100, 1800), conversationId: "conv-1" });
  assert.deepEqual(advice, { retry: true, retryAfterMs: 0 });
  const cooling = (p.creds as ChatgptCredentialProvider).cooldowns().get("a")!;
  assert.equal(cooling.until, p.now() + 1800_000, "cooldown ends when the exhausted window resets");
  assert.match(lines.at(-1)!, /account a hit its usage limit; cooling down for 30m; rotating/);
  const second = await p.creds.resolve(target, 2, "conv-1");
  assert.equal(second.id, "b", "the same conversation moves to the other account");
  assert.match(p.creds.status!().join("\n"), /a@example.com.*cooling down, 30m left/);

  // b is exhausted too: nothing usable, the error says when the next account comes back.
  const advice2 = await p.creds.report(target, second, { outcome: "error", error: quotaError({ retryAfterMs: 60_000 }), conversationId: "conv-1" });
  assert.deepEqual(advice2, { retry: false, retryAfterMs: 0 });
  await assert.rejects(p.creds.resolve(target, 3, "conv-1"), (err: unknown) => err instanceof CredentialError && /at its usage limit; the next one resets in 1m/.test(err.message));

  p.advance(61_000);
  const back = await p.creds.resolve(target, 1, "conv-9");
  assert.equal(back.id, "b", "b is back after its cooldown");
  await p.creds.report(target, back, { outcome: "ok", headers: quotaHeaders(50) });
  p.advance(1800_000);
  assert.equal((await p.creds.resolve(target, 1, "conv-10")).id, "a", "a is back; its exhausted window has reset, so its stale 100% counts as empty and beats b's 50%");
});

test("a usage-limit answer without any reset hint gets the default cooldown, clamped to sane bounds", async () => {
  const p = pool(["a"]);
  const c = await p.creds.resolve(target, 1);
  await p.creds.report(target, c, { outcome: "error", error: quotaError() });
  const cooling = (p.creds as ChatgptCredentialProvider).cooldowns().get("a")!;
  assert.equal(cooling.until - p.now(), 15 * 60_000);
  await assert.rejects(p.creds.resolve(target, 2), /at its usage limit/);
});

test("a 401 refreshes once; a second 401 marks the account as needing login and rotates", async () => {
  const token = await fakeUpstream([
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: fakeJwt({ exp: FAR, fresh: true }), refresh_token: "refresh-new" }));
    },
  ]);
  try {
    const lines: string[] = [];
    const p = pool(["a", "b"], { tokenUrl: `http://127.0.0.1:${token.port}/t`, log: m => lines.push(m) });
    const first = await p.creds.resolve(target, 1, "conv-1");
    assert.equal(first.id, "a");
    assert.deepEqual(await p.creds.report(target, first, { outcome: "error", error: authError, conversationId: "conv-1" }), { retry: true });
    const refreshed = await p.creds.resolve(target, 2, "conv-1");
    assert.equal(refreshed.id, "a", "the same account with a fresh token");
    assert.notEqual(refreshed.apiKey, first.apiKey);
    assert.equal(token.calls, 1);
    assert.deepEqual(await p.creds.report(target, refreshed, { outcome: "error", error: authError, conversationId: "conv-1" }), { retry: true });
    assert.equal(loadCredentialStore(p.path).chatgpt.accounts.find(a => a.id === "a")!.needsLogin, true);
    assert.match(lines.at(-1)!, /still rejected after a token refresh; marked as needing login; rotating/);
    const third = await p.creds.resolve(target, 3, "conv-1");
    assert.equal(third.id, "b");
    assert.equal(token.calls, 1, "the other account's token was fine");
    assert.match(p.creds.status!().join("\n"), /a@example.com.*NEEDS LOGIN/);
  } finally {
    await close(token.server);
  }
});

test("a refresh that is rejected moves the conversation to another account instead of failing the request", async () => {
  const token = await fakeUpstream([
    (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
    },
  ]);
  try {
    const p = pool(["a", "b"], { tokenUrl: `http://127.0.0.1:${token.port}/t` });
    const path = p.path;
    const store = loadCredentialStore(path);
    store.chatgpt.accounts[0]!.accessToken = fakeJwt({ exp: Math.floor(p.now() / 1000) + 60 });
    saveCredentialStore(path, store);
    const credential = await p.creds.resolve(target, 1, "conv-1");
    assert.equal(credential.id, "b");
    assert.equal(loadCredentialStore(path).chatgpt.accounts[0]!.needsLogin, true);
    assert.equal(token.calls, 1);
  } finally {
    await close(token.server);
  }
});
