/**
 * One scenario through every wire the IR path serves, against a scripted
 * upstream. Borrowed in spirit from opencodex's adapter-tool-conformance.
 *
 * The client asks for an `apply_patch` (a freeform `custom` tool) on a file
 * whose name has a non-ASCII character, quotes and a backslash. The upstream
 * streams the tool call with its arguments cut inside JSON escape sequences,
 * and the bytes cut inside a UTF-8 sequence. The client must see the
 * `custom_tool_call` restored with the exact input text, streamed as raw text
 * deltas the way the native backend does it. On the next turn the replayed call
 * and its output must reach the upstream verbatim.
 *
 * Adding a wire without adding a scenario here fails the suite on purpose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import type { WireName } from "../src/ir.ts";
import { createPipeline } from "../src/pipeline.ts";
import { createServer } from "../src/server.ts";
import { WIRES } from "../src/wire/index.ts";
import { close, fakeUpstream, listen, parseSseText, writeInPieces, type FakeHandler, type SseEvent } from "./helpers.ts";

const FILE = 'résumé "draft" \\ notes.md';
const PATCH = `*** Begin Patch\n*** Update File: ${FILE}\n@@\n-tab\there\n+quoted "text", a backslash \\ and 日本語\n*** End Patch`;
const CALL_ID = "call_conformance_1";
const TOOL_OUTPUT = `Success. Updated the following files:\nM ${FILE}`;
const ANSWER = "Patched résumé.";

interface Scenario {
  /** Provider config pointing at the fake upstream. */
  provider(port: number): Record<string, unknown>;
  /** Turn 1: assert the lowered tool arrived, then stream the apply_patch call. */
  turn1: FakeHandler;
  /** Turn 2: assert the call and its output were replayed verbatim, then stream a text answer. */
  turn2: FakeHandler;
}

/** Cut `text` at the given indexes (sorted, deduplicated, in range). */
function cut(text: string, indexes: number[]): string[] {
  const points = [...new Set(indexes)].filter(i => i > 0 && i < text.length).sort((a, b) => a - b);
  const out: string[] = [];
  let start = 0;
  for (const p of points) {
    out.push(text.slice(start, p));
    start = p;
  }
  out.push(text.slice(start));
  return out;
}

