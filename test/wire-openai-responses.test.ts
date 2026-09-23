import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Capabilities, Event, Turn } from "../src/ir.ts";
import { classifyResponsesError, decodeResponsesStream, encodeResponsesRequest, openaiResponsesWire, retryAfterMsFrom, upstreamErrorMessage } from "../src/wire/openai-responses.ts";

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

const caps: Capabilities = { reasoning: "effort", reasoningLevels: ["low", "medium", "high"], tools: true, images: true, temperature: true, stream: "sse" };
const target = { name: "p", baseUrl: "https://example.test/v1", apiKey: "secret", headers: { "x-custom": "ok" } };
const frame = (type: string, fields: Record<string, unknown> = {}): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const decode = async (sse: string): Promise<Event[]> => {
  const response = new Response(sse, { headers: { "content-type": "text/event-stream" } });
  const events: Event[] = [];
  for await (const event of decodeResponsesStream(response, caps, target)) events.push(event);
  return events;
};

test("encode: messages, tools, replay, controls, and private fields", () => {
  const turn: Turn = {
    model: "m", system: "instructions", metadata: { conversationId: "private" },
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", mediaType: "image/png", data: "YWJj" }, { type: "image_url", url: "https://example.test/a.png" }] },
      { role: "assistant", content: [
        { type: "text", text: "working" },
        { type: "reasoning", text: "do not replay this summary", opaque: { provider: "p", model: "m", kind: "encrypted_reasoning", data: "cipher" } },
        { type: "reasoning", opaque: { provider: "other", kind: "encrypted_reasoning", data: "foreign" } },
        { type: "reasoning", text: "plain" },
        { type: "tool_call", id: "call_1", name: "apply_patch", arguments: '{"input":"patch"}' },
      ] },
      { role: "tool", callId: "call_1", content: [{ type: "text", text: "done" }, { type: "image", mediaType: "image/png", data: "eA==" }] },
    ],
    tools: [{ name: "apply_patch", description: "patch", parameters: { type: "object", required: ["input"] }, strict: true }],
    toolChoice: { name: "apply_patch" }, parallelToolCalls: false,
    reasoning: { effort: "max", summary: "auto" }, sampling: { temperature: 0.5, topP: 0.9, maxOutputTokens: 100 },
    responseFormat: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true },
  };
  const request = encodeResponsesRequest(turn, caps, target, true);
  assert.equal(request.url, "https://example.test/v1/responses");
  assert.equal(request.headers.authorization, "Bearer secret");
  assert.equal(request.headers["x-custom"], "ok");
  const body = JSON.parse(request.body) as Record<string, any>;
  assert.equal(body.instructions, "instructions");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(body.input[0].content, [
    { type: "input_text", text: "hi" },
    { type: "input_image", image_url: "data:image/png;base64,YWJj", detail: "auto" },
    { type: "input_image", image_url: "https://example.test/a.png", detail: "auto" },
  ]);
  assert.deepEqual(body.input[1], { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] });
  assert.deepEqual(body.input[2], { type: "reasoning", id: "rs_0", summary: [], encrypted_content: "cipher" });
  assert.deepEqual(body.input[3], { type: "function_call", call_id: "call_1", name: "apply_patch", arguments: '{"input":"patch"}' });
  assert.deepEqual(body.input[4], { type: "function_call_output", call_id: "call_1", output: "done\n[image attached in the next message]" });
  assert.equal(body.input[5].content[1].type, "input_image");
  assert.deepEqual(body.tools, [{ type: "function", name: "apply_patch", description: "patch", parameters: { type: "object", required: ["input"] }, strict: true }]);
  assert.deepEqual(body.tool_choice, { type: "function", name: "apply_patch" });
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.equal(body.max_output_tokens, 100);
  assert.equal(body.temperature, 0.5);
  assert.equal(body.top_p, 0.9);
  assert.deepEqual(body.text, { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } });
  for (const field of ["client_metadata", "prompt_cache_key", "previous_response_id", "namespace"]) assert.equal(body[field], undefined);
});

test("encode: required and none choices, minimal effort, disabled capabilities", () => {
  const turn: Turn = { model: "m", messages: [{ role: "user", content: [{ type: "image_url", url: "https://x" }] }], tools: [{ name: "f", parameters: {} }], toolChoice: "required", reasoning: { effort: "minimal" }, sampling: { temperature: 1, topP: 1 } };
  const body = JSON.parse(encodeResponsesRequest(turn, caps, target, false).body) as Record<string, any>;
  assert.equal(body.tool_choice, "required");
  assert.deepEqual(body.reasoning, { effort: "minimal" });
  const xhigh = JSON.parse(encodeResponsesRequest({ ...turn, reasoning: { effort: "xhigh" as never } }, caps, target, false).body) as Record<string, any>;
  assert.equal(xhigh.reasoning.effort, "high");
  assert.equal(body.stream, false);
  const limited = JSON.parse(encodeResponsesRequest({ ...turn, toolChoice: "none" }, { ...caps, tools: false, images: false, temperature: false }, target, true).body) as Record<string, any>;
  assert.equal(limited.tools, undefined);
  assert.equal(limited.tool_choice, undefined);
  assert.equal(limited.temperature, undefined);
  assert.equal(limited.top_p, undefined);
  assert.match(limited.input[0].content[0].text, /image.*omitted/);
  assert.deepEqual(JSON.parse(encodeResponsesRequest({ ...turn, toolChoice: "none" }, caps, target, true).body).tool_choice, "none");
});

