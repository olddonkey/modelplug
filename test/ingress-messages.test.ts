import { test } from "node:test";
import assert from "node:assert/strict";
import type { Capabilities, Event, ResponseSink } from "../src/ir.ts";
import { parseMessagesRequest, respondMessages } from "../src/ingress/messages.ts";
import { decodeOpaqueEnvelope, encodeOpaque, IngressError } from "../src/ingress/responses.ts";
import { encodeAnthropicRequest } from "../src/wire/anthropic.ts";

const base = (extra: Record<string, unknown> = {}) => ({ model: "m", messages: [{ role: "user", content: "hi" }], ...extra });
const sig = (thinking: string, signature: string) => encodeOpaque({ provider: "anth", model: "m", kind: "thinking", data: JSON.stringify({ thinking, signature }) });

test("parse: system text blocks, user string and image blocks, sampling, metadata and ignored fields", () => {
  const parsed = parseMessagesRequest(base({
    system: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }, { type: "text", text: "second" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }, { type: "image", source: { type: "url", url: "https://x/image" } }] }],
    max_tokens: 100, temperature: 0.2, top_p: 0.9, top_k: 5, stop_sequences: ["STOP"], metadata: { user_id: "session" }, stream: true,
    context_management: {}, mcp_servers: [], container: {}, betas: [], fallbacks: [], speed: "fast", service_tier: "auto",
  }));
  assert.equal(parsed.modelRef, "m");
  assert.equal(parsed.turn.system, "first\n\nsecond");
  assert.deepEqual(parsed.turn.messages, [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", mediaType: "image/png", data: "abc" }, { type: "image_url", url: "https://x/image" }] }]);
  assert.deepEqual(parsed.turn.sampling, { maxOutputTokens: 100, temperature: 0.2, topP: 0.9, stop: ["STOP"] });
  assert.deepEqual(parsed.turn.metadata, { conversationId: "session" });
  assert.equal(parsed.stream, true);
  assert.equal(parseMessagesRequest(base({ system: "plain" })).turn.system, "plain");
  assert.equal(parseMessagesRequest(base()).stream, false);
});

test("parse: parallel tool loop puts named results before remaining user blocks", () => {
  const parsed = parseMessagesRequest(base({ messages: [
    { role: "user", content: "run both" },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "shell", input: { cmd: "ls" } }, { type: "tool_use", id: "c2", name: "read", input: { path: "a" } }] },
    { role: "user", content: [{ type: "text", text: "after" }, { type: "tool_result", tool_use_id: "c1", content: "ok" }, { type: "tool_result", tool_use_id: "c2", content: [{ type: "text", text: "file" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }], is_error: true }] },
  ] }));
  assert.deepEqual(parsed.turn.messages.map(m => m.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.deepEqual(parsed.turn.messages[1], { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "shell", arguments: '{"cmd":"ls"}' }, { type: "tool_call", id: "c2", name: "read", arguments: '{"path":"a"}' }] });
  assert.deepEqual(parsed.turn.messages[2], { role: "tool", callId: "c1", name: "shell", content: [{ type: "text", text: "ok" }] });
  assert.deepEqual(parsed.turn.messages[3], { role: "tool", callId: "c2", name: "read", content: [{ type: "text", text: "file" }, { type: "image", mediaType: "image/png", data: "abc" }], isError: true });
  assert.deepEqual(parsed.turn.messages[4], { role: "user", content: [{ type: "text", text: "after" }] });
});

test("parse: thinking envelope survives, foreign signatures and redacted blocks are dropped", () => {
  const redacted = encodeOpaque({ provider: "anth", model: "m", kind: "redacted_thinking", data: "secret" });
  const parsed = parseMessagesRequest(base({ messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "thought", signature: sig("thought", "signed") },
      { type: "thinking", thinking: "visible", signature: "abc" },
      { type: "redacted_thinking", data: redacted },
      { type: "redacted_thinking", data: "foreign" },
      { type: "fallback" }, { type: "compaction" }, { type: "server_tool_use" }, { type: "web_search_tool_result" },
      { type: "text", text: "answer" },
    ] },
  ] }));
  assert.deepEqual(parsed.turn.messages[1], { role: "assistant", content: [
    { type: "reasoning", text: "thought", opaque: { provider: "anth", model: "m", kind: "thinking", data: JSON.stringify({ thinking: "thought", signature: "signed" }) } },
    { type: "reasoning", text: "visible" },
    { type: "reasoning", opaque: { provider: "anth", model: "m", kind: "redacted_thinking", data: "secret" } },
    { type: "text", text: "answer" },
  ] });
  assert.equal(parsed.lowering.warnings.length, 6);
});

