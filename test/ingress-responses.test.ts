import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Event, ResponseSink } from "../src/ir.ts";
import { decodeOpaque, decodeOpaqueEnvelope, encodeOpaque, IngressError, parseResponsesRequest, respondResponses } from "../src/ingress/responses.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/responses/classic/${name}.request.json`, import.meta.url), "utf8"));
const lite = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/responses/lite/${name}.request.json`, import.meta.url), "utf8"));

test("classic hello: instructions and developer text become system; tools flatten; hosted web_search is dropped", () => {
  const parsed = parseResponsesRequest(fixture("hello"));
  assert.equal(parsed.modelRef, "deepseek-v4");
  assert.equal(parsed.stream, true);
  assert.match(parsed.turn.system!, /^You are a coding agent running in the Codex CLI/);
  assert.match(parsed.turn.system!, /<skills_instructions>/);
  assert.deepEqual(parsed.turn.messages.map(m => m.role), ["user", "user"]);
  const names = parsed.turn.tools!.map(t => t.name);
  assert.ok(names.includes("exec_command"));
  assert.ok(names.includes("view_image"));
  assert.ok(names.includes("multi_agent_v1__spawn_agent"), names.join(","));
  assert.equal(parsed.lowering.namespaceAliases.get("multi_agent_v1__spawn_agent")?.name, "spawn_agent");
  assert.deepEqual(parsed.lowering.droppedTools, ["web_search"]);
  assert.equal(parsed.turn.parallelToolCalls, true);
  assert.deepEqual(parsed.turn.reasoning, { effort: "medium", summary: "auto" });
  assert.equal(parsed.turn.metadata?.conversationId?.length, 36);
});

test("classic turn-3: replayed calls attach to assistant messages and outputs become tool messages with names", () => {
  const parsed = parseResponsesRequest(fixture("turn-3-after-two-tools"));
  const roles = parsed.turn.messages.map(m => m.role);
  assert.deepEqual(roles.slice(-4), ["assistant", "tool", "assistant", "tool"]);
  const firstCall = parsed.turn.messages.find(m => m.role === "assistant")!;
  const call = firstCall.content.find(p => p.type === "tool_call")!;
  assert.equal(call.type, "tool_call");
  assert.equal(call.name, "exec_command");
  assert.match(call.arguments, /"cmd":"ls -la"/);
  const tool = parsed.turn.messages.find(m => m.role === "tool")!;
  assert.equal(tool.role, "tool");
  assert.equal(tool.name, "exec_command");
  assert.equal(tool.callId, call.id);
  assert.equal(tool.content[0]!.type, "text");
});

test("classic image turn: the data URL becomes an inline image part", () => {
  const parsed = parseResponsesRequest(fixture("image-turn"));
  const user = parsed.turn.messages.filter(m => m.role === "user").at(-1)!;
  const image = user.content.find(p => p.type === "image")!;
  assert.equal(image.type, "image");
  assert.equal(image.mediaType, "image/png");
  assert.match(image.data, /^iVBOR/);
});

test("the Lite dialect is refused with a message that names the fix", () => {
  assert.throws(() => parseResponsesRequest(lite("hello")), (err: unknown) => err instanceof IngressError && err.status === 400 && /Responses Lite/.test(err.message) && /provider\/model/.test(err.message));
  assert.throws(() => parseResponsesRequest(lite("turn-2-after-exec")), IngressError);
});

test("local refusals and lowering of custom tools, tool_choice, allowed_tools, formats", () => {
  assert.throws(() => parseResponsesRequest({ model: "m", previous_response_id: "r" }), /previous_response_id/);
  assert.throws(() => parseResponsesRequest({ model: "m", input: [{ type: "mystery" }] }), /unsupported input item type "mystery"/);
  assert.throws(() => parseResponsesRequest({ input: "hi" }), /model is required/);

  const parsed = parseResponsesRequest({
    model: "m",
    input: "hi",
    tools: [
      { type: "custom", name: "apply_patch", description: "Patch files", format: { type: "grammar", syntax: "lark", definition: "start: x" } },
      { type: "function", name: "shell", parameters: { type: "object", properties: { cmd: { type: "string" } } }, strict: false },
      { type: "namespace", name: "agents", description: "Sub-agents", tools: [{ type: "function", name: "spawn", parameters: {} }] },
      { type: "web_search", external_web_access: true },
    ],
    tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "shell" }, { type: "function", name: "spawn" }] },
    reasoning: { effort: "xhigh", summary: "detailed" },
    text: { format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true }, verbosity: "low" },
    max_output_tokens: 512,
    temperature: 0.2,
  });
  assert.deepEqual(parsed.turn.tools!.map(t => t.name), ["shell", "agents__spawn"]);
  assert.equal(parsed.turn.toolChoice, "required");
  assert.ok(parsed.lowering.customTools.has("apply_patch"));
  assert.deepEqual(parsed.turn.reasoning, { effort: "xhigh", summary: "auto" });
  assert.deepEqual(parsed.turn.responseFormat, { type: "json_schema", name: "out", schema: { type: "object" }, strict: true });
  assert.deepEqual(parsed.turn.sampling, { maxOutputTokens: 512, temperature: 0.2 });
  assert.equal(parsed.stream, false);

  const custom = parseResponsesRequest({
    model: "m",
    tools: [{ type: "custom", name: "apply_patch" }],
    input: [
      { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
    ],
  });
  const call = custom.turn.messages[0]!;
  assert.equal(call.role, "assistant");
  assert.deepEqual(JSON.parse((call.content[0] as { arguments: string }).arguments), { input: "*** Begin Patch" });
  assert.equal(custom.turn.tools![0]!.parameters.required?.toString(), "input");
});

test("replayed reasoning rides as an opaque envelope only when it is ours", () => {
  const envelope = encodeOpaque({ provider: "anthropic", kind: "signature", data: "abc" });
  assert.deepEqual(decodeOpaque(envelope), { provider: "anthropic", kind: "signature", data: "abc" });
  assert.equal(decodeOpaque("gAAAAABforeign"), undefined);
  const parsed = parseResponsesRequest({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: envelope },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "done" },
      { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "gAAAAAforeign-blob" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "all good" }] },
    ],
  });
  const assistant = parsed.turn.messages[1]!;
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content[0], { type: "reasoning", text: "thinking", opaque: { provider: "anthropic", kind: "signature", data: "abc" } });
  assert.equal(assistant.content[1]!.type, "tool_call");
  const last = parsed.turn.messages.at(-1)!;
  assert.deepEqual(last.content, [{ type: "text", text: "all good" }]);
  assert.match(parsed.lowering.warnings.join(" "), /another backend/);
});

test("parse: a bound reasoning envelope attaches to its call; unknown ids remain reasoning", () => {
  const opaque = { provider: "p", model: "m", kind: "thought_signature", data: "sig-1" };
  const bound = encodeOpaque(opaque, "c1");
  assert.deepEqual(decodeOpaqueEnvelope(bound), { opaque, callId: "c1" });
  assert.deepEqual(decodeOpaque(bound), opaque);
  const parsed = parseResponsesRequest({ model: "m", input: [
    { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
    { type: "reasoning", summary: [], encrypted_content: bound },
  ] });
  assert.equal(parsed.turn.messages.length, 1);
  assert.equal(parsed.turn.messages[0]?.role, "assistant");
  assert.deepEqual(parsed.turn.messages[0]?.content, [{ type: "tool_call", id: "c1", name: "shell", arguments: "{}", opaque }]);

  const unknown = parseResponsesRequest({ model: "m", input: [
    { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
    { type: "reasoning", summary: [], encrypted_content: encodeOpaque(opaque, "missing") },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ] });
  assert.deepEqual(unknown.turn.messages[0]?.content, [{ type: "tool_call", id: "c1", name: "shell", arguments: "{}" }]);
  assert.deepEqual(unknown.turn.messages[1]?.content, [{ type: "reasoning", opaque }, { type: "text", text: "done" }]);
});

/* ------------------------------------------------------------ respond */

function sinkCollector(): { sink: ResponseSink; status: () => number | undefined; headers: () => Record<string, string>; text: () => string; events: () => Array<{ type: string; data: Record<string, unknown> }> } {
  let status: number | undefined;
  let headers: Record<string, string> = {};
  let text = "";
  return {
    sink: {
      status(code, h) {
        status = code;
        headers = h;
      },
      write(chunk) {
        text += chunk;
      },
      end() {},
    },
    status: () => status,
    headers: () => headers,
    text: () => text,
    events: () =>
      text
        .split("\n\n")
        .filter(Boolean)
        .map(frame => {
          const type = frame.split("\n")[0]!.replace("event: ", "");
          const data = JSON.parse(frame.split("\n").find(l => l.startsWith("data: "))!.slice(6)) as Record<string, unknown>;
          return { type, data };
        }),
  };
}

async function* from(events: Event[]): AsyncGenerator<Event> {
  for (const e of events) yield e;
}

const baseParsed = (over: Partial<ReturnType<typeof parseResponsesRequest>> = {}) => ({
  ...parseResponsesRequest({ model: "p/m", input: "hi", stream: true, tools: [{ type: "custom", name: "apply_patch" }, { type: "function", name: "shell", parameters: {} }] }),
  ...over,
});

async function assertBoundCallOutput(name: string, args: string, expectedType: string): Promise<void> {
  const opaque = { provider: "p", model: "m", kind: "thought_signature", data: "sig-1" };
  const events: Event[] = [
    { type: "tool_call_start", id: "c1", name },
    { type: "tool_call_delta", id: "c1", argumentsDelta: args },
    { type: "tool_call_end", id: "c1", opaque },
    { type: "done", stopReason: "tool_use" },
  ];
  const c = sinkCollector();
  await respondResponses(from(events), baseParsed(), c.sink);
  const frames = c.events();
  const callDoneAt = frames.findIndex(frame => frame.type === "response.output_item.done" && (frame.data.item as { type: string }).type === expectedType);
  assert.ok(callDoneAt >= 0);
  const added = frames[callDoneAt + 1]!;
  const done = frames[callDoneAt + 2]!;
  assert.equal(added.type, "response.output_item.added");
  assert.equal(done.type, "response.output_item.done");
  assert.equal(added.data.output_index, done.data.output_index);
  const addedItem = added.data.item as { id: string; type: string; summary: unknown[] };
  const doneItem = done.data.item as { id: string; type: string; summary: unknown[]; encrypted_content: string };
  assert.deepEqual(addedItem, { id: doneItem.id, type: "reasoning", summary: [] });
  assert.deepEqual(doneItem.summary, []);
  assert.deepEqual(decodeOpaqueEnvelope(doneItem.encrypted_content), { opaque, callId: "c1" });
  assert.ok(!frames.some(frame => frame.type.startsWith("response.reasoning_summary")));
  const completed = frames.at(-1)!.data.response as { output: Array<{ type: string; encrypted_content?: string }> };
  assert.deepEqual(completed.output.map(item => item.type), [expectedType, "reasoning"]);
  assert.equal(completed.output[1]?.encrypted_content, doneItem.encrypted_content);

  const nonstream = sinkCollector();
  await respondResponses(from(events), baseParsed({ stream: false }), nonstream.sink);
  const response = JSON.parse(nonstream.text()) as { output: Array<{ type: string; encrypted_content?: string }> };
  assert.deepEqual(response.output.map(item => item.type), [expectedType, "reasoning"]);
  assert.deepEqual(decodeOpaqueEnvelope(response.output[1]!.encrypted_content!), { opaque, callId: "c1" });
}

test("respond: a function call's opaque follows its completed item as bound reasoning", async () => {
  await assertBoundCallOutput("shell", '{"cmd":"ls"}', "function_call");
});

test("respond: a lowered custom call's opaque follows its completed item as bound reasoning", async () => {
  await assertBoundCallOutput("apply_patch", JSON.stringify({ input: "patch" }), "custom_tool_call");
});

test("respond: text-only turn emits the canonical sequence with usage details always present", async () => {
  const c = sinkCollector();
  await respondResponses(from([{ type: "text_delta", text: "hel" }, { type: "text_delta", text: "lo" }, { type: "done", stopReason: "end_turn" }]), baseParsed(), c.sink);
  assert.equal(c.status(), 200);
  assert.match(c.headers()["content-type"]!, /text\/event-stream/);
  const names = c.events().map(e => e.type);
  assert.deepEqual(names, [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const completed = c.events().at(-1)!.data.response as { status: string; output: Array<{ type: string; content: Array<{ text: string }> }>; usage: Record<string, unknown> };
  assert.equal(completed.status, "completed");
  assert.equal(completed.output[0]!.content[0]!.text, "hello");
  assert.deepEqual(completed.usage, { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 });
  const seqs = c.events().map(e => e.data.sequence_number as number);
  assert.deepEqual(seqs, seqs.map((_, i) => i));
});

test("respond: reasoning then text then a tool call, with usage and an opaque envelope", async () => {
  const c = sinkCollector();
  await respondResponses(
    from([
      { type: "reasoning_delta", text: "think" },
      { type: "reasoning_opaque", opaque: { provider: "x", kind: "sig", data: "d" } },
      { type: "text_delta", text: "ok" },
      { type: "tool_call_start", id: "call_1", name: "shell" },
      { type: "tool_call_delta", id: "call_1", argumentsDelta: '{"cmd":' },
      { type: "tool_call_delta", id: "call_1", argumentsDelta: '"ls"}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reasoningTokens: 2 } },
    ]),
    baseParsed(),
    c.sink,
  );
  const names = c.events().map(e => e.type);
  assert.deepEqual(names.slice(2, 8), [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  assert.ok(names.includes("response.function_call_arguments.delta"));
  assert.ok(names.includes("response.function_call_arguments.done"));
  const completed = c.events().at(-1)!.data.response as { output: Array<Record<string, unknown>>; usage: Record<string, unknown> };
  assert.deepEqual(completed.output.map(o => o.type), ["reasoning", "message", "function_call"]);
  assert.equal(typeof completed.output[0]!.encrypted_content, "string");
  assert.equal(decodeOpaque(completed.output[0]!.encrypted_content as string)?.provider, "x");
  const call = completed.output[2]!;
  assert.equal(call.call_id, "call_1");
  assert.equal(call.arguments, '{"cmd":"ls"}');
  assert.equal(call.status, "completed");
  assert.deepEqual(completed.usage, { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 14 });
});

test("respond: a lowered custom tool call is restored as custom_tool_call with the raw input", async () => {
  const c = sinkCollector();
  await respondResponses(
    from([
      { type: "tool_call_start", id: "call_9", name: "apply_patch" },
      { type: "tool_call_delta", id: "call_9", argumentsDelta: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) },
      { type: "tool_call_end", id: "call_9" },
      { type: "done", stopReason: "tool_use" },
    ]),
    baseParsed(),
    c.sink,
  );
  const names = c.events().map(e => e.type);
  assert.ok(names.includes("response.custom_tool_call_input.delta"));
  assert.ok(names.includes("response.custom_tool_call_input.done"));
  const item = (c.events().at(-1)!.data.response as { output: Array<Record<string, unknown>> }).output[0]!;
  assert.equal(item.type, "custom_tool_call");
  assert.equal(item.input, "*** Begin Patch\n*** End Patch");
  const deltas = c.events().filter(e => e.type === "response.custom_tool_call_input.delta").map(e => e.data.delta as string);
  assert.deepEqual(deltas, ["*** Begin Patch\n*** End Patch"], "the delta is the raw input, not the JSON envelope");

  // Escapes and surrogate pairs cut across argument chunks stream as raw text and never as half an escape.
  const input = 'say "hi"\\path\t😀 done';
  const args = JSON.stringify({ input }).replace("😀", "\\ud83d\\ude00");
  const pieces = [args.indexOf('\\"') + 1, args.indexOf("\\\\") + 1, args.indexOf("\\ud83d") + 3, args.indexOf("\\ude00") + 2, args.length - 3];
  const c2 = sinkCollector();
  const events: Event[] = [{ type: "tool_call_start", id: "c", name: "apply_patch" }];
  let at = 0;
  for (const p of [...pieces].sort((a, b) => a - b)) {
    events.push({ type: "tool_call_delta", id: "c", argumentsDelta: args.slice(at, p) });
    at = p;
  }
  events.push({ type: "tool_call_delta", id: "c", argumentsDelta: args.slice(at) }, { type: "tool_call_end", id: "c" }, { type: "done", stopReason: "tool_use" });
  await respondResponses(from(events), baseParsed(), c2.sink);
  const streamed = c2.events().filter(e => e.type === "response.custom_tool_call_input.delta").map(e => e.data.delta as string);
  assert.equal(streamed.join(""), input);
  assert.ok(streamed.length >= 3, `expected several deltas, got ${JSON.stringify(streamed)}`);
  for (const d of streamed) assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(d), `a delta must not start with a low or end with a high surrogate: ${JSON.stringify(d)}`);
  assert.equal((c2.events().at(-1)!.data.response as { output: Array<{ input: string }> }).output[0]!.input, input);
});

test("respond: max_tokens becomes response.incomplete; an error mid-call closes the call without arguments.done and fails", async () => {
  const c1 = sinkCollector();
  await respondResponses(from([{ type: "text_delta", text: "partial" }, { type: "done", stopReason: "max_tokens" }]), baseParsed(), c1.sink);
  const last1 = c1.events().at(-1)!;
  assert.equal(last1.type, "response.incomplete");
  assert.deepEqual((last1.data.response as { incomplete_details: unknown }).incomplete_details, { reason: "max_output_tokens" });

  const c2 = sinkCollector();
  await respondResponses(
    from([
      { type: "text_delta", text: "hi" },
      { type: "tool_call_start", id: "c", name: "shell" },
      { type: "tool_call_delta", id: "c", argumentsDelta: '{"cmd"' },
      { type: "error", error: { kind: "upstream", message: "boom", provider: "p", retryable: false } },
    ]),
    baseParsed(),
    c2.sink,
  );
  const names = c2.events().map(e => e.type);
  assert.equal(names.at(-1), "response.failed");
  assert.ok(!names.includes("response.function_call_arguments.done"));
  const failed = c2.events().at(-1)!.data.response as { status: string; error: { code: string; message: string }; output: Array<Record<string, unknown>> };
  assert.equal(failed.status, "failed");
  assert.match(failed.error.message, /p: boom/);
  assert.equal(failed.output.find(o => o.type === "function_call")!.status, "incomplete");

  const c3 = sinkCollector();
  await respondResponses(from([{ type: "tool_call_start", id: "c", name: "shell" }, { type: "tool_call_delta", id: "c", argumentsDelta: "{not json" }, { type: "tool_call_end", id: "c" }]), baseParsed(), c3.sink);
  const failed3 = c3.events().at(-1)!;
  assert.equal(failed3.type, "response.failed");
  assert.equal((failed3.data.response as { error: { code: string } }).error.code, "invalid_tool_arguments");
});

test("respond: non-streaming returns the final response object, or an error status when nothing was produced", async () => {
  const ok = sinkCollector();
  await respondResponses(from([{ type: "text_delta", text: "yo" }, { type: "done", stopReason: "end_turn" }]), baseParsed({ stream: false }), ok.sink);
  assert.equal(ok.status(), 200);
  const body = JSON.parse(ok.text()) as { object: string; status: string; output: Array<{ content: Array<{ text: string }> }> };
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.equal(body.output[0]!.content[0]!.text, "yo");

  const bad = sinkCollector();
  await respondResponses(from([{ type: "error", error: { kind: "rate_limit", message: "slow", provider: "p", retryable: true } }]), baseParsed({ stream: false }), bad.sink, { errorStatus: () => 429 });
  assert.equal(bad.status(), 429);
  assert.match(bad.text(), /slow/);
});
