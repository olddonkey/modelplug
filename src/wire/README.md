# Wire modules

A wire speaks one upstream protocol and nothing else. Four are planned, in this
order, because each one forces a decision the next one depends on:

| # | Wire | Forces the decision about |
|---|---|---|
| 1 | `openai-chat` | Tool-call argument streaming, `reasoning_content`, thinking toggles, strict usage fields |
| 2 | `anthropic` | The `Opaque` envelope for thinking signatures, tool_result pairing, budget mapping |
| 3 | `gemini` | Thought signatures as a second `Opaque` kind, function-call id synthesis |
| 4 | `openai-responses` | Passing hosted tools through, `encrypted_content` as `Opaque` |

## Contract

Implement `Wire` from `../ir.ts`:

- `encode(turn, caps, target, stream)` builds the upstream request. Read `caps`
  for every provider difference. Never read `target.name` to branch behaviour.
- `decode(response, caps, target)` yields `Event`s and ends with exactly one
  `done` or `error`. Use `decodeSse` / `decodeNdjson` from `../sse.ts`; do not
  write a frame reader.
- `classifyError(status, headers, bodyText, target)` is the only place that
  reads upstream error text. Return a `WireError` with `retryable` set
  honestly; the attempt loop will not second-guess it.
- `modelsRequest(target)` and `parseModels(body)` are optional: the GET that
  lists models and how to read its answer. `check` and `/v1/models` use them;
  nothing on the request path does.
- `passthroughHeaders(target)` is optional: auth and protocol headers the wire
  injects when the client and upstream speak the same protocol.

The `anthropic` wire's `Opaque` carries thinking text with its signature and
replays it to the provider that minted it, across models.

## Rules

- No retries, no backoff, no credential selection. Those live in `attempt.ts`
  and the caller.
- No provider names outside your own file. If two providers on the same wire
  differ, that difference is a `Capabilities` value or it is a fixture-backed
  middleware inside this wire, named after the behaviour, not the vendor.
- An `Opaque` you did not mint is dropped, never forwarded.
- Every quirk you handle gets a fixture: recorded upstream frames in
  `test/fixtures/<wire>/<name>.sse` and the expected `Event[]` next to it. The
  fixture's name says what breaks without it.
- Usage is normalized here, once. `Usage.inputTokens` includes cache reads and
  writes; `outputTokens` includes reasoning.
