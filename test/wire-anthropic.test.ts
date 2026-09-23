import { test } from "node:test";
import assert from "node:assert/strict";
import type { Capabilities, Event, Opaque, ProviderTarget, Turn } from "../src/ir.ts";
import { decodeOpaque, encodeOpaque } from "../src/ingress/responses.ts";
import { anthropicWire, classifyAnthropicError, decodeAnthropicStream, encodeAnthropicRequest, usageFromAnthropic } from "../src/wire/anthropic.ts";

const caps: Capabilities = { reasoning: "effort", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], tools: true, images: true, temperature: false, stream: "sse" };
const target: ProviderTarget = { name: "p", baseUrl: "https://api.example.test", apiKey: "k", headers: { "x-extra": "yes" } };
const thinking: Opaque = { provider: "p", model: "old-model", kind: "thinking", data: JSON.stringify({ thinking: "private thought", signature: "sig" }) };
const baseTurn: Turn = { model: "new-model", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
const bodyOf = (turn: Turn, c: Capabilities = caps, stream = true): Record<string, any> => JSON.parse(encodeAnthropicRequest(turn, c, target, stream).body) as Record<string, any>;

function stream(frames: Array<[string, Record<string, unknown>]>): Response {
  const text = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const start = (usage: Record<string, unknown> = { input_tokens: 3, output_tokens: 1 }): [string, Record<string, unknown>] => ["message_start", { message: { model: "returned-model", usage } }];
const blockStart = (index: number, content_block: Record<string, unknown>): [string, Record<string, unknown>] => ["content_block_start", { index, content_block }];
const delta = (index: number, value: Record<string, unknown>): [string, Record<string, unknown>] => ["content_block_delta", { index, delta: value }];
const blockStop = (index: number): [string, Record<string, unknown>] => ["content_block_stop", { index }];
const end = (stop_reason = "end_turn", usage: Record<string, unknown> = { output_tokens: 4 }): Array<[string, Record<string, unknown>]> => [["message_delta", { delta: { stop_reason }, usage }], ["message_stop", {}]];
async function collect(frames: Array<[string, Record<string, unknown>]>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of decodeAnthropicStream(stream(frames), caps, target)) events.push(event);
  return events;
}

test("encode: headers, messages, images, thinking replay, tools, and sampling", () => {
  const turn: Turn = {
    model: "new-model", system: "be brief",
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "AAA" }] },
      { role: "assistant", content: [{ type: "reasoning", opaque: thinking }, { type: "text", text: "working" }, { type: "tool_call", id: "c1", name: "shell", arguments: '{"cmd":"ls"}' }] },
      { role: "tool", callId: "c1", content: [{ type: "text", text: "listed" }, { type: "image", mediaType: "image/jpeg", data: "BBB" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ],
    tools: [{ name: "shell", description: "run", parameters: { type: "object" } }, { name: "strictly", parameters: { type: "object", required: ["input"] }, strict: true }],
    toolChoice: { name: "shell" }, parallelToolCalls: false,
    reasoning: { effort: "xhigh" }, sampling: { temperature: 0.2, topP: 0.8, maxOutputTokens: 120, stop: ["STOP"] },
  };
  const request = encodeAnthropicRequest(turn, caps, target, true);
  assert.equal(request.url, "https://api.example.test/v1/messages");
  assert.equal(request.method, "POST");
  assert.deepEqual(request.headers, { "content-type": "application/json", accept: "text/event-stream", "anthropic-version": "2023-06-01", "x-extra": "yes", "x-api-key": "k" });
  assert.deepEqual(JSON.parse(request.body), {
    model: "new-model", max_tokens: 120, system: "be brief",
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "private thought", signature: "sig" }, { type: "text", text: "working" }, { type: "tool_use", id: "c1", name: "shell", input: { cmd: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "listed" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } }] }, { type: "text", text: "thanks" }] },
    ],
    tools: [{ name: "shell", input_schema: { type: "object" }, description: "run", eager_input_streaming: true }, { name: "strictly", input_schema: { type: "object", required: ["input"] }, strict: true, eager_input_streaming: true }],
    tool_choice: { type: "tool", name: "shell", disable_parallel_tool_use: true },
    thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "xhigh" },
    stream: true, cache_control: { type: "ephemeral" }, stop_sequences: ["STOP"],
  });
  assert.equal(bodyOf(turn, { ...caps, temperature: true }).temperature, 0.2);
  assert.equal(bodyOf(turn, { ...caps, temperature: true }).top_p, 0.8);
  assert.deepEqual(bodyOf({ ...baseTurn, messages: [{ role: "user", content: [{ type: "image_url", url: "https://example.test/i" }] }] }).messages, [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.test/i" } }] }]);
  const nonstream = bodyOf(turn, caps, false);
  assert.equal(nonstream.tools[0].eager_input_streaming, undefined);
  assert.equal(encodeAnthropicRequest(turn, caps, target, false).headers.accept, "application/json");
});

