import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteExhaustedError, runAttempts, type AttemptOutcome } from "../src/attempt.ts";
import type { WireError } from "../src/ir.ts";

const targets = [
  { provider: "a", model: "m" },
  { provider: "b", model: "m" },
];
const policy = { maxAttemptsPerTarget: 3, baseDelayMs: 100, maxDelayMs: 1000 };
const err = (over: Partial<WireError>): WireError => ({ kind: "upstream", message: "x", provider: "a", retryable: false, ...over });

function harness(script: Array<AttemptOutcome<string>>) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const run = async (t: { provider: string }, attempt: number): Promise<AttemptOutcome<string>> => {
    calls.push(`${t.provider}#${attempt}`);
    return script.shift() ?? { ok: true, value: "fallthrough" };
  };
  const options = { sleep: async (ms: number) => void sleeps.push(ms), jitter: () => 1 };
  return { calls, sleeps, run, options };
}

test("retryable errors retry the same target with exponential backoff, then succeed", async () => {
  const h = harness([{ ok: false, error: err({ kind: "rate_limit", retryable: true }) }, { ok: false, error: err({ kind: "overloaded", retryable: true }) }, { ok: true, value: "hi" }]);
  const result = await runAttempts(targets, h.run, policy, h.options);
  assert.equal(result.value, "hi");
  assert.deepEqual(h.calls, ["a#1", "a#2", "a#3"]);
  assert.deepEqual(h.sleeps, [100, 200]);
  assert.equal(result.failures.length, 2);
});

test("retryAfterMs overrides backoff and is capped", async () => {
  const h = harness([{ ok: false, error: err({ kind: "rate_limit", retryable: true, retryAfterMs: 250 }) }, { ok: false, error: err({ kind: "rate_limit", retryable: true, retryAfterMs: 999_999 }) }, { ok: true, value: "ok" }]);
  await runAttempts(targets, h.run, policy, h.options);
  assert.deepEqual(h.sleeps, [250, 4000]);
});

test("non-retryable error moves to the next target without sleeping", async () => {
  const h = harness([{ ok: false, error: err({ kind: "auth", retryable: false }) }, { ok: true, value: "from-b" }]);
  const result = await runAttempts(targets, h.run, policy, h.options);
  assert.equal(result.target.provider, "b");
  assert.deepEqual(h.calls, ["a#1", "b#1"]);
  assert.deepEqual(h.sleeps, []);
});

test("exhaustion throws with every failure and picks the client-facing error", async () => {
  const h = harness([
    { ok: false, error: err({ kind: "rate_limit", retryable: true }) },
    { ok: false, error: err({ kind: "rate_limit", retryable: true }) },
    { ok: false, error: err({ kind: "rate_limit", retryable: true }) },
    { ok: false, error: err({ kind: "invalid_request", retryable: false, provider: "b", message: "bad schema" }) },
  ]);
  await assert.rejects(runAttempts(targets, h.run, policy, h.options), (e: unknown) => {
    assert.ok(e instanceof RouteExhaustedError);
    assert.equal(e.failures.length, 4);
    assert.equal(e.clientError?.kind, "invalid_request");
    assert.match(e.message, /2 target\(s\) failed/);
    return true;
  });
  assert.deepEqual(h.calls, ["a#1", "a#2", "a#3", "b#1"]);
});

test("an aborted signal stops before the next attempt", async () => {
  const controller = new AbortController();
  const h = harness([{ ok: false, error: err({ kind: "overloaded", retryable: true }) }]);
  const run = async (t: { provider: string }, attempt: number) => {
    const out = await h.run(t, attempt);
    controller.abort(new Error("client went away"));
    return out;
  };
  await assert.rejects(runAttempts(targets, run, policy, { ...h.options, signal: controller.signal }), /client went away/);
  assert.deepEqual(h.calls, ["a#1"]);
});