test("parse: call-bound envelopes attach before or after tool_use and prefer the current assistant", () => {
  const opaque = { provider: "p", kind: "thought_signature", data: "sig-1" };
  const envelope = encodeOpaque(opaque, "call-1");
  for (const bound of [
    [{ type: "tool_use", id: "call-1", name: "apply_patch", input: {} }, { type: "redacted_thinking", data: envelope }],
    [{ type: "redacted_thinking", data: envelope }, { type: "tool_use", id: "call-1", name: "apply_patch", input: {} }],
    [{ type: "thinking", thinking: "hidden", signature: envelope }, { type: "tool_use", id: "call-1", name: "apply_patch", input: {} }],
  ]) {
    const parsed = parseMessagesRequest(base({ messages: [
      { role: "user", content: "patch" },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "old", input: {} }] },
      { role: "assistant", content: bound },
    ] }));
    assert.deepEqual(parsed.turn.messages[1], { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "old", arguments: "{}" }] });
    assert.deepEqual(parsed.turn.messages[2], { role: "assistant", content: [
      ...(bound[0]?.type === "thinking" ? [{ type: "reasoning", text: "hidden" }] : []),
      { type: "tool_call", id: "call-1", name: "apply_patch", arguments: "{}", opaque },
    ] });
    assert.deepEqual(parsed.lowering.warnings, []);
  }
  const earlier = parseMessagesRequest(base({ messages: [
    { role: "user", content: "patch" },
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "old", input: {} }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "new", input: {} }] },
    { role: "assistant", content: [{ type: "redacted_thinking", data: envelope }] },
  ] }));
  assert.deepEqual(earlier.turn.messages[1], { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "old", arguments: "{}" }] });
  assert.deepEqual(earlier.turn.messages[2], { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "new", arguments: "{}", opaque }] });
  assert.deepEqual(earlier.lowering.warnings, []);
});

test("parse: unbound envelopes remain reasoning; unknown call ids are dropped with warnings", () => {
  const opaque = { provider: "p", kind: "thought_signature", data: "sig-1" };
  const unbound = encodeOpaque(opaque);
  const unknown = encodeOpaque(opaque, "missing");
  const parsed = parseMessagesRequest(base({ messages: [
    { role: "user", content: "patch" },
    { role: "assistant", content: [
      { type: "redacted_thinking", data: unbound },
      { type: "thinking", thinking: "visible", signature: unbound },
      { type: "redacted_thinking", data: unknown },
      { type: "thinking", thinking: "dropped", signature: unknown },
    ] },
  ] }));
  assert.deepEqual(parsed.turn.messages[1], { role: "assistant", content: [
    { type: "reasoning", opaque },
    { type: "reasoning", text: "visible", opaque },
  ] });
  assert.equal(parsed.lowering.warnings.length, 2);
  assert.ok(parsed.lowering.warnings.every(warning => warning.includes("missing")));
});

