import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyResponsesError, retryAfterMsFrom, upstreamErrorMessage } from "../src/wire/openai-responses.ts";

const h = (init?: Record<string, string>): Headers => new Headers(init ?? {});

test("status and body map to one kind each", () => {
  const cases: Array<[number, string, string, boolean]> = [
    [401, '{"error":{"message":"bad token"}}', "auth", false],
    [403, "", "auth", false],
    [402, "", "quota", false],
    [429, '{"error":{"type":"usage_limit_reached","message":"You have hit your usage limit"}}', "quota", false],
    [429, '{"error":{"message":"Rate limit reached"}}', "rate_limit", true],
    [400, '{"error":{"message":"This model\'s maximum context length is 128000 tokens"}}', "context_length", false],
    [400, '{"error":{"message":"Invalid value for input"}}', "invalid_request", false],
    [404, "", "not_found", false],
    [500, "boom", "upstream", true],
    [502, "", "upstream", true],
    [503, "", "overloaded", true],
    [529, "", "overloaded", true],
  ];
  for (const [status, body, kind, retryable] of cases) {
    const e = classifyResponsesError(status, h(), body, "p");
    assert.equal(e.kind, kind, `${status} ${body}`);
    assert.equal(e.retryable, retryable, `${status} ${body}`);
    assert.equal(e.provider, "p");
    assert.equal(e.status, status);
  }
});

test("the recorded Codex backend 400 for an unknown model classifies as not_found with the detail text", () => {
  const body = readFileSync(new URL("./fixtures/responses/classic/unknown-model-400.response.sse", import.meta.url), "utf8");
  const e = classifyResponsesError(400, h({ "content-type": "application/json" }), body, "chatgpt");
  assert.equal(e.kind, "not_found");
  assert.match(e.message, /deepseek-v4.*not supported/);
});

test("retry-after in seconds, milliseconds, or as a date", () => {
  assert.equal(retryAfterMsFrom(h({ "retry-after": "2" })), 2000);
  assert.equal(retryAfterMsFrom(h({ "retry-after-ms": "250" })), 250);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(retryAfterMsFrom(h({ "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" }), now), 5000);
  assert.equal(retryAfterMsFrom(h()), undefined);
  assert.equal(classifyResponsesError(429, h({ "retry-after": "3" }), "", "p").retryAfterMs, 3000);
});

test("error messages come from OpenAI, backend detail, or raw text", () => {
  assert.deepEqual(upstreamErrorMessage('{"error":{"message":"m","code":"c","type":"t"}}'), { message: "m", code: "c", type: "t" });
  assert.deepEqual(upstreamErrorMessage('{"detail":"d"}'), { message: "d" });
  assert.deepEqual(upstreamErrorMessage('{"detail":{"message":"dm","code":"dc"}}'), { message: "dm", code: "dc" });
  assert.deepEqual(upstreamErrorMessage("plain"), { message: "plain" });
  assert.deepEqual(upstreamErrorMessage("   "), { message: "" });
});
