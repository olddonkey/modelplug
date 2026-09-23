import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEX_MODELS_CLIENT_VERSION, openaiModelsRequest, parseOpenaiModels } from "../src/wire/openai-models.ts";

test("the models request carries the client_version the Codex backend requires, and the key", () => {
  const req = openaiModelsRequest({ name: "p", baseUrl: "https://x.example/v1", apiKey: "k", headers: { "x-a": "1" } });
  assert.equal(req.url, `https://x.example/v1/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`);
  assert.equal(req.headers.authorization, "Bearer k");
  assert.equal(req.headers["x-a"], "1");
  assert.match(CODEX_MODELS_CLIENT_VERSION, /^\d+\.\d+\.\d+$/);
});

test("model ids come from data[].id, from the Codex backend's models[].slug, or from a bare list", () => {
  assert.deepEqual(parseOpenaiModels({ object: "list", data: [{ id: "b" }, { id: "a" }, { id: "a" }, {}] }), ["a", "b"]);
  assert.deepEqual(parseOpenaiModels({ models: [{ slug: "gpt-6-astra", use_responses_lite: true }, { slug: "gpt-5.5" }] }), ["gpt-5.5", "gpt-6-astra"]);
  assert.deepEqual(parseOpenaiModels(["z", "y", ""]), ["y", "z"]);
  assert.deepEqual(parseOpenaiModels({ models: "nope" }), []);
  assert.deepEqual(parseOpenaiModels(null), []);
});