test("decode: recorded function-call turn has one end, raw arguments and normalized usage", async () => {
  const sse = readFileSync(new URL("./fixtures/responses/classic/turn-1-first.response.sse", import.meta.url), "utf8");
  const events = await decode(sse);
  const start = events.find(e => e.type === "tool_call_start");
  assert.ok(start);
  assert.equal(start.name, "exec_command");
  assert.equal(events.filter(e => e.type === "tool_call_end").length, 1);
  const args = events.filter(e => e.type === "tool_call_delta").map(e => e.argumentsDelta).join("");
  assert.equal(JSON.parse(args).cmd, "ls -la");
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type === "done") {
    assert.equal(done.stopReason, "tool_use");
    assert.ok(done.usage?.inputTokens);
    assert.ok(done.usage?.cachedInputTokens !== undefined);
  }
});

test("decode: recorded text turn follows output_text.delta and completes", async () => {
  const events = await decode(readFileSync(new URL("./fixtures/responses/classic/hello.response.sse", import.meta.url), "utf8"));
  assert.equal(events.filter(e => e.type === "text_delta").map(e => e.text).join(""), "hello");
  assert.equal(events.at(-1)?.type, "done");
});

test("decode: reasoning opaque, summary, fallback tool end, incomplete and error terminals", async () => {
  const reasoning = await decode(
    frame("response.created", { response: { model: "m" } }) +
    frame("response.reasoning_summary_text.delta", { delta: "thought" }) +
    frame("response.output_item.done", { item: { type: "reasoning", encrypted_content: "cipher" } }) +
    frame("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "c", name: "f" } }) +
    frame("response.function_call_arguments.delta", { item_id: "fc_1", delta: '{"x":' }) +
    frame("response.function_call_arguments.done", { item_id: "fc_1", arguments: '{"x":1}' }) +
    frame("response.completed", { response: { status: "completed", usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 3 } } } }),
  );
  assert.deepEqual(reasoning.slice(0, 2), [
    { type: "reasoning_delta", text: "thought" },
    { type: "reasoning_opaque", opaque: { provider: "p", model: "m", kind: "encrypted_reasoning", data: "cipher" } },
  ]);
  assert.equal(reasoning.filter(e => e.type === "tool_call_end").length, 1);
  assert.equal(reasoning.filter(e => e.type === "tool_call_delta").map(e => e.argumentsDelta).join(""), '{"x":1}');
  assert.deepEqual(reasoning.at(-1), { type: "done", stopReason: "tool_use", usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 5, cacheWriteTokens: 2, reasoningTokens: 3 } });
  for (const [reason, stop] of [["max_output_tokens", "max_tokens"], ["content_filter", "content_filter"]]) {
    const events = await decode(frame("response.incomplete", { response: { incomplete_details: { reason } } }));
    assert.deepEqual(events, [{ type: "done", stopReason: stop }]);
  }
  for (const [code, kind, retryable] of [["rate_limit_exceeded", "rate_limit", true], ["context_length_exceeded", "context_length", false], ["server_error", "upstream", true], ["bad", "invalid_request", false]] as const) {
    const events = await decode(frame("response.failed", { response: { error: { code, message: "failed" } } }));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    if (events[0]?.type === "error") { assert.equal(events[0].error.kind, kind); assert.equal(events[0].error.retryable, retryable); }
  }
  const direct = await decode(frame("error", { error: { code: "rate_limit_exceeded", message: "slow" } }));
  assert.equal(direct[0]?.type, "error");
  if (direct[0]?.type === "error") assert.equal(direct[0].error.kind, "rate_limit");
});

test("decode: unterminated streams are retryable only before output", async () => {
  const empty = await decode(frame("response.created"));
  const partial = await decode(frame("response.output_text.delta", { delta: "x" }));
  const callOnly = await decode(frame("response.output_item.added", { item: { type: "function_call", id: "fc", call_id: "c", name: "f" }, output_index: 0 }) + frame("response.function_call_arguments.done", { item_id: "fc", arguments: "{}" }));
  assert.equal(empty[0]?.type, "error");
  const last = partial.at(-1);
  assert.equal(last?.type, "error");
  if (empty[0]?.type === "error" && last?.type === "error") {
    assert.equal(empty[0].error.retryable, true);
    assert.equal(last.error.retryable, false);
  }
  assert.deepEqual(callOnly.map(e => e.type), ["tool_call_start", "tool_call_delta", "tool_call_end", "error"]);
});

test("passthroughHeaders injects Bearer auth only when a key is present", () => {
  assert.deepEqual(openaiResponsesWire.passthroughHeaders?.({ name: "p", baseUrl: "https://api.example.test", apiKey: "k" }), { authorization: "Bearer k" });
  assert.deepEqual(openaiResponsesWire.passthroughHeaders?.({ name: "p", baseUrl: "https://api.example.test" }), {});
});
