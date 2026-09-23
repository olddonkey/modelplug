# openai-chat fixtures

Recorded 2026-09-23 straight from Kimi K3 (`api.kimi.com/coding/v1`, a
subscription token, `stream_options.include_usage: true`), untouched except
for the file names. Each `.sse` has an `.events.json` twin holding the
`Event[]` a correct decode produces; `test/wire-openai-chat-fixtures.test.ts`
decodes every file whole and in seven-byte chunks and compares.

| Fixture | Pins |
|---|---|
| `text` | `reasoning_content` deltas before `content`; `finish_reason: stop` in the last content chunk; `usage` in a trailing chunk with empty `choices`; `prompt_tokens_details` present but empty; `completion_tokens_details.reasoning_tokens`. |
| `tool-call-arguments-in-chunks` | One `tool_calls[0]` whose `function.arguments` arrive over four chunks after the chunk that carried `id` and `name`; `finish_reason: tool_calls`. |
| `parallel-tool-calls` | Two calls by `index`, each announced with its own `id`; both closed at `finish_reason: tool_calls`. |
| `kimi-reasoning-content` | A long run of `reasoning_content` deltas, then a one-token answer; `reasoning_tokens` counted in usage. |
| `finish-length-inside-reasoning` | `max_tokens: 5` spent entirely on reasoning: `finish_reason: length` with no `content` at all. The decode must still end with `done` (`max_tokens`), not an error. |

Still missing (need the provider): DeepSeek `reasoning_content` in a tool-call
turn, `usage` inside the last content chunk, an `{"error": …}` payload mid
stream, a stream that ends without `finish_reason`.
