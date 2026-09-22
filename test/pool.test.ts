/**
 * Milestone 4 exit criterion, end to end through the HTTP shell: with two
 * accounts and an upstream that exhausts one of them mid-session, conversations
 * continue on the other with no client-visible error, and a conversation stays
 * on its account until that account is exhausted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { saveCredentialStore, type ChatgptAccount } from "../src/credentials/store.ts";
import { createPipeline } from "../src/pipeline.ts";
import { createServer } from "../src/server.ts";
import { AUTH_CLAIM, close, fakeJwt, fakeUpstream, listen } from "./helpers.ts";

const FAR = Math.floor(Date.now() / 1000) + 86_400;
const SSE = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n';

function account(id: string): ChatgptAccount {
  return { id, accountId: id, email: `${id}@example.com`, accessToken: fakeJwt({ exp: FAR, [AUTH_CLAIM]: { chatgpt_account_id: id } }), refreshToken: `r-${id}`, lastRefresh: "x", source: "login" };
}

test("two accounts: the exhausted one is cooled down and every conversation carries on with the other", async () => {
  const accountsSeen: string[] = [];
  const upstream = await fakeUpstream([
    (req, res) => {
      const id = String(req.headers["chatgpt-account-id"]);
      accountsSeen.push(id);
      if (id === "a" && accountsSeen.filter(x => x === "a").length >= 4) {
        res.writeHead(429, {
          "content-type": "application/json",
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-after-seconds": "2700",
        });
        res.end(JSON.stringify({ error: { type: "usage_limit_reached", message: "You have hit your usage limit.", resets_in_seconds: 2700 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": id === "a" ? "80" : "10", "x-codex-primary-window-minutes": "300" });
      res.end(SSE);
    },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "wb-pool-e2e-"));
  const storePath = join(dir, "credentials.json");
  saveCredentialStore(storePath, { schemaVersion: 1, chatgpt: { accounts: [account("a"), account("b")] } });
  const config = parseConfig({ providers: { chatgpt: { preset: "chatgpt", baseUrl: `http://127.0.0.1:${upstream.port}`, strategy: "fill-first" } }, defaultProvider: "chatgpt" }, "test");
  const sleeps: number[] = [];
  const logs: string[] = [];
  const pipeline = createPipeline(config, {
    storePath,
    usageLogPath: null,
    log: m => logs.push(m),
    attempt: { policy: { maxAttemptsPerTarget: 3, baseDelayMs: 10, maxDelayMs: 100 }, sleep: async ms => void sleeps.push(ms) },
  });
  const server = createServer(config, pipeline.handlers, "test", { statusLines: pipeline.statusLines });
  const port = await listen(server);
  const turn = async (conversation: string): Promise<void> => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", store: false, stream: true, prompt_cache_key: conversation }),
    });
    assert.equal(res.status, 200, `conversation ${conversation} must never see the exhaustion`);
    assert.equal(await res.text(), SSE);
  };
  try {
    await turn("conv-1");
    await turn("conv-1");
    await turn("conv-2");
    assert.deepEqual(accountsSeen, ["a", "a", "a"], "fill-first keeps everything on a while it is usable");
    await turn("conv-1"); // a's third answer is the 429: the proxy retries on b inside the same request
    assert.deepEqual(accountsSeen, ["a", "a", "a", "a", "b"]);
    assert.deepEqual(sleeps, [], "a credential rotation does not back off");
    await turn("conv-2");
    await turn("conv-3");
    assert.deepEqual(accountsSeen.slice(5), ["b", "b"], "old and new conversations both land on b while a cools down");
    assert.match(logs.join("\n"), /account a hit its usage limit; cooling down for 45m; rotating/);
    const status = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(status, /a@example.com.*\[cooling down, 45m left\].*5h: 100% used/);
    assert.match(status, /b@example.com.*5h: 10% used/);
  } finally {
    await close(server);
    await close(upstream.server);
  }
});