test("encode: foreign and malformed thinking dropped, redacted replayed, empty blocks skipped", () => {
  const foreign = { ...thinking, provider: "elsewhere" };
  const malformed = { ...thinking, data: '{"signature":"sig"}' };
  const turn: Turn = { ...baseTurn, messages: [
    { role: "assistant", content: [{ type: "reasoning", opaque: foreign }, { type: "text", text: "   " }] },
    { role: "assistant", content: [{ type: "reasoning", opaque: malformed }] },
    { role: "assistant", content: [{ type: "reasoning", opaque: { provider: "p", kind: "redacted_thinking", data: "raw-redaction" } }, { type: "tool_call", id: "x", name: "a", arguments: "[1]" }, { type: "tool_call", id: "y", name: "b", arguments: "bad" }] },
    { role: "assistant", content: [{ type: "text", text: "next" }] },
  ] };
  assert.deepEqual(bodyOf(turn).messages, [{ role: "assistant", content: [
    { type: "redacted_thinking", data: "raw-redaction" }, { type: "tool_use", id: "x", name: "a", input: {} }, { type: "tool_use", id: "y", name: "b", input: {} }, { type: "text", text: "next" },
  ] }]);
});

test("encode: tool results lead and group, late results start another user message", () => {
  const turn: Turn = { ...baseTurn, messages: [
    { role: "tool", callId: "a", content: [{ type: "text", text: "A" }] },
    { role: "tool", callId: "b", content: [{ type: "text", text: "B" }], isError: true },
    { role: "user", content: [{ type: "text", text: "next" }] },
    { role: "tool", callId: "c", content: [{ type: "text", text: "C" }] },
    { role: "tool", callId: "d", content: [{ type: "text", text: "D" }] },
    { role: "user", content: [{ type: "text", text: "later" }] },
  ] };
  assert.deepEqual(bodyOf(turn).messages, [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "A" }, { type: "tool_result", tool_use_id: "b", content: "B", is_error: true }, { type: "text", text: "next" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "C" }, { type: "tool_result", tool_use_id: "d", content: "D" }, { type: "text", text: "later" }] },
  ]);
});

test("encode: vision off, effort clamp, no reasoning, tool choices and max token precedence", () => {
  const turn: Turn = { ...baseTurn, messages: [
    { role: "user", content: [{ type: "image", mediaType: "image/png", data: "A" }, { type: "image_url", url: "https://example.test/i" }] },
    { role: "tool", callId: "c", content: [{ type: "image", mediaType: "image/png", data: "B" }, { type: "text", text: "  " }] },
  ], tools: [{ name: "f", parameters: {} }], reasoning: { effort: "minimal" }, sampling: { maxOutputTokens: 1000, temperature: 0.5, topP: 0.7 } };
  const limited = bodyOf(turn, { ...caps, images: false, maxOutputTokens: 500 });
  assert.equal(limited.max_tokens, 500);
  assert.deepEqual(limited.messages, [{ role: "user", content: [{ type: "text", text: "[2 image(s) omitted: this model does not accept images]" }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "[1 image(s) omitted: this model does not accept images]" }] }]);
  assert.deepEqual(limited.output_config, { effort: "low" });
  assert.equal(limited.temperature, undefined);
  assert.equal(limited.top_p, undefined);
  assert.deepEqual(bodyOf({ ...turn, reasoning: { effort: "xhigh" } }, { ...caps, reasoningLevels: ["low", "high"] }).output_config, { effort: "high" });
  assert.equal(bodyOf({ ...turn, reasoning: {} }).output_config, undefined);
  assert.deepEqual(bodyOf({ ...turn, reasoning: {} }).thinking, { type: "adaptive", display: "summarized" });
  const { reasoning: _reasoning, ...withoutReasoning } = turn;
  const plain = bodyOf({ ...withoutReasoning, toolChoice: "required" });
  assert.equal(plain.thinking, undefined);
  assert.equal(plain.output_config, undefined);
  assert.deepEqual(plain.tool_choice, { type: "any" });
  assert.deepEqual(bodyOf({ ...turn, toolChoice: "none", parallelToolCalls: false }).tool_choice, { type: "none" });
  assert.deepEqual(bodyOf({ ...turn, toolChoice: "auto" }).tool_choice, { type: "auto" });
  assert.deepEqual(bodyOf({ ...withoutReasoning, parallelToolCalls: false }).tool_choice, { type: "auto", disable_parallel_tool_use: true });
  assert.equal(bodyOf(baseTurn).max_tokens, 64000);
  assert.equal(bodyOf(baseTurn, { ...caps, maxOutputTokens: 700 }).max_tokens, 700);
  assert.equal(bodyOf({ ...baseTurn, sampling: { maxOutputTokens: 400 } }, { ...caps, maxOutputTokens: 700 }).max_tokens, 400);
  assert.equal(bodyOf({ ...turn, tools: [] }).tool_choice, undefined);
  assert.equal(bodyOf(turn, { ...caps, tools: false }).tools, undefined);
});

