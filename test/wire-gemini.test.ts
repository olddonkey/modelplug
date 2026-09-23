import { test } from "node:test";
import assert from "node:assert/strict";
import type { Capabilities, Event, ProviderTarget, Turn } from "../src/ir.ts";
import { classifyGeminiError, decodeGeminiStream, encodeGeminiRequest, geminiWire, parseGeminiModels, sanitizeSchema } from "../src/wire/gemini.ts";

const caps: Capabilities = { reasoning: "budget", tools: true, images: true, temperature: true, stream: "sse" };
const target: ProviderTarget = { name: "p", baseUrl: "https://example.test", apiKey: "secret", headers: { "x-extra": "1" } };
const body = (turn: Turn, c: Capabilities = caps, stream = true): Record<string, any> => JSON.parse(encodeGeminiRequest(turn, c, target, stream).body);
const turn: Turn = { model: "gemini/test", system: "Follow instructions", messages: [
  { role: "user", content: [{ type: "text", text: "one" }, { type: "image", mediaType: "image/png", data: "AAA" }, { type: "image_url", url: "https://example.test/pic.webp" }] },
  { role: "user", content: [{ type: "text", text: "two" }] },
  { role: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "calling" }, { type: "tool_call", id: "call_0", name: "apply_patch", arguments: '{"input":"patch"}', opaque: { provider: "p", kind: "thought_signature", data: "sig" } }] },
  { role: "tool", callId: "call_0", name: "apply_patch", content: [{ type: "text", text: "ok" }, { type: "image", mediaType: "image/png", data: "BBB" }] },
  { role: "tool", callId: "call_1", content: [{ type: "text", text: "other" }], isError: true },
  { role: "user", content: [{ type: "text", text: "after" }] },
], tools: [{ name: "apply_patch", description: "patch", parameters: { type: "object", properties: { input: { type: ["string", "null"], default: "x" } }, required: ["input"], additionalProperties: false } }], toolChoice: { name: "apply_patch" }, reasoning: { effort: "high" }, sampling: { maxOutputTokens: 100, temperature: 0.2, topP: 0.8, stop: ["END"] }, responseFormat: { type: "json_schema", name: "out", schema: { type: "object", additionalProperties: false } } };

test("sanitizeSchema recursively strips unsupported fields without mutation", () => {
  const original = { type: ["string", "null"], format: "uuid", title: "x", $id: "id", properties: { p: { type: ["integer", "null"], pattern: ".", format: "date", minimum: 0 } }, items: { type: ["string", "integer"], maxLength: 2 }, anyOf: [{ type: "string", default: "x" }], oneOf: [{ format: "date-time", const: "x" }], allOf: [{ additionalProperties: false, examples: [1], strict: true, $schema: "s", minLength: 1, maximum: 2 }] };
  const cleaned = sanitizeSchema(original);
  assert.deepEqual(cleaned, { type: "string", nullable: true, properties: { p: { type: "integer", nullable: true, format: "date" } }, items: { type: "string" }, anyOf: [{ type: "string" }], oneOf: [{ format: "date-time" }], allOf: [{}] });
  assert.equal(original.title, "x");
});

