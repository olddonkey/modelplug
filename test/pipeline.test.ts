import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { saveCredentialStore } from "../src/credentials/store.ts";
import { createPipeline, createUsageProbe } from "../src/pipeline.ts";
import { createServer } from "../src/server.ts";
import { AUTH_CLAIM, close, fakeJwt, fakeUpstream, listen, type FakeHandler } from "./helpers.ts";

const FAR = Math.floor(Date.now() / 1000) + 86_400;
const SSE =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n' +
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":100,"cache_write_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":125}}}\n\n';

function okSse(extraHeaders: Record<string, string> = {}): FakeHandler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "x-oai-request-id": "req-1", ...extraHeaders });
    res.write(SSE.slice(0, 60));
    setTimeout(() => {
      res.write(SSE.slice(60));
      res.end();
    }, 20);
  };
}

async function harness(handlers: FakeHandler[], options: { tokenPort?: number } = {}) {
  const upstream = await fakeUpstream(handlers);
  const dir = mkdtempSync(join(tmpdir(), "wb-pipe-"));
  const storePath = join(dir, "credentials.json");
  saveCredentialStore(storePath, {
    schemaVersion: 1,
    chatgpt: {
      accounts: [{ id: "acc-1", accountId: "acc-1", email: "a@example.com", accessToken: fakeJwt({ exp: FAR, [AUTH_CLAIM]: {} }), refreshToken: "r1", lastRefresh: "x", source: "import" }],
    },
  });
  const config = parseConfig(
    {
      providers: {
        chatgpt: { preset: "chatgpt", baseUrl: `http://127.0.0.1:${upstream.port}` },
        local: { preset: "ollama", baseUrl: `http://127.0.0.1:${upstream.port}/v1` },
        responseskey: { wire: "openai-responses", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "responses-test-key" },
        anth: { preset: "anthropic", apiKey: "k" },
        goog: { preset: "google", apiKey: "k" },
      },
      defaultProvider: "chatgpt",
      aliases: { sol: "chatgpt/gpt-5.6-sol", missing: "goog/gemini" },
    },
    "test",
  );
  const usageLogPath = join(dir, "usage.jsonl");
  const sleeps: number[] = [];
  const pipeline = createPipeline(config, {
    storePath,
    usageLogPath,
    log: () => {},
    ...(options.tokenPort ? { tokenUrl: `http://127.0.0.1:${options.tokenPort}/t` } : {}),
    attempt: { policy: { maxAttemptsPerTarget: 3, baseDelayMs: 10, maxDelayMs: 1000 }, sleep: async ms => void sleeps.push(ms) },
  });
  const server = createServer(config, pipeline.handlers, "test", { statusLines: pipeline.statusLines });
  const port = await listen(server);
  return {
    upstream,
    port,
    usageLogPath,
    sleeps,
    pipeline,
    post: (body: unknown, headers: Record<string, string> = {}, path = "/v1/responses") =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    stop: async () => {
      await close(server);
      await close(upstream.server);
    },
  };
}

test("passthrough: renames the model, injects auth, forwards client headers, relays SSE, logs usage, records quota", async () => {
  const seen: Record<string, unknown> = {};
  const h = await harness([
    (req, res, body) => {
      seen.path = req.url;
      seen.auth = req.headers.authorization;
      seen.account = req.headers["chatgpt-account-id"];
      seen.originator = req.headers.originator;
      seen.clientAuthLeaked = req.headers["x-forwarded-auth"] ?? false;
      seen.model = (JSON.parse(body) as { model: string }).model;
      seen.store = (JSON.parse(body) as { store: boolean }).store;
      okSse({ "x-codex-primary-used-percent": "42", "x-codex-primary-window-minutes": "300" })(req, res, body);
    },
  ]);
  try {
    const res = await h.post({ model: "sol", input: "hi", store: false, prompt_cache_key: "conv-1" }, { originator: "codex_exec", authorization: "Bearer client-token" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("x-oai-request-id"), "req-1");
    assert.equal(await res.text(), SSE);
    assert.equal(seen.path, "/responses");
    assert.equal(seen.model, "gpt-5.6-sol");
    assert.equal(seen.store, false);
    assert.match(String(seen.auth), /^Bearer eyJ/);
    assert.notEqual(seen.auth, "Bearer client-token");
    assert.equal(seen.account, "acc-1");
    assert.equal(seen.originator, "codex_exec");
    const lines = readFileSync(h.usageLogPath, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.status, "ok");
    assert.equal(lines[0]!.model, "gpt-5.6-sol");
    assert.equal(lines[0]!.credential, "acc-1");
    assert.deepEqual(lines[0]!.usage, { inputTokens: 120, outputTokens: 5, cachedInputTokens: 100, cacheWriteTokens: 0, reasoningTokens: 2 });
    assert.match(h.pipeline.statusLines().join("\n"), /a@example.com.*5h: 42% used/);
    const status = await (await fetch(`http://127.0.0.1:${h.port}/`)).text();
    assert.match(status, /42% used/);
  } finally {
    await h.stop();
  }
});

test("compact goes to /responses/compact on the same path", async () => {
  const seen: Record<string, unknown> = {};
  const h = await harness([
    (req, res) => {
      seen.path = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "cmp_1", usage: { input_tokens: 9, output_tokens: 1 } }));
    },
  ]);
  try {
    const res = await h.post({ model: "gpt-5.6-sol", input: [] }, {}, "/v1/responses/compact");
    assert.equal(res.status, 200);
    assert.equal(seen.path, "/responses/compact");
    const line = JSON.parse(readFileSync(h.usageLogPath, "utf8").trim()) as { route: string; usage: { inputTokens: number } };
    assert.equal(line.route, "compact");
    assert.equal(line.usage.inputTokens, 9);
  } finally {
    await h.stop();
  }
});

