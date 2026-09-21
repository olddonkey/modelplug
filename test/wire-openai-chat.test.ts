import { test } from "node:test";
import assert from "node:assert/strict";
import type { Capabilities, Event, ProviderTarget, Turn } from "../src/ir.ts";
import { decodeChatStream, encodeChatRequest, usageFromChat } from "../src/wire/openai-chat.ts";

const caps: Capabilities = { reasoning: "none", tools: true, images: true, temperature: true, stream: "sse" };
const target: ProviderTarget = { name: "p", baseUrl: "https://api.example.com/v1", apiKey: "k", headers: { "x-extra": "1" } };

const turn: Turn = {
  model: "m",
  system: "be brief",
  messages: [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "AAA" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "ok" }, { type: "tool_call", id: "c1", name: "shell", arguments: '{"cmd":"ls"}' }] },
    { role: "tool", callId: "c1", name: "shell", content: [{ type: "text", text: "a\nb" }, { type: "image", mediaType: "image/png", data: "BBB" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "only thoughts" }] },
  ],
  tools: [{ name: "shell", description: "run", parameters: { type: "object", properties: {} } }, { name: "strictly", parameters: {}, strict: true }],
  toolChoice: { name: "shell" },
  parallelToolCalls: false,
  reasoning: { effort: "max" },
  sampling: { temperature: 0.1, topP: 0.9, maxOutputTokens: 100 },
  responseFormat: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true },
};

test("encode maps the IR onto Chat Completions and applies capabilities", () => {
  const req = encodeChatRequest(turn, caps, target, true);
  assert.equal(req.url, "https://api.example.com/v1/chat/completions");
  assert.equal(req.headers.authorization, "Bearer k");
  assert.equal(req.headers["x-extra"], "1");
  const body = JSON.parse(req.body) as Record<string, any>;
  assert.equal(body.model, "m");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.messages[0], { role: "system", content: "be brief" });
  assert.equal(body.messages[1].content[1].type, "image_url");
  assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,AAA$/);
  assert.equal(body.messages[2].content, "ok");
  assert.deepEqual(body.messages[2].tool_calls, [{ id: "c1", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } }]);
  assert.equal(body.messages[2].reasoning_content, undefined, "reasoning text is never replayed");
  assert.equal(body.messages[3].role, "tool");
  assert.equal(body.messages[3].tool_call_id, "c1");
  assert.match(body.messages[3].content, /^a\nb\n\[image attached/);
  assert.equal(body.messages[4].role, "user", "tool images are hoisted into a following user message");
  assert.equal(body.messages.length, 5, "a reasoning-only assistant message is skipped");
  assert.equal(body.tools.length, 2);
  assert.equal(body.tools[0].function.strict, undefined);
  assert.equal(body.tools[1].function.strict, true);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "shell" } });
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.temperature, 0.1);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } });
  assert.equal(body.reasoning_effort, undefined, "reasoning=none sends no effort");
});

test("encode: images dropped without vision, effort clamped, toggle field, no tools when caps.tools is false", () => {
  const noVision = JSON.parse(encodeChatRequest(turn, { ...caps, images: false, temperature: false }, target, false).body) as Record<string, any>;
  assert.match(noVision.messages[1].content, /image\(s\) omitted/);
  assert.equal(noVision.temperature, undefined);
  assert.equal(noVision.stream, false);
  assert.equal(noVision.stream_options, undefined);
  assert.equal(noVision.messages.length, 4, "no hoisted image message without vision");

  const effort = JSON.parse(encodeChatRequest(turn, { ...caps, reasoning: "effort", reasoningLevels: ["low", "high"] }, target, true).body) as Record<string, any>;
  assert.equal(effort.reasoning_effort, "high");
  const low = JSON.parse(encodeChatRequest({ ...turn, reasoning: { effort: "minimal" } }, { ...caps, reasoning: "effort", reasoningLevels: ["low", "medium", "high"] }, target, true).body) as Record<string, any>;
  assert.equal(low.reasoning_effort, "low");

  const toggle = { ...caps, reasoning: "toggle" as const, reasoningToggle: { field: "enable_thinking", on: true, off: false } };
  assert.equal((JSON.parse(encodeChatRequest(turn, toggle, target, true).body) as Record<string, any>).enable_thinking, true);
  assert.equal((JSON.parse(encodeChatRequest({ ...turn, reasoning: { effort: "minimal" } }, toggle, target, true).body) as Record<string, any>).enable_thinking, false);

  const noTools = JSON.parse(encodeChatRequest(turn, { ...caps, tools: false }, target, true).body) as Record<string, any>;
  assert.equal(noTools.tools, undefined);
  assert.equal(noTools.tool_choice, undefined);
});

