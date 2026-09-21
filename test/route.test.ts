import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { RouteError, resolveRoute } from "../src/route.ts";

const config = parseConfig(
  {
    providers: {
      deepseek: { preset: "deepseek", apiKey: "k" },
      anthropic: { preset: "anthropic", apiKey: "k" },
      openrouter: { preset: "openrouter", apiKey: "k" },
    },
    aliases: {
      fast: ["deepseek/deepseek-v4", "openrouter/moonshotai/kimi-k2"],
      best: "anthropic/claude-opus-5",
      nested: ["best", "fast"],
      loop: ["loop"],
    },
  },
  "test",
);

test("explicit provider/model", () => {
  assert.deepEqual(resolveRoute(config, "anthropic/claude-sonnet-5"), [{ provider: "anthropic", model: "claude-sonnet-5" }]);
});

test("inner slashes belong to the model", () => {
  assert.deepEqual(resolveRoute(config, "openrouter/moonshotai/kimi-k2"), [{ provider: "openrouter", model: "moonshotai/kimi-k2" }]);
});

test("alias list is the fallback order", () => {
  assert.deepEqual(resolveRoute(config, "fast"), [
    { provider: "deepseek", model: "deepseek-v4" },
    { provider: "openrouter", model: "moonshotai/kimi-k2" },
  ]);
});

test("aliases nest and dedupe", () => {
  assert.deepEqual(resolveRoute(config, "nested").map(t => `${t.provider}/${t.model}`), [
    "anthropic/claude-opus-5",
    "deepseek/deepseek-v4",
    "openrouter/moonshotai/kimi-k2",
  ]);
});

test("alias cycle is rejected", () => {
  assert.throws(() => resolveRoute(config, "loop"), (err: unknown) => err instanceof RouteError && err.code === "alias_cycle");
});

test("unknown prefix with several providers is an error", () => {
  assert.throws(() => resolveRoute(config, "nope/model"), (err: unknown) => err instanceof RouteError && err.code === "unknown_provider");
  assert.throws(() => resolveRoute(config, "bare-model"), (err: unknown) => err instanceof RouteError && err.code === "no_default_provider");
});

test("single provider or defaultProvider takes bare models", () => {
  const single = parseConfig({ providers: { only: { preset: "groq", apiKey: "k" } } }, "test");
  assert.deepEqual(resolveRoute(single, "llama-4"), [{ provider: "only", model: "llama-4" }]);
  const withDefault = parseConfig(
    { providers: { a: { preset: "groq", apiKey: "k" }, b: { preset: "deepseek", apiKey: "k" } }, defaultProvider: "b" },
    "test",
  );
  assert.deepEqual(resolveRoute(withDefault, "x"), [{ provider: "b", model: "x" }]);
});