test("parse: tools, choice, adaptive and budget reasoning, format", () => {
  const parsed = parseMessagesRequest(base({
    tools: [{ name: "shell", description: "runs", input_schema: { type: "object" }, strict: true }, { type: "custom", name: "read", input_schema: { type: "object" } }, { type: "bash_20250124", name: "bash" }, { type: "mcp_toolset", name: "remote" }],
    tool_choice: { type: "tool", name: "shell", disable_parallel_tool_use: true },
    thinking: { type: "adaptive" }, output_config: { effort: "xhigh", format: { type: "json_schema", schema: { type: "object" } } },
  }));
  assert.deepEqual(parsed.turn.tools, [{ name: "shell", description: "runs", parameters: { type: "object" }, strict: true }, { name: "read", parameters: { type: "object" } }]);
  assert.deepEqual(parsed.lowering.droppedTools, ["bash_20250124", "mcp_toolset"]);
  assert.deepEqual(parsed.turn.toolChoice, { name: "shell" });
  assert.equal(parsed.turn.parallelToolCalls, false);
  assert.deepEqual(parsed.turn.reasoning, { effort: "xhigh" });
  assert.deepEqual(parsed.turn.responseFormat, { type: "json_schema", name: "response", schema: { type: "object" } });
  assert.deepEqual(parseMessagesRequest(base({ thinking: { type: "adaptive" } })).turn.reasoning, { effort: "high" });
  assert.deepEqual(parseMessagesRequest(base({ output_config: { effort: "low" } })).turn.reasoning, { effort: "low" });
  assert.equal(parseMessagesRequest(base({ thinking: { type: "disabled" }, output_config: { effort: "low" } })).turn.reasoning, undefined);
  for (const [budget, effort] of [[2048, "low"], [8192, "medium"], [16384, "high"], [24576, "xhigh"], [24577, "max"]] as const) {
    assert.deepEqual(parseMessagesRequest(base({ thinking: { type: "enabled", budget_tokens: budget } })).turn.reasoning, { budgetTokens: budget, effort });
  }
  assert.equal(parseMessagesRequest(base({ thinking: { type: "disabled" } })).turn.reasoning, undefined);
  for (const [input, output] of [["auto", "auto"], ["any", "required"], ["none", "none"]] as const) {
    assert.equal(parseMessagesRequest(base({ tool_choice: { type: input } })).turn.toolChoice, output);
  }
});

test("parse: rejects missing model, empty content, role violations, document and unknown blocks", () => {
  const check = (body: unknown, code: string, pattern: RegExp) => assert.throws(() => parseMessagesRequest(body), (err: unknown) => err instanceof IngressError && err.status === 400 && err.code === code && pattern.test(err.message));
  check({}, "invalid_request", /model/);
  check(base({ messages: [] }), "invalid_request", /non-empty/);
  check(base({ messages: [{ role: "assistant", content: "hi" }] }), "invalid_request", /user/);
  assert.deepEqual(parseMessagesRequest(base({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "assistant", content: "c" }] })).turn.messages, [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "user", content: [{ type: "text", text: "b" }] },
    { role: "assistant", content: [{ type: "text", text: "c" }] },
  ]);
  check(base({ messages: [{ role: "user", content: [] }] }), "invalid_request", /empty/);
  check(base({ messages: [{ role: "user", content: "" }] }), "invalid_request", /empty/);
  check(base({ messages: [{ role: "user", content: [{ type: "document" }] }] }), "unsupported", /document/);
  check(base({ messages: [{ role: "user", content: [{ type: "mystery" }] }] }), "unsupported", /mystery/);
  check(base({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "mystery" }] }] }), "unsupported", /mystery/);
});

function sinkCollector() {
  let status: number | undefined;
  let headers: Record<string, string> = {};
  let output = "";
  let ended = false;
  const sink: ResponseSink = { status(code, h) { status = code; headers = h; }, write(chunk) { output += chunk; }, end() { ended = true; } };
  return { sink, status: () => status, headers: () => headers, text: () => output, ended: () => ended, frames: () => output.split("\n\n").filter(Boolean).map(frame => {
    const lines = frame.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^event: /);
    assert.match(lines[1]!, /^data: /);
    return { event: lines[0]!.slice(7), data: JSON.parse(lines[1]!.slice(6)) as Record<string, unknown> };
  }) };
}
async function* from(events: Event[]): AsyncGenerator<Event> { for (const event of events) yield event; }
const parsed = (stream = true) => parseMessagesRequest(base({ stream }));
const done = (stopReason: "end_turn" | "tool_use" | "max_tokens" | "content_filter" | "cancelled" = "end_turn"): Event => ({ type: "done", stopReason });
const emitted = async (events: Event[], stream = true) => { const c = sinkCollector(); await respondMessages(from(events), parsed(stream), c.sink); assert.equal(c.ended(), true); return c; };

