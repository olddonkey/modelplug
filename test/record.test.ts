import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { parseConfig } from "../src/config.ts";
import { createRecorder, forwardHandler, withRecording } from "../src/record.ts";
import { createServer, notImplementedHandler } from "../src/server.ts";

const config = parseConfig({ providers: { local: { wire: "openai-chat", baseUrl: "http://127.0.0.1:1" } } }, "test");

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}
function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

test("--record saves the request body, the response bytes, and the status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-record-"));
  const recorder = createRecorder(dir);
  const server = createServer(config, { responses: withRecording(recorder, "responses", notImplementedHandler("/v1/responses")) }, "test");
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "x", input: "hi" }) });
    assert.equal(res.status, 501);
    await res.text();
  } finally {
    await close(server);
  }
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 3, files.join(","));
  const [meta, request, response] = files;
  assert.match(meta!, /-responses\.meta\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, request!), "utf8")), { model: "x", input: "hi" });
  assert.match(readFileSync(join(dir, response!), "utf8"), /not_implemented/);
  const metaJson = JSON.parse(readFileSync(join(dir, meta!), "utf8"));
  assert.equal(metaJson.response.status, 501);
  assert.equal(typeof metaJson.request.headers["content-length"], "string");
});

test("--forward relays to <base>/responses with our key and extra headers, streaming chunks as they arrive", async () => {
  const seen: Record<string, string | undefined> = {};
  const upstream = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => (seen.model = (JSON.parse(raw) as { model: string }).model));
    seen.path = req.url;
    seen.auth = req.headers.authorization;
    seen.extra = req.headers["x-extra"] as string;
    seen.ua = req.headers["user-agent"] as string;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: a\ndata: 1\n\n");
    setTimeout(() => {
      res.write("event: b\ndata: 2\n\n");
      res.end();
    }, 30);
  });
  const upstreamPort = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), "wb-forward-"));
  const recorder = createRecorder(dir);
  const forward = forwardHandler({ baseUrl: `http://127.0.0.1:${upstreamPort}/v1/`, apiKey: "test-key", headers: { "x-extra": "1" }, model: "renamed" });
  const server = createServer(config, { responses: withRecording(recorder, "responses", forward) }, "test");
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "user-agent": "codex-test/1.0", authorization: "Bearer client-should-not-leak" },
      body: JSON.stringify({ model: "x" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.equal(text, "event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
  } finally {
    await close(server);
    await close(upstream);
  }
  assert.deepEqual(seen, { path: "/v1/responses", auth: "Bearer test-key", extra: "1", ua: "codex-test/1.0", model: "renamed" });
  const sse = readdirSync(dir).find(f => f.endsWith(".response.sse"))!;
  assert.equal(readFileSync(join(dir, sse), "utf8"), "event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
  const meta = readdirSync(dir).find(f => f.endsWith(".meta.json"))!;
  const metaJson = JSON.parse(readFileSync(join(dir, meta), "utf8"));
  assert.equal(metaJson.response.status, 200);
  assert.equal(metaJson.response.headers["content-type"], "text/event-stream");
});

test("--forward answers 502 when the upstream is unreachable", async () => {
  const forward = forwardHandler({ baseUrl: "http://127.0.0.1:1/v1" });
  const server = createServer(config, { responses: forward }, "test");
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: "{}" });
    assert.equal(res.status, 502);
    assert.equal((await res.json() as { error: { code: string } }).error.code, "upstream_unreachable");
  } finally {
    await close(server);
  }
});