test("encode: URL, headers, role merging, tool results, signature, tools and generation config", () => {
  const request = encodeGeminiRequest(turn, caps, target, true);
  assert.equal(request.url, "https://example.test/v1beta/models/gemini%2Ftest:streamGenerateContent?alt=sse");
  assert.deepEqual(request.headers, { "content-type": "application/json", accept: "text/event-stream", "x-extra": "1", "x-goog-api-key": "secret" });
  const b = body(turn);
  assert.deepEqual(b.systemInstruction, { parts: [{ text: "Follow instructions" }] });
  assert.deepEqual(b.contents.map((c: {role:string}) => c.role), ["user", "model", "user"]);
  assert.equal(b.contents[0].parts[0].text, "one");
  assert.deepEqual(b.contents[0].parts[1].inlineData, { mimeType: "image/png", data: "AAA" });
  assert.deepEqual(b.contents[0].parts[2].fileData, { fileUri: "https://example.test/pic.webp", mimeType: "image/webp" });
  assert.equal(b.contents[0].parts[3].text, "two");
  assert.deepEqual(b.contents[1].parts, [{ text: "calling" }, { functionCall: { name: "apply_patch", args: { input: "patch" } }, thoughtSignature: "sig" }]);
  assert.deepEqual(b.contents[2].parts[0].functionResponse, { name: "apply_patch", response: { output: "ok" } });
  assert.deepEqual(b.contents[2].parts[1].inlineData, { mimeType: "image/png", data: "BBB" });
  assert.deepEqual(b.contents[2].parts[2].functionResponse, { name: "call_1", response: { output: "other", error: true } });
  assert.equal(b.contents[2].parts[3].text, "after");
  assert.deepEqual(b.tools[0].functionDeclarations[0].parameters.required, ["input"]);
  assert.equal(b.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
  assert.deepEqual(b.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["apply_patch"] } });
  assert.deepEqual(b.generationConfig, { maxOutputTokens: 100, temperature: 0.2, topP: 0.8, stopSequences: ["END"], responseMimeType: "application/json", responseSchema: { type: "object" }, thinkingConfig: { includeThoughts: true, thinkingBudget: 16384 } });
});

test("encode: controls, foreign signatures, invalid arguments, image omission and budgets", () => {
  const bare: Turn = { model: "m", messages: [{ role: "assistant", content: [{ type: "tool_call", id: "x", name: "t", arguments: "bad", opaque: { provider: "elsewhere", kind: "thought_signature", data: "foreign" } }] }, { role: "tool", callId: "x", content: [{ type: "image", mediaType: "image/png", data: "A" }] }] };
  const b = body(bare, { ...caps, images: false, temperature: false }, false);
  assert.deepEqual(b.contents[0].parts, [{ functionCall: { name: "t", args: {} } }]);
  assert.match(b.contents[1].parts[0].functionResponse.response.output, /omitted/);
  assert.equal(b.generationConfig, undefined);
  assert.equal(encodeGeminiRequest(bare, caps, target, false).url, "https://example.test/v1beta/models/m:generateContent");
  assert.equal(encodeGeminiRequest(bare, caps, target, false).headers.accept, undefined);
  assert.deepEqual(body({ ...bare, reasoning: { effort: "minimal" } }).generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.deepEqual(body({ ...bare, reasoning: { effort: "low", budgetTokens: 777 } }).generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 777 });
  // The current Responses ingress maps xhigh to max; the wire still understands a raw xhigh effort.
  assert.deepEqual(body({ ...bare, reasoning: { effort: "xhigh" as "max" } }).generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 24576 });
  assert.equal(body({ ...bare, reasoning: { effort: "high" } }, { ...caps, reasoning: "none" }).generationConfig, undefined);
  for (const [choice, mode] of [["auto", "AUTO"], ["none", "NONE"], ["required", "ANY"]] as const) assert.equal(body({ ...bare, tools: [{ name: "t", parameters: {} }], toolChoice: choice }).toolConfig.functionCallingConfig.mode, mode);
});

test("encode: user text and following tool results share one user content", () => {
  const b = body({ model: "m", messages: [
    { role: "user", content: [{ type: "text", text: "text" }] },
    { role: "tool", callId: "c", name: "tool", content: [{ type: "text", text: "result" }] },
    { role: "tool", callId: "d", name: "other", content: [{ type: "text", text: "next" }] },
  ] });
  assert.deepEqual(b.contents.map((c: {role:string}) => c.role), ["user"]);
  assert.equal(b.contents[0].parts[0].text, "text");
  assert.deepEqual(b.contents[0].parts.slice(1).map((p: {functionResponse:{name:string}}) => p.functionResponse.name), ["tool", "other"]);
});

function frames(...values: unknown[]): Response {
  return new Response(values.map(v => `data: ${JSON.stringify(v)}\n\n`).join(""), { status: 200 });
}
async function collect(response: Response): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of decodeGeminiStream(response, caps, target)) events.push(event);
  return events;
}