test("a 401 triggers one refresh and a retry; the client sees a single clean response", async () => {
  const token = await fakeUpstream([
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: fakeJwt({ exp: FAR, fresh: true }), refresh_token: "r2" }));
    },
  ]);
  const tokensSeen: string[] = [];
  const h = await harness(
    [
      (req, res) => {
        tokensSeen.push(String(req.headers.authorization));
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "token expired" } }));
      },
      (req, res, body) => {
        tokensSeen.push(String(req.headers.authorization));
        okSse()(req, res, body);
      },
    ],
    { tokenPort: token.port },
  );
  try {
    const res = await h.post({ model: "gpt-5.6-sol", input: "hi" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), SSE);
    assert.equal(h.upstream.calls, 2);
    assert.equal(token.calls, 1);
    assert.notEqual(tokensSeen[0], tokensSeen[1]);
    assert.deepEqual(h.sleeps, [], "a credential retry does not back off");
  } finally {
    await h.stop();
    await close(token.server);
  }
});

test("a 429 with Retry-After is retried after the hinted delay, then succeeds", async () => {
  const h = await harness([
    (_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: "slow down" } }));
    },
    okSse(),
  ]);
  try {
    const res = await h.post({ model: "gpt-5.6-sol", input: "hi" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), SSE);
    assert.deepEqual(h.sleeps, [1000]);
    const lines = readFileSync(h.usageLogPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "the failed attempt is logged too");
  } finally {
    await h.stop();
  }
});

test("a non-retryable upstream error becomes a Responses-shaped JSON error with the mapped status", async () => {
  const h = await harness([
    (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "The 'deepseek-v4' model is not supported when using Codex with a ChatGPT account." }));
    },
  ]);
  try {
    const res = await h.post({ model: "deepseek-v4", input: "hi" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { message: string; code: string; type: string; upstream_status: number } };
    assert.equal(body.error.code, "not_found");
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.upstream_status, 400);
    assert.match(body.error.message, /^chatgpt: The 'deepseek-v4' model is not supported/);
    assert.equal(h.upstream.calls, 1);
  } finally {
    await h.stop();
  }
});

test("local refusals: missing model, previous_response_id", async () => {
  const h = await harness([okSse()]);
  try {
    const missing = await h.post({ input: "hi" });
    assert.equal(missing.status, 400);
    await missing.text();
    const prev = await h.post({ model: "gpt-5.6-sol", previous_response_id: "resp_0" });
    assert.equal(prev.status, 400);
    assert.match(((await prev.json()) as { error: { message: string } }).error.message, /previous_response_id is not supported/);
    assert.equal(h.upstream.calls, 0);
  } finally {
    await h.stop();
  }
});

test("a client that disconnects mid-stream aborts the upstream request", async () => {
  let upstreamClosed: () => void = () => {};
  const closed = new Promise<void>(resolve => (upstreamClosed = resolve));
  const h = await harness([
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: response.created\ndata: {}\n\n");
      // `req` already closed when its body was read; `res` closes when the connection is torn down.
      res.once("close", () => upstreamClosed());
      /* never ends on its own */
    },
  ]);
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi" }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream never saw the abort")), 3000))]);
  } finally {
    await h.stop();
  }
});

test("the usage probe sniffs SSE or JSON when the upstream sends no content-type", () => {
  const enc = new TextEncoder();
  const sse = createUsageProbe("");
  for (let i = 0; i < SSE.length; i += 37) sse.observe(enc.encode(SSE.slice(i, i + 37)));
  assert.deepEqual(sse.result(), { inputTokens: 120, outputTokens: 5, cachedInputTokens: 100, cacheWriteTokens: 0, reasoningTokens: 2 });
  const json = createUsageProbe("");
  json.observe(enc.encode('  {"id":"resp_2","usage":{"input_tokens":3,"out'));
  json.observe(enc.encode('put_tokens":4}}'));
  assert.deepEqual(json.result(), { inputTokens: 3, outputTokens: 4 });
  const typed = createUsageProbe("text/event-stream; charset=utf-8");
  typed.observe(enc.encode('data:{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n'));
  assert.deepEqual(typed.result(), { inputTokens: 1, outputTokens: 2 });
});

