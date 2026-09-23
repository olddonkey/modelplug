import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { estimateInputTokens, parseMessagesRequest } from "../src/ingress/messages.ts";
import { decodeOpaqueEnvelope } from "../src/ingress/responses.ts";
import { createMessagesUsageProbe, createPipeline } from "../src/pipeline.ts";
import { createServer } from "../src/server.ts";
import { close, fakeUpstream, listen, parseSseText, type FakeHandler } from "./helpers.ts";

const CHAT_SSE = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 40, completion_tokens: 1 } },
].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

const MESSAGE_SSE = [
  { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 0 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "héllo" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");

const request = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 128,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

test("Messages usage probe sniffs untyped SSE split across UTF-8 and frame boundaries", () => {
  const probe = createMessagesUsageProbe("");
  const bytes = Buffer.from(MESSAGE_SSE, "utf8");
  for (let start = 0; start < bytes.length; start += 17) probe.observe(bytes.subarray(start, start + 17));
  assert.deepEqual(probe.result(), { inputTokens: 15, outputTokens: 7, cachedInputTokens: 2, cacheWriteTokens: 3 });
  const revised = createMessagesUsageProbe("text/event-stream");
  const delta = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":12,"cache_read_input_tokens":4,"cache_creation_input_tokens":5,"output_tokens":7}}\n\n';
  revised.observe(Buffer.from(delta));
  assert.deepEqual(revised.result(), { inputTokens: 21, outputTokens: 7, cachedInputTokens: 4, cacheWriteTokens: 5 });
});

test("count_tokens estimate counts UTF-8 text, tool schema and each image allowance", () => {
  const parsed = parseMessagesRequest(request("local/qwen3", {
    system: [{ type: "text", text: "é" }, { type: "text", text: "a" }],
    messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image", source: { type: "url", url: "https://image" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ] }],
    tools: [{ name: "shell", description: "runs", input_schema: { type: "object" } }],
  }));
  const bytes = Buffer.byteLength('é\n\nahishellruns{"type":"object"}', "utf8");
  assert.equal(estimateInputTokens(parsed), Math.ceil(bytes / 4) + 3000);
});

async function harness(localHandlers: FakeHandler[], anthropicHandlers: FakeHandler[]) {
  const local = await fakeUpstream(localHandlers);
  const anthropic = await fakeUpstream(anthropicHandlers);
  const dir = mkdtempSync(join(tmpdir(), "wb-messages-"));
  const usageLogPath = join(dir, "usage.jsonl");
  const config = parseConfig({ providers: {
    local: { preset: "ollama", baseUrl: `http://127.0.0.1:${local.port}/v1` },
    anth: { wire: "anthropic", baseUrl: `http://127.0.0.1:${anthropic.port}`, apiKey: "server-key" },
  } }, "test");
  const sleeps: number[] = [];
  const pipeline = createPipeline(config, {
    usageLogPath,
    log: () => {},
    attempt: { policy: { maxAttemptsPerTarget: 3, baseDelayMs: 10, maxDelayMs: 1000 }, sleep: async ms => void sleeps.push(ms) },
  });
  const server = createServer(config, pipeline.handlers, "test");
  const port = await listen(server);
  return {
    local, anthropic, usageLogPath, sleeps,
    post: (body: unknown, path = "/v1/messages", headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    lines: () => readFileSync(usageLogPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, any>),
    stop: async () => { await close(server); await close(local.server); await close(anthropic.server); },
  };
}

test("Messages IR translates system, tools and replayed tool results, then returns Messages SSE and usage", async () => {
  const seen: Record<string, any>[] = [];
  const h = await harness([(req, res, body) => {
    assert.equal(req.url, "/v1/chat/completions");
    seen.push(JSON.parse(body) as Record<string, any>);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(CHAT_SSE);
  }], [(_req, res) => { res.end(); }]);
  try {
    const first = request("local/qwen3", {
      system: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }, { type: "text", text: "second" }],
      tools: [{ name: "shell", description: "run command", input_schema: { type: "object", properties: { cmd: { type: "string" } } } }],
      metadata: { user_id: "session-1" }, stream: true,
    });
    const response = await h.post(first);
    assert.equal(response.status, 200);
    const frames = parseSseText(await response.text());
    assert.equal(frames[0]?.type, "message_start");
    assert.equal(frames.at(-1)?.type, "message_stop");
    assert.ok(frames.some(frame => frame.type === "content_block_delta" && frame.data.delta?.text === "hello"));
    assert.equal(seen[0]?.model, "qwen3");
    assert.deepEqual(seen[0]?.messages[0], { role: "system", content: "first\n\nsecond" });
    assert.equal(seen[0]?.tools[0].type, "function");
    assert.equal(seen[0]?.tools[0].function.name, "shell");
    assert.deepEqual(seen[0]?.tools[0].function.parameters, { type: "object", properties: { cmd: { type: "string" } } });
    assert.equal(seen[0]?.stream, true);

    const second = await h.post({ ...first, messages: [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "shell", input: { cmd: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "done" }, { type: "text", text: "next" }] },
    ] });
    assert.equal(second.status, 200);
    await second.text();
    assert.deepEqual(seen[1]?.messages.slice(1), [
      { role: "user", content: "run it" },
      { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "shell", arguments: '{"cmd":"pwd"}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "done" },
      { role: "user", content: "next" },
    ]);
    assert.equal(h.local.calls, 2);
    for (const line of h.lines()) {
      assert.equal(line.ingress, "messages");
      assert.equal(line.route, "messages");
      assert.deepEqual(line.usage, { inputTokens: 40, outputTokens: 1 });
    }
  } finally { await h.stop(); }
});

