import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { credentialProviderFor } from "../src/credentials/index.ts";

const config = parseConfig(
  {
    providers: {
      keyed: { preset: "deepseek", apiKey: "sk-test" },
      local: { wire: "openai-chat", baseUrl: "http://localhost:11434/v1" },
    },
  },
  "test",
);

test("credential kind defaults to api-key", () => {
  assert.equal(config.providers.keyed!.credential, "api-key");
  assert.throws(() => parseConfig({ providers: { x: { preset: "deepseek", credential: "carrier-pigeon" } } }, "test"));
});

test("api-key provider hands out the configured key on every attempt", async () => {
  const provider = credentialProviderFor(config.providers.keyed!);
  const target = { provider: "keyed", model: "m" };
  const first = await provider.resolve(target, 1);
  const third = await provider.resolve(target, 3, "conv-1");
  assert.deepEqual(first, { id: "key", apiKey: "sk-test" });
  assert.deepEqual(third, first);
  await provider.report(target, first, { outcome: "ok" });
});

test("a provider without a key resolves to a credential without one", async () => {
  const credential = await credentialProviderFor(config.providers.local!).resolve({ provider: "local", model: "m" }, 1);
  assert.deepEqual(credential, { id: "key" });
  assert.equal("apiKey" in credential, false);
});