const CHAT_SSE = [
  { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
  { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 40, completion_tokens: 1 } },
]
  .map(c => `data: ${JSON.stringify(c)}\n\n`)
  .join("") + "data: [DONE]\n\n";

test("IR path: a classic Codex request is translated to Chat Completions and the answer comes back as Responses SSE", async () => {
  const seen: Record<string, unknown> = {};
  const h = await harness([
    (req, res, body) => {
      seen.path = req.url;
      seen.auth = req.headers.authorization ?? null;
      const parsed = JSON.parse(body) as Record<string, any>;
      seen.model = parsed.model;
      seen.firstRole = parsed.messages[0].role;
      seen.toolNames = parsed.tools.map((t: { function: { name: string } }) => t.function.name);
      seen.stream = parsed.stream;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(CHAT_SSE);
    },
  ]);
  try {
    const request = JSON.parse(readFileSync(new URL("./fixtures/responses/classic/hello.request.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const res = await h.post({ ...request, model: "local/qwen3" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /text\/event-stream/);
    const text = await res.text();
    assert.equal(seen.path, "/v1/chat/completions");
    assert.equal(seen.auth, null, "the ollama preset has no key");
    assert.equal(seen.model, "qwen3");
    assert.equal(seen.firstRole, "system");
    assert.ok((seen.toolNames as string[]).includes("exec_command"));
    assert.ok((seen.toolNames as string[]).includes("multi_agent_v1__spawn_agent"));
    assert.equal(seen.stream, true);
    assert.match(text, /event: response\.created/);
    assert.match(text, /"delta":"hello"/);
    assert.match(text, /event: response\.completed/);
    assert.match(text, /"input_tokens":40/);
    const line = JSON.parse(readFileSync(h.usageLogPath, "utf8").trim().split("\n").at(-1)!) as { provider: string; model: string; usage: { inputTokens: number } };
    assert.equal(line.provider, "local");
    assert.equal(line.model, "qwen3");
    assert.equal(line.usage.inputTokens, 40);
  } finally {
    await h.stop();
  }
});

test("IR path: API-key Responses strips private fields and flattens namespace tools", async () => {
  const seen: Record<string, unknown> = {};
  const h = await harness([
    (req, res, body) => {
      seen.path = req.url;
      seen.auth = req.headers.authorization;
      seen.codexHeader = req.headers["x-codex-turn-metadata"];
      seen.body = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    },
  ]);
  try {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/responses/classic/hello.request.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const res = await h.post({ ...fixture, model: "responseskey/gpt-test" }, { "x-codex-turn-metadata": "private", authorization: "Bearer client" });
    assert.equal(res.status, 200);
    const body = seen.body as Record<string, any>;
    assert.equal(seen.path, "/v1/responses");
    assert.equal(seen.auth, "Bearer responses-test-key");
    assert.equal(seen.codexHeader, undefined);
    assert.equal(body.model, "gpt-test");
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.client_metadata, undefined);
    assert.equal(body.prompt_cache_key, undefined);
    assert.ok(body.tools.some((t: { name: string }) => t.name === "multi_agent_v1__spawn_agent"));
    assert.ok(body.tools.every((t: { type: string }) => t.type === "function"));
    const text = await res.text();
    assert.match(text, /event: response\.completed/);
    assert.match(text, /"input_tokens":120/);
  } finally {
    await h.stop();
  }
});

test("IR path: a tool call from the model becomes a function_call item; a Lite request is refused locally", async () => {
  const toolSse = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec_command", arguments: "" } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ]
    .map(c => `data: ${JSON.stringify(c)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  const h = await harness([
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(toolSse);
    },
  ]);
  try {
    const request = JSON.parse(readFileSync(new URL("./fixtures/responses/classic/hello.request.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const res = await h.post({ ...request, model: "local/qwen3" });
    const text = await res.text();
    assert.match(text, /event: response\.function_call_arguments\.done/);
    assert.match(text, /"call_id":"call_1","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}"/);
    const liteBody = JSON.parse(readFileSync(new URL("./fixtures/responses/lite/hello.request.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const lite = await h.post({ ...liteBody, model: "local/qwen3" });
    assert.equal(lite.status, 400);
    assert.match(((await lite.json()) as { error: { message: string } }).error.message, /Responses Lite/);
    assert.equal(h.upstream.calls, 1);
  } finally {
    await h.stop();
  }
});