test("respond: text-only SSE sequence, indices, ID, null stop_sequence and cache-adjusted usage", async () => {
  const c = await emitted([{ type: "text_delta", text: "hel" }, { type: "text_delta", text: "lo" }, { type: "done", stopReason: "end_turn", usage: { inputTokens: 20, cachedInputTokens: 4, cacheWriteTokens: 3, outputTokens: 5 } }]);
  assert.equal(c.status(), 200);
  assert.match(c.headers()["content-type"]!, /text\/event-stream/);
  assert.deepEqual(c.frames().map(f => f.event), ["message_start", "ping", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  const start = c.frames()[0]!.data.message as Record<string, unknown>;
  assert.match(start.id as string, /^msg_[0-9a-f]{24}$/);
  assert.equal(start.stop_sequence, null);
  assert.deepEqual(start.usage, { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(c.frames()[2]!.data, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  assert.deepEqual(c.frames().at(-2)!.data, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 13, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5 } });
});

test("respond: thinking signature, display-omitted thinking and redacted thinking", async () => {
  const opaque = { provider: "anth", kind: "thinking", data: "blob" };
  const redacted = { provider: "anth", kind: "redacted_thinking", data: "hidden" };
  const c = await emitted([{ type: "reasoning_delta", text: "think" }, { type: "reasoning_opaque", opaque }, { type: "reasoning_opaque", opaque }, { type: "reasoning_opaque", opaque: redacted }, { type: "text_delta", text: "answer" }, done()]);
  assert.deepEqual(c.frames().filter(f => f.event === "content_block_start").map(f => f.data.index), [0, 1, 2, 3]);
  assert.deepEqual(c.frames().filter(f => f.event === "content_block_delta" && (f.data.delta as Record<string, unknown>).type === "signature_delta").map(f => (f.data.delta as Record<string, unknown>).signature), [encodeOpaque(opaque), encodeOpaque(opaque)]);
  assert.deepEqual(c.frames().find(f => f.event === "content_block_start" && f.data.index === 2)!.data.content_block, { type: "redacted_thinking", data: encodeOpaque(redacted) });
});

test("respond: tool call and parallel tool calls preserve JSON input and indices", async () => {
  const c = await emitted([{ type: "tool_call_start", id: "c1", name: "shell" }, { type: "tool_call_start", id: "c2", name: "read" }, { type: "tool_call_delta", id: "c2", argumentsDelta: '{"path":"a"}' }, { type: "tool_call_delta", id: "c1", argumentsDelta: '{"cmd":' }, { type: "tool_call_delta", id: "c1", argumentsDelta: '"ls"}' }, { type: "tool_call_end", id: "c2" }, { type: "tool_call_end", id: "c1" }, done("tool_use")]);
  assert.deepEqual(c.frames().filter(f => f.event === "content_block_start").map(f => f.data), [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "shell", input: {} } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c2", name: "read", input: {} } },
  ]);
  assert.deepEqual(c.frames().filter(f => f.event === "content_block_delta").map(f => (f.data.delta as Record<string, unknown>).partial_json), ['{"cmd":', '"ls"}', '{"path":"a"}']);
  assert.deepEqual(c.frames().at(-2)!.data.delta, { stop_reason: "tool_use", stop_sequence: null });
});

test("respond: tool-call Opaque follows its tool_use block in SSE and non-streaming output", async () => {
  const opaque = { provider: "p", model: "m", kind: "thought_signature", data: "sig-1" };
  const events: Event[] = [
    { type: "tool_call_start", id: "call-1", name: "apply_patch" },
    { type: "tool_call_delta", id: "call-1", argumentsDelta: '{"input":"patch"}' },
    { type: "tool_call_end", id: "call-1", opaque },
    done("tool_use"),
  ];
  const streamed = await emitted(events);
  const blocks = streamed.frames().filter(frame => frame.event === "content_block_start");
  assert.deepEqual(blocks.map(frame => (frame.data.content_block as Record<string, unknown>).type), ["tool_use", "redacted_thinking"]);
  const redacted = blocks[1]!.data.content_block as { data: string };
  assert.deepEqual(decodeOpaqueEnvelope(redacted.data), { opaque, callId: "call-1" });
  assert.deepEqual(streamed.frames().filter(frame => frame.event.startsWith("content_block_")).map(frame => frame.event), [
    "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_stop",
  ]);
  const plain = await emitted(events, false);
  const message = JSON.parse(plain.text()) as { content: Array<Record<string, unknown>> };
  assert.deepEqual(message.content, [
    { type: "tool_use", id: "call-1", name: "apply_patch", input: { input: "patch" } },
    { type: "redacted_thinking", data: redacted.data },
  ]);
  const noOpaque = await emitted(events.map(event => event.type === "tool_call_end" ? { type: "tool_call_end", id: event.id } : event));
  assert.deepEqual(noOpaque.frames().filter(frame => frame.event === "content_block_start").map(frame => (frame.data.content_block as Record<string, unknown>).type), ["tool_use"]);
  const parallel = await emitted([
    { type: "tool_call_start", id: "first", name: "apply_patch" },
    { type: "tool_call_start", id: "second", name: "apply_patch" },
    { type: "tool_call_end", id: "second", opaque },
    { type: "tool_call_end", id: "first" },
    done("tool_use"),
  ]);
  assert.deepEqual(parallel.frames().filter(frame => frame.event === "content_block_start").map(frame => {
    const block = frame.data.content_block as Record<string, unknown>;
    return block.type === "tool_use" ? block.id : decodeOpaqueEnvelope(block.data as string)?.callId;
  }), ["first", "second", "second"]);
});

test("respond: max_tokens, refusal and cancelled stop mapping", async () => {
  for (const [reason, mapped] of [["max_tokens", "max_tokens"], ["content_filter", "refusal"], ["cancelled", "end_turn"]] as const) {
    const c = await emitted([done(reason)]);
    assert.equal((c.frames().at(-2)!.data.delta as Record<string, unknown>).stop_reason, mapped);
  }
});

test("respond: error after text leaves block open; error before output is JSON with mapped status", async () => {
  const after = await emitted([{ type: "text_delta", text: "partial" }, { type: "error", error: { kind: "overloaded", message: "busy", provider: "x", retryable: true } }]);
  assert.deepEqual(after.frames().map(f => f.event), ["message_start", "ping", "content_block_start", "content_block_delta", "error"]);
  assert.deepEqual(after.frames().at(-1)!.data, { type: "error", error: { type: "overloaded_error", message: "busy" } });
  const before = sinkCollector();
  await respondMessages(from([{ type: "error", error: { kind: "context_length", message: "long", provider: "x", retryable: false } }]), parsed(), before.sink, { errorStatus: () => 413 });
  assert.equal(before.status(), 413);
  assert.deepEqual(JSON.parse(before.text()), { type: "error", error: { type: "invalid_request_error", message: "long" } });
  for (const [kind, type] of [["auth", "authentication_error"], ["rate_limit", "rate_limit_error"], ["quota", "rate_limit_error"], ["content_filter", "invalid_request_error"], ["not_found", "not_found_error"], ["upstream", "api_error"]] as const) {
    const c = await emitted([{ type: "error", error: { kind, message: "err", provider: "x", retryable: false } }]);
    assert.equal((JSON.parse(c.text()) as { error: { type: string } }).error.type, type);
  }
});

test("respond: invalid tool arguments fail without forwarding a completed call", async () => {
  const c = await emitted([{ type: "tool_call_start", id: "bad", name: "shell" }, { type: "tool_call_delta", id: "bad", argumentsDelta: "{" }, { type: "tool_call_end", id: "bad" }]);
  assert.equal(c.status(), 200);
  assert.deepEqual(c.frames().map(f => f.event), ["message_start", "ping", "error"]);
  assert.deepEqual(c.frames().at(-1)!.data, { type: "error", error: { type: "invalid_request_error", message: "the model returned tool arguments that are not valid JSON" } });
  const after = await emitted([{ type: "text_delta", text: "partial" }, { type: "tool_call_start", id: "bad", name: "shell" }, { type: "tool_call_delta", id: "bad", argumentsDelta: "{" }, { type: "tool_call_end", id: "bad" }]);
  assert.equal(after.frames().at(-1)!.event, "error");
  assert.equal(after.frames().some(f => f.event === "content_block_start" && (f.data.content_block as Record<string, unknown>).type === "tool_use"), false);
});

test("respond: non-streaming message contains final blocks, stop reason and usage", async () => {
  const c = await emitted([{ type: "text_delta", text: "hi" }, { type: "tool_call_start", id: "c", name: "shell" }, { type: "tool_call_delta", id: "c", argumentsDelta: '{"cmd":"ls"}' }, { type: "tool_call_end", id: "c" }, { type: "done", stopReason: "tool_use", usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 } }], false);
  assert.equal(c.status(), 200);
  const message = JSON.parse(c.text()) as Record<string, unknown>;
  assert.deepEqual(message.content, [{ type: "text", text: "hi" }, { type: "tool_use", id: "c", name: "shell", input: { cmd: "ls" } }]);
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.stop_sequence, null);
  assert.deepEqual(message.usage, { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 2, output_tokens: 4 });
});

