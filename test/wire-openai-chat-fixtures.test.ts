/** Golden fixtures for the Chat Completions decode: recorded frames in, `Event[]` out. See test/fixtures/openai-chat/README.md. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Capabilities, Event, ProviderTarget } from "../src/ir.ts";
import { decodeChatStream } from "../src/wire/openai-chat.ts";

const DIR = fileURLToPath(new URL("./fixtures/openai-chat/", import.meta.url));
const caps: Capabilities = { reasoning: "reasoning_content", tools: true, images: true, temperature: true, stream: "sse" };
const target: ProviderTarget = { name: "p", baseUrl: "https://example.invalid/v1" };

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, at + size));
      at += size;
    },
  });
}

async function decode(name: string, chunkSize?: number): Promise<Event[]> {
  const text = readFileSync(DIR + name, "utf8");
  const body = chunkSize ? chunked(text, chunkSize) : text;
  const out: Event[] = [];
  for await (const e of decodeChatStream(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }), caps, target)) out.push(e);
  return out;
}

const fixtures = readdirSync(DIR).filter(f => f.endsWith(".sse")).sort();
assert.ok(fixtures.length >= 5, "fixtures are present");

for (const file of fixtures) {
  test(`golden: ${file} decodes to its events.json, whole and in 7-byte chunks`, async () => {
    const expected = JSON.parse(readFileSync(DIR + file.replace(/\.sse$/, ".events.json"), "utf8")) as Event[];
    assert.deepEqual(await decode(file), expected);
    assert.deepEqual(await decode(file, 7), expected);
    const terminals = expected.filter(e => e.type === "done" || e.type === "error");
    assert.equal(terminals.length, 1, "exactly one terminal event");
    assert.equal(expected.at(-1), terminals[0], "the terminal event is last");
  });
}

test("golden semantics: usage from the trailing chunk, parallel calls, length inside reasoning", async () => {
  const text = await decode("text.sse");
  const done = text.at(-1)!;
  assert.equal(done.type, "done");
  assert.deepEqual(done.usage, { inputTokens: 94, outputTokens: 108, reasoningTokens: 66 });
  assert.equal(done.stopReason, "end_turn");
  assert.equal(text[0]!.type, "reasoning_delta", "Kimi thinks before it answers");
  assert.match(text.filter(e => e.type === "text_delta").map(e => e.text).join(""), /^I’m Kimi/);

  const parallel = await decode("parallel-tool-calls.sse");
  const starts = parallel.filter(e => e.type === "tool_call_start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0]!.id, starts[1]!.id);
  const args = (id: string) => JSON.parse(parallel.flatMap(e => (e.type === "tool_call_delta" && e.id === id ? [e.argumentsDelta] : [])).join("")) as { cmd: string };
  assert.deepEqual([args(starts[0]!.id).cmd, args(starts[1]!.id).cmd], ["ls -la", "date"]);
  assert.deepEqual(parallel.filter(e => e.type === "tool_call_end").map(e => e.id), [starts[0]!.id, starts[1]!.id]);
  assert.equal((parallel.at(-1) as { stopReason: string }).stopReason, "tool_use");

  const single = await decode("tool-call-arguments-in-chunks.sse");
  assert.ok(single.filter(e => e.type === "tool_call_delta").length >= 3, "arguments arrived over several chunks");

  const length = await decode("finish-length-inside-reasoning.sse");
  assert.equal((length.at(-1) as { stopReason: string }).stopReason, "max_tokens");
  assert.equal(length.filter(e => e.type === "text_delta").length, 0, "the budget was spent on reasoning");
  assert.ok(length.filter(e => e.type === "reasoning_delta").length > 0);
});
