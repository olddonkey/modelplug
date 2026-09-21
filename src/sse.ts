/** The only SSE and NDJSON codec in modelplug. */

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

/** Split a byte stream into lines, tolerating CRLF and UTF-8 sequences across chunks. */
export async function* decodeLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
}

/**
 * Parse text/event-stream. Multi-line `data:` is joined with "\n"; comments
 * and `retry:` are ignored; a trailing message without a final blank line is
 * still delivered because some upstreams end that way.
 */
export async function* decodeSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SseMessage> {
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  const flush = (): SseMessage | undefined => {
    if (data.length === 0) {
      event = undefined;
      id = undefined;
      return undefined;
    }
    const message: SseMessage = { data: data.join("\n") };
    if (event !== undefined) message.event = event;
    if (id !== undefined) message.id = id;
    data = [];
    event = undefined;
    id = undefined;
    return message;
  };

  for await (const line of decodeLines(body)) {
    if (line === "") {
      const message = flush();
      if (message) yield message;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        data.push(value);
        break;
      case "event":
        event = value;
        break;
      case "id":
        id = value;
        break;
      default:
        break;
    }
  }
  const tail = flush();
  if (tail) yield tail;
}

export async function* decodeNdjson(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  for await (const line of decodeLines(body)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) yield trimmed;
  }
}

export function encodeSse(event: string | undefined, data: string): string {
  const lines = data.split("\n").map(l => `data: ${l}`).join("\n");
  return event === undefined ? `${lines}\n\n` : `event: ${event}\n${lines}\n\n`;
}