const SCENARIOS: Partial<Record<WireName, Scenario>> = {
  anthropic: {
    provider: port => ({ wire: "anthropic", baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" }),
    turn1: (req, res, body) => {
      assert.equal(req.url, "/v1/messages");
      assert.equal(req.headers["x-api-key"], "k");
      assert.equal(req.headers["anthropic-version"], "2023-06-01");
      const request = JSON.parse(body) as Record<string, any>;
      assert.equal(request.stream, true);
      assert.equal(typeof request.system, "string");
      const tool = (request.tools as Array<Record<string, any>>).find(t => t.name === "apply_patch");
      assert.ok(tool, "apply_patch is lowered to a function tool");
      assert.deepEqual(tool.input_schema.required, ["input"]);
      assert.equal(tool.eager_input_streaming, true);
      const last = request.messages.at(-1) as { role: string; content: Array<{ type: string; text?: string }> };
      assert.equal(last.role, "user");
      assert.ok(last.content.some(b => b.type === "text" && b.text?.includes(FILE)), "the prompt reached the upstream intact");
      const args = JSON.stringify({ input: PATCH });
      const pieces = cut(args, [args.indexOf('\\"') + 1, args.indexOf("\\\\") + 1, args.lastIndexOf("\\n") + 1, args.indexOf("\\t") + 1]);
      assert.ok(pieces.length >= 4, "the arguments are split across several chunks");
      const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const stream = [
        frame("message_start", { message: { model: "m", usage: { input_tokens: 50, output_tokens: 1 } } }),
        frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: CALL_ID, name: "apply_patch", input: {} } }),
        ...pieces.map(partial_json => frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json } })),
        frame("content_block_stop", { index: 0 }),
        frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }),
        frame("message_stop", {}),
      ].join("");
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeInPieces(res, stream, "é");
    },
    turn2: (_req, res, body) => {
      const request = JSON.parse(body) as { messages: Array<Record<string, any>> };
      const assistant = request.messages.find(m => m.role === "assistant" && m.content.some((b: { type: string }) => b.type === "tool_use"));
      assert.ok(assistant, "the replayed call is an assistant tool_use block");
      const uses = assistant.content.filter((b: { type: string }) => b.type === "tool_use");
      assert.equal(uses.length, 1);
      assert.equal(uses[0].id, CALL_ID);
      assert.equal(uses[0].name, "apply_patch");
      assert.deepEqual(uses[0].input, { input: PATCH });
      const result = request.messages[request.messages.indexOf(assistant) + 1];
      assert.equal(result?.role, "user");
      assert.deepEqual(result.content[0], { type: "tool_result", tool_use_id: CALL_ID, content: TOOL_OUTPUT });
      const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const stream = [
        frame("message_start", { message: { model: "m", usage: { input_tokens: 60, output_tokens: 1 } } }),
        frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: ANSWER.slice(0, 9) } }),
        frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: ANSWER.slice(9) } }),
        frame("content_block_stop", { index: 0 }),
        frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
        frame("message_stop", {}),
      ].join("");
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeInPieces(res, stream, "é");
    },
  },
  "openai-chat": {
    provider: port => ({ wire: "openai-chat", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k" }),
    turn1: (req, res, body) => {
      assert.equal(req.url, "/v1/chat/completions");
      const request = JSON.parse(body) as Record<string, any>;
      const tool = (request.tools as Array<Record<string, any>>).find(t => t.function.name === "apply_patch");
      assert.ok(tool, "apply_patch is lowered to a function tool");
      assert.deepEqual(tool.function.parameters.required, ["input"]);
      assert.equal(tool.function.parameters.properties.input.type, "string");
      const last = request.messages.at(-1) as { role: string; content: string };
      assert.equal(last.role, "user");
      assert.ok(last.content.includes(FILE), "the prompt reached the upstream intact");
      const args = JSON.stringify({ input: PATCH });
      // Cut inside `\"`, inside `\\`, inside `\n` and inside `\t`, so escapes span chunks.
      const pieces = cut(args, [args.indexOf('\\"') + 1, args.indexOf("\\\\") + 1, args.lastIndexOf("\\n") + 1, args.indexOf("\\t") + 1]);
      assert.ok(pieces.length >= 4, "the arguments are split across several chunks");
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
        JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
      const frames = [
        chunk({ role: "assistant", content: "" }),
        chunk({ tool_calls: [{ index: 0, id: CALL_ID, type: "function", function: { name: "apply_patch", arguments: pieces[0] } }] }),
        ...pieces.slice(1).map(p => chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] })),
        chunk({}, "tool_calls"),
        JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } }),
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeInPieces(res, frames.map(f => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n", "é");
    },
    turn2: (_req, res, body) => {
      const request = JSON.parse(body) as { messages: Array<Record<string, any>> };
      const assistant = request.messages.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
      assert.ok(assistant, "the replayed call is an assistant tool_calls message");
      assert.equal(assistant.tool_calls.length, 1);
      assert.equal(assistant.tool_calls[0].id, CALL_ID);
      assert.equal(assistant.tool_calls[0].function.name, "apply_patch");
      assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { input: PATCH });
      const result = request.messages.find(m => m.role === "tool");
      assert.ok(result, "the tool output is a tool message");
      assert.equal(result.tool_call_id, CALL_ID);
      assert.equal(result.content, TOOL_OUTPUT);
      assert.equal(request.messages.indexOf(result), request.messages.indexOf(assistant) + 1, "the result follows its call");
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "cmpl", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeInPieces(res, chunk({ content: ANSWER.slice(0, 9) }) + chunk({ content: ANSWER.slice(9) }, "stop") + "data: [DONE]\n\n", "é");
    },
  },
};