test("encode: budget mode raises max tokens, honors override and cap; schema merges with effort", () => {
  const budget = { ...caps, reasoning: "budget" as const };
  const turn: Turn = { ...baseTurn, reasoning: { effort: "high" }, sampling: { maxOutputTokens: 100 } };
  for (const [effort, tokens] of [["low", 2048], ["medium", 8192], ["high", 16384], ["xhigh", 24576], ["max", 32768]] as const) {
    assert.equal(bodyOf({ ...turn, reasoning: { effort } }, budget).thinking.budget_tokens, tokens);
  }
  assert.deepEqual(bodyOf(turn, budget).thinking, { type: "enabled", budget_tokens: 16384 });
  assert.equal(bodyOf(turn, budget).max_tokens, 20480);
  const override = bodyOf({ ...turn, reasoning: { effort: "low", budgetTokens: 10000 } }, { ...budget, maxOutputTokens: 11000 });
  assert.deepEqual(override.thinking, { type: "enabled", budget_tokens: 9976 });
  assert.equal(override.max_tokens, 11000);
  const tooSmall = bodyOf({ ...turn, reasoning: { effort: "low" } }, { ...budget, maxOutputTokens: 2000 });
  assert.equal(tooSmall.thinking, undefined);
  assert.equal(tooSmall.max_tokens, 100);
  const roomForAnswer = bodyOf({ ...turn, reasoning: { effort: "low" } }, { ...budget, maxOutputTokens: 3000 });
  assert.equal(roomForAnswer.thinking.budget_tokens, 1976);
  assert.equal(roomForAnswer.max_tokens, 3000);
  assert.equal(bodyOf({ ...turn, reasoning: { effort: "minimal" } }, budget).thinking, undefined);
  const { reasoning: _reasoning, ...withoutReasoning } = turn;
  assert.equal(bodyOf(withoutReasoning, budget).thinking, undefined);
  assert.deepEqual(bodyOf({ ...baseTurn, reasoning: { effort: "high" }, responseFormat: { type: "json_schema", name: "result", schema: { type: "object" } } }).output_config, { effort: "high", format: { type: "json_schema", schema: { type: "object" } } });
  assert.deepEqual(bodyOf({ ...baseTurn, responseFormat: { type: "json_schema", name: "result", schema: { type: "object" } } }).output_config, { format: { type: "json_schema", schema: { type: "object" } } });
});

