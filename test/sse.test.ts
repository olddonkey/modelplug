import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeLines, decodeNdjson, decodeSse, encodeSse } from "../src/sse.ts";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

test("lines survive CRLF and chunk boundaries inside UTF-8 sequences", async () => {
  const bytes = new TextEncoder().encode("héllo\r\nwörld\n");
  const parts = [bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9)];
  const s = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
  assert.deepEqual(await collect(decodeLines(s)), ["héllo", "wörld"]);
});

test("sse: multi-line data, event names, comments, and a tail without blank line", async () => {
  const msgs = await collect(
    decodeSse(stream([": keepalive\n", "event: delta\ndata: {\"a\":1}\n", "data: more\n\n", "data:[DONE]"])),
  );
  assert.deepEqual(msgs, [
    { event: "delta", data: '{"a":1}\nmore' },
    { data: "[DONE]" },
  ]);
});

test("sse: blank lines without data do not emit", async () => {
  assert.deepEqual(await collect(decodeSse(stream(["\n\n", "event: x\n\n", "data: y\n\n"]))), [{ data: "y" }]);
});

test("ndjson skips blank lines", async () => {
  assert.deepEqual(await collect(decodeNdjson(stream(['{"a":1}\n', "\n", '{"b":2}']))), ['{"a":1}', '{"b":2}']);
});

test("encodeSse round-trips through decodeSse", async () => {
  const text = encodeSse("response.output_text.delta", '{"delta":"line1\\nline2"}') + encodeSse(undefined, "x\ny");
  const msgs = await collect(decodeSse(stream([text])));
  assert.deepEqual(msgs, [
    { event: "response.output_text.delta", data: '{"delta":"line1\\nline2"}' },
    { data: "x\ny" },
  ]);
});
