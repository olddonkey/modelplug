import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { parseConfig } from "../src/config.ts";
import { describeProbe, discoveredModels, probeProvider, probeProviders } from "../src/probe.ts";
import { createServer, modelList } from "../src/server.ts";
import { CODEX_MODELS_CLIENT_VERSION } from "../src/wire/openai-models.ts";
import { close, fakeUpstream, listen } from "./helpers.ts";

const now = (): number => 1_000;

test("a provider that answers GET /models is reachable and its model ids are collected", async () => {
  const seen: Record<string, unknown> = {};
  const upstream = await fakeUpstream([
    (req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      seen.extra = req.headers["x-extra"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "m-b", object: "model" }, { id: "m-a" }, { id: "m-a" }, { no: "id" }] }));
    },
  ]);
  try {
    const config = parseConfig({ providers: { p: { wire: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "sk", headers: { "x-extra": "1" } } } }, "test");
    const result = await probeProvider(config.providers.p!, { now });
    assert.equal(result.state, "reachable");
    assert.deepEqual(result.models, ["m-a", "m-b"]);
    assert.equal(result.detail, "2 models");
    assert.equal(seen.method, "GET");
    assert.equal(seen.url, "/v1/models?client_version=" + CODEX_MODELS_CLIENT_VERSION);
    assert.equal(seen.auth, "Bearer sk");
    assert.equal(seen.extra, "1");
    assert.equal(describeProbe(result), "reachable, 2 models (0ms)");
  } finally {
    await close(upstream.server);
  }
});

test("401 is auth failed with the upstream message; 404 and other 4xx are reachable; 5xx is unreachable", async () => {
  const upstream = await fakeUpstream([
    (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
    },
    (_req, res) => {
      res.writeHead(404);
      res.end("nope");
    },
    (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "slow down" } }));
    },
    (_req, res) => {
      res.writeHead(503);
      res.end("maintenance");
    },
  ]);
  try {
    const config = parseConfig({ providers: { p: { wire: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "sk" } } }, "test");
    const auth = await probeProvider(config.providers.p!, { now });
    assert.equal(auth.state, "auth_failed");
    assert.match(auth.detail, /HTTP 401: Incorrect API key/);
    const missing = await probeProvider(config.providers.p!, { now });
    assert.equal(missing.state, "reachable");
    assert.match(missing.detail, /no model list/);
    assert.deepEqual(missing.models, []);
    const limited = await probeProvider(config.providers.p!, { now });
    assert.equal(limited.state, "reachable");
    assert.match(limited.detail, /HTTP 429: slow down/);
    const down = await probeProvider(config.providers.p!, { now });
    assert.equal(down.state, "unreachable");
    assert.match(down.detail, /HTTP 503/);
  } finally {
    await close(upstream.server);
  }
});

test("connection refused and a silent server are unreachable within the timeout", async () => {
  const silent = createHttpServer(() => {
    /* never answers */
  });
  const silentPort = await listen(silent);
  const refused = await fakeUpstream([(_req, res) => void res.end()]);
  await close(refused.server);
  try {
    const config = parseConfig(
      {
        providers: {
          gone: { wire: "openai-chat", baseUrl: `http://127.0.0.1:${refused.port}/v1` },
          slow: { wire: "openai-chat", baseUrl: `http://127.0.0.1:${silentPort}/v1` },
        },
      },
      "test",
    );
    const started = Date.now();
    const results = await probeProviders(config, { now, timeoutMs: 150 });
    assert.ok(Date.now() - started < 2_000, "probes run in parallel and respect the timeout");
    const byName = Object.fromEntries(results.map(r => [r.provider, r]));
    assert.equal(byName.gone!.state, "unreachable");
    assert.match(byName.gone!.detail, /ECONNREFUSED|connect/i);
    assert.equal(byName.slow!.state, "unreachable");
    assert.match(byName.slow!.detail, /no answer within/);
  } finally {
    await close(silent);
  }
});

test("wires without a model list and credential kinds without an account are reported, not probed", async () => {
  const config = parseConfig({ providers: { a: { preset: "anthropic", apiKey: "k" }, c: { preset: "chatgpt" } } }, "test");
  let fetched = 0;
  const results = await probeProviders(config, {
    now,
    storePath: "/nonexistent/modelplug-credentials.json",
    fetch: async () => {
      fetched += 1;
      return new Response("{}");
    },
  });
  const byName = Object.fromEntries(results.map(r => [r.provider, r]));
  assert.equal(byName.a!.state, "unsupported");
  assert.match(byName.a!.detail, /not served in this build/);
  assert.equal(byName.c!.state, "no_credential");
  assert.match(byName.c!.detail, /no ChatGPT account/);
  assert.equal(fetched, 0);
  assert.match(describeProbe(byName.c!), /^no credential, /);
});

test("/v1/models lists discovered ids for providers that configure none, and configured ids win", async () => {
  const config = parseConfig(
    {
      providers: {
        listed: { wire: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", models: ["fixed"] },
        bare: { wire: "openai-chat", baseUrl: "http://127.0.0.1:1/v1" },
      },
      aliases: { fast: "bare/x" },
    },
    "test",
  );
  const discovered = discoveredModels([
    { provider: "listed", state: "reachable", detail: "", models: ["found"], durationMs: 0 },
    { provider: "bare", state: "reachable", detail: "", models: ["b-1", "b-2"], durationMs: 0 },
    { provider: "nope", state: "unreachable", detail: "", models: [], durationMs: 0 },
  ]);
  assert.deepEqual(discovered, { listed: ["found"], bare: ["b-1", "b-2"] });
  const ids = modelList(config, discovered).data.map(m => m.id);
  assert.deepEqual(ids, ["listed/fixed", "bare/b-1", "bare/b-2", "fast"]);

  const server = createServer(config, {}, "test", { discoveredModels: () => discovered });
  const port = await listen(server);
  try {
    const body = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as { data: Array<{ id: string; owned_by: string }> };
    assert.deepEqual(body.data.map(m => m.id), ["listed/fixed", "bare/b-1", "bare/b-2", "fast"]);
    assert.equal(body.data[1]!.owned_by, "bare");
  } finally {
    await close(server);
  }
});