test("decode: thinking, omitted display, redacted block, text, tools and cache usage", async () => {
  const events = await collect([
    start({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 1 }),
    blockStart(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "thinking_delta", thinking: "think " }), delta(0, { type: "thinking_delta", thinking: "more" }),
    delta(0, { type: "signature_delta", signature: "si" }), delta(0, { type: "signature_delta", signature: "g" }), blockStop(0),
    blockStart(1, { type: "thinking", thinking: "", signature: "" }), delta(1, { type: "signature_delta", signature: "hidden" }), blockStop(1),
    blockStart(2, { type: "redacted_thinking", data: "secret" }), blockStop(2),
    blockStart(3, { type: "text", text: "" }), delta(3, { type: "text_delta", text: "answer" }), blockStop(3),
    blockStart(4, { type: "tool_use", id: "a", name: "shell", input: {} }),
    delta(4, { type: "input_json_delta", partial_json: '{"cmd":' }), delta(4, { type: "input_json_delta", partial_json: '"ls"}' }), blockStop(4),
    blockStart(5, { type: "tool_use", id: "b", name: "other", input: { value: 1 } }), blockStop(5),
    blockStart(6, { type: "tool_use", id: "c", name: "empty", input: {} }), blockStop(6),
    ...end("tool_use", { output_tokens: 17 }),
  ]);
  assert.deepEqual(events, [
    { type: "reasoning_delta", text: "think " }, { type: "reasoning_delta", text: "more" },
    { type: "reasoning_opaque", opaque: { provider: "p", model: "returned-model", kind: "thinking", data: '{"thinking":"think more","signature":"sig"}' } },
    { type: "reasoning_opaque", opaque: { provider: "p", model: "returned-model", kind: "thinking", data: '{"thinking":"","signature":"hidden"}' } },
    { type: "reasoning_opaque", opaque: { provider: "p", model: "returned-model", kind: "redacted_thinking", data: "secret" } },
    { type: "text_delta", text: "answer" },
    { type: "tool_call_start", id: "a", name: "shell" }, { type: "tool_call_delta", id: "a", argumentsDelta: '{"cmd":' }, { type: "tool_call_delta", id: "a", argumentsDelta: '"ls"}' }, { type: "tool_call_end", id: "a" },
    { type: "tool_call_start", id: "b", name: "other" }, { type: "tool_call_delta", id: "b", argumentsDelta: '{"value":1}' }, { type: "tool_call_end", id: "b" },
    { type: "tool_call_start", id: "c", name: "empty" }, { type: "tool_call_delta", id: "c", argumentsDelta: "{}" }, { type: "tool_call_end", id: "c" },
    { type: "done", stopReason: "tool_use", usage: { inputTokens: 60, outputTokens: 17, cachedInputTokens: 20, cacheWriteTokens: 30 } },
  ]);
});

test("decode: partial delta usage preserves cached counts and replaces supplied input fields", async () => {
  assert.deepEqual(usageFromAnthropic({ cache_read_input_tokens: 3 }), { inputTokens: 3, outputTokens: 0, cachedInputTokens: 3 });
  const events = await collect([start({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 1 }), ...end("end_turn", { input_tokens: 12, output_tokens: 0 })]);
  assert.deepEqual(events.at(-1), { type: "done", stopReason: "end_turn", usage: { inputTokens: 62, outputTokens: 0, cachedInputTokens: 20, cacheWriteTokens: 30 } });
  const cacheDelta = await collect([start({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 1 }), ...end("end_turn", { cache_read_input_tokens: 22, output_tokens: 2 })]);
  assert.deepEqual(cacheDelta.at(-1), { type: "done", stopReason: "end_turn", usage: { inputTokens: 62, outputTokens: 2, cachedInputTokens: 22, cacheWriteTokens: 30 } });
});

test("decode: text and thinking present at block start are emitted", async () => {
  const events = await collect([start(), blockStart(0, { type: "thinking", thinking: "first", signature: "sig" }), delta(0, { type: "thinking_delta", thinking: " second" }), blockStop(0), blockStart(1, { type: "text", text: "hello" }), delta(1, { type: "text_delta", text: " world" }), blockStop(1), ...end()]);
  assert.deepEqual(events.slice(0, 5), [
    { type: "reasoning_delta", text: "first" }, { type: "reasoning_delta", text: " second" },
    { type: "reasoning_opaque", opaque: { provider: "p", model: "returned-model", kind: "thinking", data: '{"thinking":"first second","signature":"sig"}' } },
    { type: "text_delta", text: "hello" }, { type: "text_delta", text: " world" },
  ]);
});

test("decode: stop reasons, unknown blocks, mid-stream error and truncation", async () => {
  for (const [upstream, mapped] of [["end_turn", "end_turn"], ["stop_sequence", "end_turn"], ["pause_turn", "end_turn"], ["tool_use", "tool_use"], ["max_tokens", "max_tokens"], ["refusal", "content_filter"]]) {
    const events = await collect([start(), ...end(upstream)]);
    assert.equal((events.at(-1) as { stopReason: string }).stopReason, mapped);
  }
  const unknown = await collect([start(), blockStart(0, { type: "server_tool_use" }), delta(0, { type: "text_delta", text: "ignore" }), delta(0, { type: "input_json_delta", partial_json: "{}" }), blockStop(0), ...end()]);
  assert.deepEqual(unknown, [{ type: "done", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4 } }]);
  const failed = await collect([start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "before" }), ["error", { error: { type: "overloaded_error", message: "busy" } }], ...end()]);
  assert.deepEqual(failed.map(e => e.type), ["text_delta", "error"]);
  assert.deepEqual(failed[1], { type: "error", error: { kind: "overloaded", message: "busy", provider: "p", status: 200, retryable: true } });
  const empty = await collect([start(), ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }]]);
  assert.deepEqual(empty, [{ type: "error", error: { kind: "upstream", message: "the stream ended without message_stop", provider: "p", retryable: true } }]);
  const partial = await collect([start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "partial" }), ["message_delta", { delta: { stop_reason: "end_turn" } }]]);
  assert.equal(partial.at(-1)?.type, "error");
  assert.equal((partial.at(-1) as { error: { retryable: boolean } }).error.retryable, false);
});