const TOOLS = [
  {
    type: "custom",
    name: "apply_patch",
    description: "Use the `apply_patch` tool to edit files.",
    format: { type: "grammar", syntax: "lark", definition: 'start: begin_patch hunk+ end_patch\nbegin_patch: "*** Begin Patch" LF' },
  },
  { type: "function", name: "shell", description: "Runs a shell command", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } }, required: ["command"] }, strict: false },
];

function turn1Request(model: string): Record<string, unknown> {
  return {
    model,
    instructions: "You are a coding agent.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Apply this patch to ${FILE}:\n${PATCH}` }] }],
    tools: TOOLS,
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
}

function turn2Request(model: string, callItem: Record<string, any>): Record<string, unknown> {
  return {
    ...turn1Request(model),
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `Apply this patch to ${FILE}:\n${PATCH}` }] },
      { type: "custom_tool_call", id: callItem.id, call_id: callItem.call_id, name: callItem.name, input: callItem.input, status: "completed" },
      { type: "custom_tool_call_output", call_id: CALL_ID, output: TOOL_OUTPUT },
    ],
  };
}

async function runScenario(scenario: Scenario): Promise<void> {
  const upstream = await fakeUpstream([scenario.turn1, scenario.turn2]);
  const config = parseConfig({ providers: { p: scenario.provider(upstream.port) } }, "test");
  const pipeline = createPipeline(config, { usageLogPath: null, log: () => {}, attempt: { policy: { maxAttemptsPerTarget: 1, baseDelayMs: 0, maxDelayMs: 0 } } });
  const server = createServer(config, pipeline.handlers, "test");
  const port = await listen(server);
  const post = async (body: unknown): Promise<SseEvent[]> => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return parseSseText(text);
  };
  try {
    const events1 = await post(turn1Request("p/m"));
    const added = events1.find(e => e.type === "response.output_item.added" && e.data.item.type === "custom_tool_call");
    assert.ok(added, `custom_tool_call item announced; saw ${events1.map(e => e.type).join(", ")}`);
    assert.equal(added.data.item.name, "apply_patch");
    assert.equal(added.data.item.call_id, CALL_ID);
    const deltas = events1.filter(e => e.type === "response.custom_tool_call_input.delta");
    assert.ok(deltas.length >= 2, "the input streams in more than one delta");
    assert.equal(deltas.map(e => e.data.delta).join(""), PATCH, "input deltas are the raw patch text, not JSON");
    const inputDone = events1.find(e => e.type === "response.custom_tool_call_input.done");
    assert.equal(inputDone?.data.input, PATCH);
    const item = events1.find(e => e.type === "response.output_item.done" && e.data.item.type === "custom_tool_call");
    assert.ok(item);
    assert.equal(item.data.item.input, PATCH, "the restored custom_tool_call carries the exact input");
    assert.equal(item.data.item.status, "completed");
    assert.ok(!events1.some(e => e.type.startsWith("response.function_call_arguments")), "no function-call events leak for a custom tool");
    const completed = events1.at(-1)!;
    assert.equal(completed.type, "response.completed");
    assert.deepEqual((completed.data.response.output as Array<{ type: string }>).map(o => o.type), ["custom_tool_call"]);
    assert.equal(completed.data.response.usage.input_tokens, 50);

    const events2 = await post(turn2Request("p/m", item.data.item));
    const text = events2.filter(e => e.type === "response.output_text.delta").map(e => e.data.delta).join("");
    assert.equal(text, ANSWER);
    const completed2 = events2.at(-1)!;
    assert.equal(completed2.type, "response.completed");
    assert.equal(completed2.data.response.output[0].content[0].text, ANSWER);
    assert.equal(upstream.calls, 2);
  } finally {
    await close(server);
    await close(upstream.server);
  }
}

for (const name of Object.keys(WIRES) as WireName[]) {
  // The pipeline relays Responses requests to this wire byte for byte instead of round-tripping the IR.
  if (name === "openai-responses") continue;
  test(`conformance: apply_patch round trip through ${name}`, async () => {
    const scenario = SCENARIOS[name];
    assert.ok(scenario, `wire "${name}" is registered but has no conformance scenario`);
    await runScenario(scenario);
  });
}
