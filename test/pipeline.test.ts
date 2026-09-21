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
      providers: { chatgpt: { preset: "chatgpt", baseUrl: `http://127.0.0.1:${upstream.port}` }, ollama: { preset: "ollama" } },
      defaultProvider: "chatgpt",
      aliases: { sol: "chatgpt/gpt-5.6-sol", local: "ollama/qwen3" },
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

test("local refusals: missing model, previous_response_id, wire not served yet", async () => {
  const h = await harness([okSse()]);
  try {
    const missing = await h.post({ input: "hi" });
    assert.equal(missing.status, 400);
    await missing.text();
    const prev = await h.post({ model: "gpt-5.6-sol", previous_response_id: "resp_0" });
    assert.equal(prev.status, 400);
    assert.match(((await prev.json()) as { error: { message: string } }).error.message, /previous_response_id is not supported/);
    const routed = await h.post({ model: "local" });
    assert.equal(routed.status, 400);
    assert.match(((await routed.json()) as { error: { message: string } }).error.message, /wire "openai-chat".*cannot serve yet/);
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