test("round-trip: several client transcripts reproduce system, messages and tools through the wire", () => {
  const tool = { name: "shell", description: "Run", input_schema: { type: "object", properties: { cmd: { type: "string" } } } };
  const requests: Array<Record<string, unknown>> = [
    base({ system: [{ type: "text", text: "one", cache_control: { type: "ephemeral" } }, { type: "text", text: "two", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [tool] }),
    base({ messages: [{ role: "user", content: [{ type: "text", text: "run" }] }, { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "shell", input: { cmd: "ls" } }, { type: "tool_use", id: "c2", name: "shell", input: { cmd: "pwd" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "a" }, { type: "tool_result", tool_use_id: "c2", content: "b", is_error: true }, { type: "text", text: "continue" }] }], tools: [tool] }),
    base({ messages: [{ role: "user", content: "think" }, { role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: sig("secret", "signed") }, { type: "text", text: "answer" }] }, { role: "user", content: "next" }], tools: [tool] }),
    base({ messages: [{ role: "user", content: "think" }, { role: "assistant", content: [{ type: "thinking", thinking: "foreign", signature: "abc" }, { type: "text", text: "answer" }] }, { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] }], tools: [tool] }),
  ];
  const caps: Capabilities = { reasoning: "effort", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], tools: true, images: true, temperature: false, stream: "sse" };
  for (const request of requests) {
    const parsed = parseMessagesRequest(request);
    const encoded = JSON.parse(encodeAnthropicRequest(parsed.turn, caps, { name: "anth", baseUrl: "https://x", apiKey: "k" }, true).body) as Record<string, unknown>;
    const expectedSystem = Array.isArray(request.system) ? request.system.map((b: { text: string }) => b.text).join("\n\n") : request.system;
    assert.equal(encoded.system, expectedSystem);
    const expectedMessages = structuredClone(request.messages) as Array<{ role: string; content: unknown }>;
    for (const message of expectedMessages) {
      if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }];
      message.content = (message.content as Array<Record<string, unknown>>).filter(block => !(block.type === "thinking" && block.signature === "abc"));
      // The wire unwraps our envelope and sends the provider's original signature.
      for (const block of message.content as Array<Record<string, unknown>>) if (block.type === "thinking") block.signature = "signed";
    }
    assert.deepEqual(encoded.messages, expectedMessages);
    assert.deepEqual((encoded.tools as Array<Record<string, unknown>>).map(({ eager_input_streaming, ...t }) => t), request.tools);
    assert.equal(encoded.cache_control !== undefined, true);
    assert.equal(encoded.max_tokens !== undefined, true);
  }
});