test("decode: mixed text, thoughts, two synthetic calls, signatures and usage", async () => {
  const events = await collect(frames(
    { modelVersion: "m", candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "hello" }, { functionCall: { name: "a", args: { x: 1 } }, thoughtSignature: "sig-1" }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "b", args: {} } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 4, cachedContentTokenCount: 10 } },
  ));
  assert.deepEqual(events, [
    { type: "reasoning_delta", text: "thinking" }, { type: "text_delta", text: "hello" },
    { type: "tool_call_start", id: "call_0", name: "a" }, { type: "tool_call_delta", id: "call_0", argumentsDelta: '{"x":1}' }, { type: "tool_call_end", id: "call_0", opaque: { provider: "p", model: "m", kind: "thought_signature", data: "sig-1" } },
    { type: "tool_call_start", id: "call_1", name: "b" }, { type: "tool_call_delta", id: "call_1", argumentsDelta: "{}" }, { type: "tool_call_end", id: "call_1" },
    { type: "done", stopReason: "tool_use", usage: { inputTokens: 50, outputTokens: 24, cachedInputTokens: 10, reasoningTokens: 4 } },
  ]);
});

test("decode: terminal reasons, blocked prompt, stream error, missing finish", async () => {
  for (const [reason, expected] of [["STOP", "end_turn"], ["MAX_TOKENS", "max_tokens"], ["SAFETY", "content_filter"], ["RECITATION", "content_filter"], ["PROHIBITED_CONTENT", "content_filter"]]) {
    const events = await collect(frames({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: reason }] }));
    assert.equal((events.at(-1) as {stopReason:string}).stopReason, expected);
  }
  const blocked = await collect(frames({ promptFeedback: { blockReason: "SAFETY" } }));
  assert.equal((blocked[0] as {error:{kind:string;retryable:boolean}}).error.kind, "content_filter");
  assert.equal((blocked[0] as {error:{retryable:boolean}}).error.retryable, false);
  const errored = await collect(frames({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "rate limit" } }));
  assert.equal((errored[0] as {error:{kind:string}}).error.kind, "rate_limit");
  for (const [response, retryable] of [[frames(), true], [frames({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }), false]] as const) {
    const events = await collect(response);
    assert.equal((events.at(-1) as {error:{kind:string;retryable:boolean}}).error.kind, "upstream");
    assert.equal((events.at(-1) as {error:{retryable:boolean}}).error.retryable, retryable);
  }
});

test("classify: status, quota wording and retry-after", () => {
  const classify = (code: number, status: string, message: string, headers = new Headers()) => classifyGeminiError(code, headers, JSON.stringify({ error: { code, status, message } }), target);
  for (const [code, status, message, kind, retryable] of [
    [400, "INVALID_ARGUMENT", "bad", "invalid_request", false], [400, "INVALID_ARGUMENT", "context too long", "context_length", false],
    [401, "UNAUTHENTICATED", "bad", "auth", false], [403, "PERMISSION_DENIED", "bad", "auth", false], [404, "NOT_FOUND", "bad", "not_found", false],
    [429, "RESOURCE_EXHAUSTED", "quota exceeded", "quota", false], [429, "RESOURCE_EXHAUSTED", "busy", "rate_limit", true],
    [500, "INTERNAL", "bad", "upstream", true], [503, "UNAVAILABLE", "bad", "overloaded", true], [504, "DEADLINE_EXCEEDED", "bad", "upstream", true],
  ] as const) {
    const error = classify(code, status, message);
    assert.equal(error.kind, kind);
    assert.equal(error.retryable, retryable);
  }
  assert.equal(classify(429, "RESOURCE_EXHAUSTED", "busy", new Headers({ "retry-after": "2" })).retryAfterMs, 2000);
});

test("models and passthrough key header", () => {
  assert.deepEqual(geminiWire.modelsRequest?.(target), { url: "https://example.test/v1beta/models", headers: { "x-extra": "1", "x-goog-api-key": "secret" } });
  assert.deepEqual(parseGeminiModels({ models: [{ name: "models/z" }, { name: "models/a" }, { name: "models/a" }, { name: "other" }] }), ["a", "z"]);
  assert.deepEqual(geminiWire.passthroughHeaders(target), { "x-goog-api-key": "secret" });
  assert.deepEqual(geminiWire.passthroughHeaders({ name: "p", baseUrl: "https://example.test" }), {});
});
