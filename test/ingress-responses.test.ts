import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Event, ResponseSink } from "../src/ir.ts";
import { decodeOpaque, encodeOpaque, IngressError, parseResponsesRequest, respondResponses } from "../src/ingress/responses.ts";

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
  assert.deepEqual(parsed.turn.reasoning, { effort: "max", summary: "auto" });
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