function sse(chunks: unknown[], done = true): Response {
  const text = chunks.map(c => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
async function collect(response: Response, c: Capabilities = caps): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of decodeChatStream(response, c, target)) out.push(e);
  return out;
}

test("decode: text, usage in a trailing chunk, [DONE]", async () => {
  const events = await collect(sse([chunk({ role: "assistant", content: "" }), chunk({ content: "Hel" }), chunk({ content: "lo" }, "stop"), { id: "x", choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } }]));
  assert.deepEqual(events, [
    { type: "text_delta", text: "Hel" },
    { type: "text_delta", text: "lo" },
    { type: "done", stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 2, cachedInputTokens: 5 } },
  ]);
});

test("decode: tool call arguments accumulate by index; parallel calls keep order; finish tool_calls", async () => {
  const events = await collect(
    sse([
      chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "shell", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "view_image", arguments: '{"path":"a.png"}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
      chunk({}, "tool_calls", { usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    ]),
  );
  assert.deepEqual(events.map(e => e.type), ["tool_call_start", "tool_call_delta", "tool_call_start", "tool_call_delta", "tool_call_delta", "tool_call_end", "tool_call_end", "done"]);
  assert.deepEqual(events[0], { type: "tool_call_start", id: "call_a", name: "shell" });
  assert.deepEqual(events[5], { type: "tool_call_end", id: "call_a" });
  assert.deepEqual(events[6], { type: "tool_call_end", id: "call_b" });
  assert.equal((events.at(-1) as { stopReason: string }).stopReason, "tool_use");
});

test("decode: DeepSeek reasoning_content, usage in the last content chunk, finish length", async () => {
  const events = await collect(sse([chunk({ reasoning_content: "think" }), chunk({ content: "ans" }, "length", { usage: { prompt_tokens: 3, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 6 }, prompt_cache_hit_tokens: 2 } })]));
  assert.deepEqual(events, [
    { type: "reasoning_delta", text: "think" },
    { type: "text_delta", text: "ans" },
    { type: "done", stopReason: "max_tokens", usage: { inputTokens: 3, outputTokens: 9, cachedInputTokens: 2, reasoningTokens: 6 } },
  ]);
});

test("decode: a mid-stream error object, a stream that ends without anything, a call without a name", async () => {
  const errored = await collect(sse([chunk({ content: "a" }), { error: { message: "context length exceeded", type: "invalid_request_error" } }], false));
  assert.equal(errored.at(-1)!.type, "error");
  assert.equal((errored.at(-1) as { error: { kind: string } }).error.kind, "context_length");

  const empty = await collect(new Response("", { status: 200 }));
  assert.equal(empty.length, 1);
  assert.equal((empty[0] as { error: { kind: string; retryable: boolean } }).error.kind, "upstream");
  assert.equal((empty[0] as { error: { retryable: boolean } }).error.retryable, true);

  const nameless = await collect(sse([chunk({ tool_calls: [{ index: 0, id: "c", function: { arguments: "{}" } }] }, "tool_calls")]));
  assert.equal(nameless.at(-1)!.type, "error");
});

test("usageFromChat tolerates partial objects", () => {
  assert.deepEqual(usageFromChat({ prompt_tokens: 1 }), { inputTokens: 1, outputTokens: 0 });
  assert.equal(usageFromChat({}), undefined);
  assert.equal(usageFromChat(null), undefined);
});
