/**
 * Codex 0.155.1 sends the classic dialect with a freeform `custom` tool named
 * `exec` (code mode's entry point) beside plain functions, namespaces and a
 * hosted web_search. Recorded against a routed Chat Completions model; the
 * generic custom-tool lowering carried a real shell-and-test task end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseResponsesRequest } from "../src/ingress/responses.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/responses/classic-0.155/${name}.request.json`, import.meta.url), "utf8"));

test("0.155.1 classic hello: exec is a custom tool lowered to one string argument; namespaces flatten; web_search drops", () => {
  const parsed = parseResponsesRequest(fixture("hello"));
  assert.equal(parsed.modelRef, "kimi/k3");
  assert.match(parsed.turn.system!, /^You are a coding agent/);
  assert.ok(parsed.lowering.customTools.has("exec"));
  const exec = parsed.turn.tools!.find(t => t.name === "exec")!;
  assert.deepEqual(exec.parameters.required, ["input"]);
  assert.match(exec.description!, /Freeform tool: put the entire raw input text in the single string argument "input"/);
  const names = parsed.turn.tools!.map(t => t.name);
  assert.ok(names.includes("wait"));
  assert.ok(names.includes("request_user_input_async"));
  assert.ok(names.includes("clock__sleep"), names.join(","));
  assert.ok(names.includes("mcp__cua_repl__js"), names.join(","));
  assert.deepEqual(parsed.lowering.namespaceAliases.get("mcp__cua_repl__js"), { namespace: "mcp__cua_repl", name: "js" });
  assert.deepEqual(parsed.lowering.droppedTools, ["web_search"]);
  assert.deepEqual(parsed.turn.reasoning, { effort: "low" });
});

test("0.155.1 after exec: the replayed custom_tool_call is a tool_call with {input}; its output follows as a tool message", () => {
  const parsed = parseResponsesRequest(fixture("turn-2-after-exec"));
  const roles = parsed.turn.messages.map(m => m.role);
  assert.deepEqual(roles.slice(-2), ["assistant", "tool"]);
  const assistant = parsed.turn.messages.at(-2)!;
  assert.equal(assistant.role, "assistant");
  const reasoning = assistant.content.find(p => p.type === "reasoning");
  assert.ok(reasoning && reasoning.type === "reasoning" && reasoning.text, "the summary text we emitted comes back as reasoning text");
  const call = assistant.content.find(p => p.type === "tool_call")!;
  assert.equal(call.type, "tool_call");
  assert.equal(call.name, "exec");
  const args = JSON.parse(call.arguments) as { input: string };
  assert.match(args.input, /^await tools\.exec_command\(\{cmd: "npm test"/);
  const result = parsed.turn.messages.at(-1)!;
  assert.equal(result.role, "tool");
  assert.equal(result.callId, call.id);
  assert.equal(result.name, "exec");
  assert.match((result.content[0] as { text: string }).text, /^Script completed/);
});