test("Messages apply_patch round trip replays a tool-call Opaque to the upstream", async () => {
  const patch = "*** Begin Patch\n*** Add File: note.txt\n+done\n*** End Patch";
  const upstream = await fakeUpstream([
    (req, res, body) => {
      assert.equal(req.url, "/v1beta/models/m:streamGenerateContent?alt=sse");
      const sent = JSON.parse(body) as { tools: Array<{ functionDeclarations: Array<{ name: string }> }> };
      assert.equal(sent.tools[0]?.functionDeclarations[0]?.name, "apply_patch");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        { candidates: [{ content: { parts: [{ functionCall: { name: "apply_patch", args: { input: patch } }, thoughtSignature: "sig-1" }] } }] },
        { candidates: [{ finishReason: "STOP" }] },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
    },
    (_req, res, body) => {
      const sent = JSON.parse(body) as { contents: Array<{ role: string; parts: Array<Record<string, any>> }> };
      const assistant = sent.contents.find(item => item.role === "model" && item.parts.some(part => part.functionCall));
      assert.ok(assistant);
      const call = assistant.parts.find(part => part.functionCall);
      assert.deepEqual(call?.functionCall, { name: "apply_patch", args: { input: patch } });
      assert.equal(call.thoughtSignature, "sig-1");
      const result = sent.contents[sent.contents.indexOf(assistant) + 1];
      assert.equal(result?.role, "user");
      assert.deepEqual(result.parts[0]?.functionResponse, { name: "apply_patch", response: { output: "applied" } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] })}\n\n`);
    },
  ]);
  const config = parseConfig({ providers: { g: { wire: "gemini", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: "k" } } }, "test");
  const pipeline = createPipeline(config, { usageLogPath: null, log: () => {}, attempt: { policy: { maxAttemptsPerTarget: 1, baseDelayMs: 0, maxDelayMs: 0 } } });
  const server = createServer(config, pipeline.handlers, "test");
  const port = await listen(server);
  const post = async (messages: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request("g/m", {
      messages, stream: true, tools: [{ name: "apply_patch", input_schema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } }],
    })) });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return parseSseText(body);
  };
  try {
    const first = await post([{ role: "user", content: "Apply the patch" }]);
    const blocks: Array<Record<string, any>> = [];
    for (const frame of first) {
      if (frame.type === "content_block_start") blocks[frame.data.index] = structuredClone(frame.data.content_block);
      if (frame.type === "content_block_delta" && frame.data.delta.type === "input_json_delta") {
        const block = blocks[frame.data.index]!;
        block.inputJson = (block.inputJson ?? "") + frame.data.delta.partial_json;
      }
      if (frame.type === "content_block_stop") {
        const block = blocks[frame.data.index]!;
        if (block.type === "tool_use") {
          block.input = JSON.parse(block.inputJson);
          delete block.inputJson;
        }
      }
    }
    assert.deepEqual(blocks.map(block => block.type), ["tool_use", "redacted_thinking"]);
    assert.deepEqual(blocks[0]?.input, { input: patch });
    assert.deepEqual(decodeOpaqueEnvelope(blocks[1]!.data), { opaque: { provider: "g", kind: "thought_signature", data: "sig-1" }, callId: blocks[0]!.id });
    const second = await post([
      { role: "user", content: "Apply the patch" },
      { role: "assistant", content: blocks },
      { role: "user", content: [{ type: "tool_result", tool_use_id: blocks[0]!.id, content: "applied" }] },
    ]);
    assert.equal(second.filter(frame => frame.type === "content_block_delta").map(frame => frame.data.delta.text).join(""), "done");
    assert.equal(upstream.calls, 2);
  } finally { await close(server); await close(upstream.server); }
});

test("Messages passthrough injects its key, relays SSE bytes and logs cache-inclusive usage", async () => {
  const seen: Record<string, unknown> = {};
  const h = await harness([(_req, res) => { res.end(); }], [(req, res, body) => {
    seen.path = req.url;
    seen.headers = req.headers;
    seen.body = JSON.parse(body);
    // Deliberately omit content-type to exercise first-byte sniffing.
    res.writeHead(200, { "x-request-id": "upstream-1" });
    const bytes = Buffer.from(MESSAGE_SSE);
    res.write(bytes.subarray(0, 57));
    res.end(bytes.subarray(57));
  }]);
  try {
    const response = await h.post(request("anth/claude-x", { stream: true }), "/v1/messages", {
      "x-api-key": "client-key", authorization: "Bearer client-token", "anthropic-beta": "client-beta",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), "upstream-1");
    assert.equal(await response.text(), MESSAGE_SSE);
    assert.equal(seen.path, "/v1/messages");
    assert.equal((seen.body as Record<string, unknown>).model, "claude-x");
    const headers = seen.headers as Record<string, string | undefined>;
    assert.equal(headers["x-api-key"], "server-key");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["anthropic-beta"], "client-beta");
    assert.deepEqual(h.lines()[0]?.usage, { inputTokens: 15, outputTokens: 7, cachedInputTokens: 2, cacheWriteTokens: 3 });
    assert.equal(h.local.calls, 0);
  } finally { await h.stop(); }
});

test("count_tokens relays passthrough JSON and estimates routed text, tools and images locally", async () => {
  const seen: Record<string, unknown> = {};
  const exact = '{"input_tokens":123,"note":"exact"}';
  const h = await harness([(_req, res) => { res.end(); }], [(req, res, body) => {
    seen.path = req.url;
    seen.model = (JSON.parse(body) as Record<string, unknown>).model;
    seen.key = req.headers["x-api-key"];
    seen.version = req.headers["anthropic-version"];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(exact);
  }]);
  try {
    const passthrough = await h.post(request("anth/claude-x"), "/v1/messages/count_tokens");
    assert.equal(passthrough.status, 200);
    assert.equal(await passthrough.text(), exact);
    assert.equal(seen.path, "/v1/messages/count_tokens");
    assert.equal(seen.model, "claude-x");
    assert.equal(seen.key, "server-key");
    assert.equal(seen.version, "2023-06-01");
    const local = await h.post(request("local/qwen3", {
      system: "é", messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "url", url: "https://image" } }] }],
      tools: [{ name: "shell", description: "runs", input_schema: { type: "object" } }],
    }), "/v1/messages/count_tokens");
    assert.equal(local.status, 200);
    const expected = Math.ceil(Buffer.byteLength('éhishellruns{"type":"object"}', "utf8") / 4) + 1500;
    assert.deepEqual(await local.json(), { input_tokens: expected });
    assert.ok(expected > 0);
    assert.equal(h.local.calls, 0);
    assert.equal(h.anthropic.calls, 1);
  } finally { await h.stop(); }
});

test("Messages maps 401 and parse failures to its error shape; 529 retries before one clean response", async () => {
  const h = await harness([(_req, res) => { res.end(); }], [
    (_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}'); },
    (_req, res) => { res.writeHead(529, { "content-type": "application/json", "retry-after": "1" }); res.end('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}'); },
    (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(MESSAGE_SSE); },
  ]);
  try {
    const denied = await h.post(request("anth/claude-x"));
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { type: "error", error: { type: "authentication_error", message: "anth: bad key" } });
    const retried = await h.post(request("anth/claude-x", { stream: true }));
    assert.equal(retried.status, 200);
    assert.equal(await retried.text(), MESSAGE_SSE);
    assert.deepEqual(h.sleeps, [1000]);
    assert.equal(h.anthropic.calls, 3);
    const invalid = await h.post(request("local/qwen3", { messages: [{ role: "user", content: [{ type: "document" }] }] }));
    assert.equal(invalid.status, 400);
    const error = await invalid.json() as { type: string; error: { type: string; message: string } };
    assert.equal(error.type, "error");
    assert.equal(error.error.type, "invalid_request_error");
    assert.match(error.error.message, /document/);
    const missing = await h.post(request("missing/qwen3"));
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { type: string } }).error.type, "not_found_error");
    assert.equal(h.local.calls, 0);
  } finally { await h.stop(); }
});
