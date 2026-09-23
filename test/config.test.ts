import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, configFromEnv, interpolateEnv, parseConfig, resolveConfig } from "../src/config.ts";

test("preset supplies wire, baseUrl and capabilities; user overrides win", () => {
  const c = parseConfig(
    { providers: { ds: { preset: "deepseek", apiKey: "k", capabilities: { images: true } } } },
    "test",
  );
  const ds = c.providers.ds!;
  assert.equal(ds.wire, "openai-chat");
  assert.equal(ds.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(ds.capabilities.reasoning, "reasoning_content");
  assert.equal(ds.capabilities.images, true);
});

test("grok preset resolves a subscription credential with Responses and passthrough disabled", () => {
  const p = parseConfig({ providers: { grok: { preset: "grok" } } }, "test").providers.grok!;
  assert.equal(p.wire, "openai-responses");
  assert.equal(p.baseUrl, "https://api.x.ai/v1");
  assert.equal(p.credential, "grok");
  assert.equal(p.passthrough, false);
  assert.deepEqual(p.capabilities.reasoningLevels, ["low", "high"]);
});

test("kimi preset resolves to the Kimi credential and Code API", () => {
  const kimi = parseConfig({ providers: { kimi: { preset: "kimi" } } }, "test").providers.kimi!;
  assert.equal(kimi.wire, "openai-chat");
  assert.equal(kimi.baseUrl, "https://api.kimi.com/coding/v1");
  assert.equal(kimi.credential, "kimi");
  assert.equal(kimi.capabilities.reasoning, "reasoning_content");
  assert.equal(kimi.capabilities.tools, true);
  assert.equal(kimi.capabilities.images, true);
  assert.equal(kimi.capabilities.temperature, true);
});

test("a wire alone has no base URL; the error names the presets that set one", () => {
  assert.throws(() => parseConfig({ providers: { a: { wire: "anthropic", apiKey: "k" } } }, "test"), /baseUrl.*required.*preset.*anthropic/);
  assert.throws(() => parseConfig({ providers: { l: { wire: "openai-chat" } } }, "test"), /baseUrl.*required/);
  const ok = parseConfig({ providers: { a: { preset: "anthropic", apiKey: "k" } } }, "test");
  assert.equal(ok.providers.a!.baseUrl, "https://api.anthropic.com");
});

test("trailing slash is stripped and non-http rejected", () => {
  const c = parseConfig({ providers: { l: { wire: "openai-chat", baseUrl: "http://localhost:11434/v1/" } } }, "test");
  assert.equal(c.providers.l!.baseUrl, "http://localhost:11434/v1");
  assert.throws(() => parseConfig({ providers: { l: { wire: "openai-chat", baseUrl: "localhost:11434" } } }, "test"), /http/);
});

test("unknown keys, bad provider names and unknown presets are rejected", () => {
  assert.throws(() => parseConfig({ providers: {}, nope: 1 }, "test"), ConfigError);
  assert.throws(() => parseConfig({ providers: { "Bad/Name": { wire: "anthropic" } } }, "test"), ConfigError);
  assert.throws(() => parseConfig({ providers: { a: { preset: "nonexistent" } } }, "test"), /unknown preset/);
});

test("toggle reasoning requires the toggle payload", () => {
  assert.throws(
    () => parseConfig({ providers: { q: { wire: "openai-chat", baseUrl: "http://x", capabilities: { reasoning: "toggle" } } } }, "test"),
    /reasoningToggle/,
  );
});

test("alias colliding with a provider and bad defaultProvider are rejected", () => {
  assert.throws(() => parseConfig({ providers: { a: { wire: "anthropic" } }, aliases: { a: "a/x" } }, "test"), /collides/);
  assert.throws(() => parseConfig({ providers: { a: { wire: "anthropic" } }, defaultProvider: "b" }, "test"), /defaultProvider/);
});

test("env interpolation replaces every string leaf and reports all missing names at once", () => {
  const out = interpolateEnv({ a: "${X}", b: ["${Y}-${X}"], c: { d: 1 } }, { X: "1", Y: "2" }) as { a: string; b: string[]; c: { d: number } };
  assert.deepEqual(out, { a: "1", b: ["2-1"], c: { d: 1 } });
  assert.throws(() => interpolateEnv({ a: "${MISSING_ONE}", b: "${MISSING_TWO}" }, {}), /MISSING_ONE, MISSING_TWO/);
});

test("environment-only single provider mode", () => {
  const c = configFromEnv({ MODELPLUG_PRESET: "deepseek", DEEPSEEK_API_KEY: "sk" });
  assert.ok(c);
  const resolved = resolveConfig(c, "env");
  assert.equal(resolved.defaultProvider, "default");
  assert.equal(resolved.providers.default!.apiKey, "sk");
  assert.equal(configFromEnv({}), undefined);
  assert.throws(() => configFromEnv({ MODELPLUG_WIRE: "carrier-pigeon" }), /MODELPLUG_WIRE/);
});

test("passthrough defaults by credential kind, presets and explicit overrides", () => {
  const config = parseConfig({ providers: {
    key: { wire: "openai-responses", baseUrl: "https://example.test/v1", apiKey: "k" },
    openai: { preset: "openai", apiKey: "k" },
    chatgpt: { preset: "chatgpt" },
    anth: { preset: "anthropic", apiKey: "k" },
    forced: { preset: "openai", apiKey: "k", passthrough: true },
    disabled: { preset: "chatgpt", passthrough: false },
    overridepreset: { preset: "anthropic", apiKey: "k", passthrough: false },
    credentialoverride: { preset: "openai", credential: "chatgpt" },
  } }, "test");
  for (const name of ["key", "openai", "disabled", "overridepreset"]) assert.equal(config.providers[name]?.passthrough, false, name);
  for (const name of ["chatgpt", "anth", "forced", "credentialoverride"]) assert.equal(config.providers[name]?.passthrough, true, name);
  assert.throws(() => parseConfig({ providers: { p: { preset: "openai", passthrough: "yes" } } }, "test"), ConfigError);
});

test("a provider on the anthropic wire relays bytes by default; the switch still turns it off", () => {
  const config = parseConfig({ providers: {
    bare: { wire: "anthropic", baseUrl: "https://a.test", apiKey: "k" },
    off: { wire: "anthropic", baseUrl: "https://a.test", apiKey: "k", passthrough: false },
    resp: { wire: "openai-responses", baseUrl: "https://r.test/v1", apiKey: "k" },
  } }, "test");
  assert.equal(config.providers.bare?.passthrough, true);
  assert.equal(config.providers.off?.passthrough, false);
  assert.equal(config.providers.resp?.passthrough, false);
});