test("thinking Opaque round trip through the Responses envelope reproduces the block", async () => {
  const events = await collect([start(), blockStart(0, { type: "thinking", thinking: "", signature: "" }), delta(0, { type: "thinking_delta", thinking: "thought" }), delta(0, { type: "signature_delta", signature: "sig" }), blockStop(0), ...end()]);
  const opaque = (events.find(e => e.type === "reasoning_opaque") as Extract<Event, { type: "reasoning_opaque" }>).opaque;
  const echoed = decodeOpaque(encodeOpaque(opaque));
  assert.deepEqual(echoed, opaque);
  assert.deepEqual(bodyOf({ ...baseTurn, messages: [{ role: "assistant", content: [{ type: "reasoning", opaque: echoed }] }] }).messages, [{ role: "assistant", content: [{ type: "thinking", thinking: "thought", signature: "sig" }] }]);
});

test("classify: status, error type, retry-after and non-JSON bodies", () => {
  const cases: Array<[number, string, string, boolean]> = [
    [401, "authentication_error", "auth", false], [403, "permission_error", "auth", false], [402, "billing_error", "quota", false],
    [404, "not_found_error", "not_found", false], [429, "rate_limit_error", "rate_limit", true], [413, "request_too_large", "context_length", false],
    [400, "invalid_request_error", "invalid_request", false], [529, "overloaded_error", "overloaded", true], [500, "api_error", "upstream", true],
  ];
  for (const [status, type, kind, retryable] of cases) {
    const error = classifyAnthropicError(status, new Headers(), JSON.stringify({ type: "error", error: { type, message: "message" } }), "p");
    assert.equal(error.kind, kind, `${status} ${type}`);
    assert.equal(error.retryable, retryable);
    assert.equal(error.message, "message");
  }
  for (const [message, kind] of [["prompt is too long", "context_length"], ["credit balance is too low", "quota"], ["invalid parameter", "invalid_request"]]) {
    assert.equal(classifyAnthropicError(400, new Headers(), JSON.stringify({ error: { type: "invalid_request_error", message } }), "p").kind, kind);
  }
  assert.equal(classifyAnthropicError(400, new Headers(), JSON.stringify({ error: { message: "model not found" } }), "p").kind, "invalid_request");
  assert.equal(classifyAnthropicError(400, new Headers(), JSON.stringify({ error: { type: "billing_error", message: "pay" } }), "p").kind, "quota");
  assert.equal(classifyAnthropicError(200, new Headers(), JSON.stringify({ error: { type: "not_found_error", message: "gone" } }), "p").kind, "not_found");
  assert.equal(classifyAnthropicError(200, new Headers(), JSON.stringify({ error: { type: "overloaded_error", message: "busy" } }), "p").kind, "overloaded");
  assert.equal(classifyAnthropicError(429, new Headers({ "retry-after": "2" }), "slow", "p", 0).retryAfterMs, 2000);
  assert.deepEqual(classifyAnthropicError(500, new Headers(), "not JSON", "p"), { kind: "upstream", message: "not JSON", provider: "p", status: 500, retryable: true });
});

test("modelsRequest: Anthropic URL and headers; parseModels reads data ids", () => {
  assert.deepEqual(anthropicWire.modelsRequest?.(target), { url: "https://api.example.test/v1/models", headers: { accept: "application/json", "anthropic-version": "2023-06-01", "x-extra": "yes", "x-api-key": "k" } });
  assert.deepEqual(anthropicWire.parseModels?.({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }, { display_name: "missing" }] }), ["model-a", "model-b"]);
  assert.deepEqual(anthropicWire.parseModels?.({ models: [{ slug: "other" }] }), []);
});

test("passthroughHeaders injects the protocol version and configured key only", () => {
  assert.deepEqual(anthropicWire.passthroughHeaders?.(target), { "x-api-key": "k", "anthropic-version": "2023-06-01" });
  assert.deepEqual(anthropicWire.passthroughHeaders?.({ name: "p", baseUrl: "https://api.example.test" }), { "anthropic-version": "2023-06-01" });
});
