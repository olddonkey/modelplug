# modelplug plan

Milestone 1 (skeleton) is done: IR, config, route, attempt loop, SSE codec,
HTTP shell, 25 tests. This document plans milestone 2 in detail and the rest
in outline. Each milestone has an exit criterion that is observable, not a
feeling.

Working rules for every milestone:

- Every provider quirk lands as a fixture first, code second. The fixture name
  says what breaks without it.
- No provider name outside `src/wire/<name>.ts`, `src/credentials/` and
  `src/presets.json`. `test/boundary.test.ts` greps every string literal for
  preset and vendor names to enforce it; the CLI's help text and the
  `--forward` tooling are the only other exemptions.
- Nothing from the non-goals list in `DESIGN.md`, however small it looks.
- One PR per step below. CI green before merge.

---

## Milestone 2: ChatGPT subscription through the same protocol

The user's daily driver, and the first thing built because the user runs it
every day. Scope is one account, imported, with the passthrough path; the pool
is milestone 4. Ships in this skeleton: `src/credentials/chatgpt.ts`,
`src/pipeline.ts`, `src/wire/openai-responses.ts` (classifyError only),
`login chatgpt --import`, `account list|use|remove`, `logout chatgpt`.

1. **Import.** `modelplug login chatgpt --import` reads `~/.codex/auth.json`
   read-only: access token, refresh token, id token (decode the JWT payload for
   the account id and email), last refresh time. Store under
   `credentials.json` (0600). Never write to `~/.codex`.
2. **Refresh.** `POST https://auth.openai.com/oauth/token` with
   `grant_type=refresh_token` and Codex's client id, proactively when the access
   token has under five minutes left, reactively on a 401 once. A refresh
   failure marks the account `needs-login` and `check` says so.
3. **Preset and dialect.** Preset `chatgpt`: wire `openai-responses`, base URL
   `https://chatgpt.com/backend-api/codex`, credential kind `chatgpt`. The
   credential supplies `Authorization: Bearer`, `chatgpt-account-id`,
   `OpenAI-Beta: responses=experimental`, `originator`, and passes through the
   client's `User-Agent` and session headers. Record the dialect first with
   `--record --forward https://chatgpt.com/backend-api/codex --forward-header
   chatgpt-account-id=…` and the imported token, then pin the required and
   forbidden body fields as fixtures.
4. **Passthrough.** In the pipeline: when the ingress is `responses` and the
   wire is `openai-responses`, skip encode/decode and relay. Non-2xx: read the
   body, `wire.classifyError`, `report`, let the attempt loop decide. 2xx: tee
   the stream only to read the final `response.completed` usage for the log,
   never buffer. Inject headers, relay bytes, read status and headers. No
   payload rewrites.
5. **Quota.** `report()` receives the response headers; the chatgpt credential
   parses the primary and secondary window used-percent and reset-after
   headers and keeps them in memory. `modelplug account list` shows them.

**Status (2026-09-21): built and smoke-tested.** Real Codex 0.153.4 ran a
hello turn and a shell-tool turn through the pipeline against the live backend;
the status page showed the imported account's quota; `usage.jsonl` carried the
token counts. 50 tests green.

Two backend quirks learned on the way, both handled without payload rewrites:

- The Codex backend streams SSE **without a `content-type` header**. Codex does
  not care; modelplug relays the headers faithfully and the usage probe sniffs
  the body (`event:`/`data:` versus `{`) instead of trusting the header.
- Quota headers on a Pro account: `x-codex-primary-*` is the **weekly** window
  (`window-minutes: 10080`, `used-percent`, `reset-at` epoch seconds,
  `reset-after-seconds`), `x-codex-secondary-*` was present but empty
  (`window-minutes: 0`, empty `reset-at`). Also seen: `x-codex-plan-type`,
  `x-codex-active-limit`, `x-codex-credits-balance`, `x-codex-credits-has-credits`,
  `x-codex-safety-buffering-*`, and an opaque `x-codex-turn-state`. The status
  page labels windows by their minutes, not by position.

**Acceptance (2026-09-23), Codex 0.155.1 through the milestone-4 pool code:**
`login chatgpt --import`, then `codex exec` with a `-c model_providers.modelplug`
override on port 10111 (opencodex keeps 10100): a hello turn and an `npm test`
turn (Lite dialect, `custom_tool_call` through `exec`) both 200, usage log
filled, status page showed the weekly window at 66%. Two backend facts learned:

- `GET /models` needs `client_version=<codex version>` and gates the list by
  it (0.0.1 sees nothing, 0.155.1 sees ten models). The response is
  `{models:[{slug, use_responses_lite, context_window, …}]}`, not `{data}`.
  The wire sends a named constant and parses both shapes; `check` now says
  "reachable, 10 models" for the subscription.
- A plan without a secondary window still gets `x-codex-secondary-*` headers
  with `window-minutes: 0`; the status page shows that window as n/a.

Exit criterion still open: a full working day on the subscription without
switching back to opencodex, with hosted web search, compaction and
`apply_patch` behaving exactly as with native Codex.

## Milestone 3: Codex talks to DeepSeek

**Status (2026-09-22): built; steps 0 to 8 done, step 9 docs done.**
`src/ingress/responses.ts` (parse + respond), `src/wire/openai-chat.ts`
(encode + decode + classify) and the IR path in `src/pipeline.ts` are in. Real
Codex 0.153.4 ran a hello turn and a shell-tool loop (tool call, tool result,
summary) through modelplug to Kimi K3 over Chat Completions. Since then:
`check` probes every provider and `/v1/models` fills from the network (step 7);
the conformance scenario and the boundary test are in and green (step 8), and
making the boundary test pass moved the last provider knowledge out of the
kernel (no per-wire default base URLs; credential kinds report their own status
lines); `custom_tool_call_input.delta` now streams raw input text like the
native backend, decoded progressively out of the lowered arguments;
`docs/CLIENTS.md` is written. 77 tests green.

**Acceptance (2026-09-23), Codex 0.155.1 → modelplug → Kimi K3
(`api.kimi.com/coding/v1`, the subscription token, Chat Completions):** a hello
turn, an `npm test` turn through the shell, and an `apply_patch` turn that
edited README.md and re-ran the tests, and a `view_image` turn on a generated
PNG that Kimi described correctly ("a solid red square centered on a white
background"): nine requests, all 200, usage log with reasoning tokens. That is
the exit criterion below, met on Kimi. Learned on the way:

- Codex 0.155.1's **classic** dialect declares code mode's `exec` as a
  `custom` tool (lark grammar) beside `wait`, `request_user_input*`, the
  `clock` and `mcp__*` namespaces and `web_search`; the model calls the
  lowered `exec` with JavaScript and Codex's host runs it. The generic
  custom-tool lowering carried it unchanged; the "dormant" remark under the
  step-0 consequences is void. Fixtures: `test/fixtures/responses/classic-0.155/`.
- Step-4 decision 1 for Kimi: the tool loop ran across turns with reasoning
  text never replayed, so no `reasoning_content` replay is needed there.
  DeepSeek is still unmeasured (no key).
- Step-5 golden fixtures recorded from Kimi: `test/fixtures/openai-chat/`,
  five streams including `finish_reason: length` spent entirely on reasoning;
  each is decoded whole and in seven-byte chunks.

Still open: the DeepSeek run (no key), `max_tokens` naming (Codex never sends
`max_output_tokens`, so it has not mattered), and a Kimi login credential kind
so the subscription token refreshes itself (planned for milestone 7; worth
pulling forward, the maintainer has a subscription and no API key, and a
borrowed token lasts minutes).

**Goal.** `responses` ingress + `openai-chat` wire + the pipeline that joins
them. Real Codex completes a multi-step coding task against DeepSeek through
modelplug.

**Exit criterion.** With `modelplug print codex` pasted into
`~/.codex/config.toml`, Codex runs a task that (1) calls `shell`, (2) edits a
file with `apply_patch`, (3) runs tests and reads the result, (4) sends an
image via `view_image` when the model supports images, and finishes without
any proxy-originated error. All tests pass. `openai-chat` also passes the
conformance scenario once it exists (step 8).

**Size.** ~2.5k lines of source, ~1k of tests plus fixtures. One focused week,
two part-time.

### Step 0. Record real Codex traffic before designing anything

`modelplug start --record <dir> [--forward <baseUrl>]` (done in the skeleton):

- `--record` writes every `/v1/*` POST body to `<dir>/<timestamp>-<route>.json`
  and whatever the server streams back to `<dir>/<timestamp>-<route>.sse`,
  with status and headers in a `.meta.json` twin. No sanitizing; it is the
  user's own disk.
- `--forward` relays those requests byte for byte to a real Responses-compatible
  upstream (`https://api.openai.com/v1` with an API key, or any other endpoint
  that speaks Responses), so Codex gets real answers and a conversation can run
  for several turns. The key comes from `MODELPLUG_FORWARD_KEY`; extra headers
  from repeated `--forward-header k=v`. Without `--forward`, requests are
  recorded and answered 501, which only yields first-turn fixtures.

Point the user's Codex at the recorder with `print codex` and capture:

| Fixture | How to trigger |
|---|---|
| `first-turn.request.json` | New session, a one-line prompt |
| `tool-call-turn.request.json` | A prompt that needs `shell` (e.g. "list files") |
| `tool-result-turn.request.json` | The turn after the tool ran |
| `apply-patch-turn.request.json` | "Add a comment to README" |
| `image-turn.request.json` | `view_image` on a PNG |
| `with-reasoning-history.request.json` | Third turn of a session with reasoning on |

The `.sse` twins recorded from a real Responses upstream are the ground truth
for step 3: the exact event names, order, and `usage` shape a compliant server
emits. Sanitize by hand (paths, prompt content), commit under
`test/fixtures/responses/`. Every parse test in step 2 reads these. This step
also answers three open questions by inspection instead of memory:

- Which item types Codex actually sends (`message`, `function_call`,
  `function_call_output`, `reasoning`, `custom_tool_call`, `custom_tool_call_output`, `compaction`).
- Whether this Codex version sends `type: "namespace"` tool groups.
- Which fields ride along (`include`, `prompt_cache_key`, `text.verbosity`,
  `service_tier`, `store`).

### Step 0 findings (recorded 2026-09-21, Codex 0.153.4, real ChatGPT backend)

Recorded with `--record --forward https://chatgpt.com/backend-api/codex` and the
imported Codex login; 22 requests over four scenarios in two dialects. The
fixtures live in `test/fixtures/responses/{classic,lite}/`.

**Codex chooses its wire dialect by model name.** This is the single most
important fact for the design.

| | Classic (model name Codex does not recognise, e.g. `deepseek/…`) | Responses Lite (OpenAI model names such as `gpt-5.6-sol`) |
|---|---|---|
| Marker header | none | `x-openai-internal-codex-responses-lite: true` |
| System prompt | `instructions` (~17k chars) plus a developer `<skills_instructions>` message | no `instructions`; four developer messages in `input` |
| Tool catalog | top-level `tools`: functions `exec_command`, `write_stdin`, `request_user_input`, `view_image`, `get_goal`, `create_goal`, `update_goal`; a `namespace` `multi_agent_v1`; hosted `web_search` with the private `external_web_access` bit | `tools: []`; an `additional_tools` **input item** holding namespaces `functions` (custom `exec`, `wait`, `request_user_input`) and `collaboration` |
| Tool calls | `function_call` / `function_call_output` (`output` is a string); `apply_patch` is run through `exec_command` with a heredoc, there is no apply_patch tool | `custom_tool_call` named `exec` whose `input` is JavaScript calling `tools.exec_command(...)` / `tools.apply_patch(...)`; `custom_tool_call_output.output` is a list of `input_text` parts |
| Reasoning | `reasoning: {effort, summary: "auto"}` | `reasoning: {effort, context: "all_turns"}`, plus `text: {verbosity}` |
| `parallel_tool_calls` | `true` | `false` |
| Replayed reasoning | `reasoning` items with `encrypted_content` (~1.3k chars) and empty `summary` in both dialects | |
| Images | `input_image` with a `data:image/png;base64,…` URL and `detail: "high"` in both | |
| Common | `store: false`, `stream: true`, `include: ["reasoning.encrypted_content"]`, `prompt_cache_key` = session id, `client_metadata` | |

Request headers Codex sends: `originator`, `session-id`, `thread-id`,
`x-client-request-id`, `x-codex-turn-metadata` (JSON with `installation_id`),
`x-codex-window-id`, `x-codex-beta-features: remote_compaction_v2`, and a
`user-agent` like `codex_exec/0.153.4 (Mac OS 27.0.0; arm64)`. No `OpenAI-Beta`.
The ChatGPT backend accepted both dialects with only `Authorization: Bearer`
and `chatgpt-account-id` added, and rejected an unknown model name with
`400 {"detail": "The '…' model is not supported when using Codex with a ChatGPT account."}`.

Response SSE observed: `response.created`, `response.in_progress`,
`response.output_item.added/done`, `response.content_part.added/done`,
`response.output_text.delta/done`, `response.function_call_arguments.delta/done`
(classic), `response.custom_tool_call_input.delta/done` (Lite), reasoning items
as `output_item` in Lite, and `response.completed` whose `usage` is
`{input_tokens, input_tokens_details: {cached_tokens, cache_write_tokens}, output_tokens, output_tokens_details: {reasoning_tokens}, total_tokens, attribution}`.
Message items carry `internal_chat_message_metadata_passthrough`; ignore it.

Consequences:

- **The routed path only needs the classic dialect.** A routed model always has a
  `provider/model` name, so Codex always sends classic shape to it. The
  ingress must still recognise Lite items (`additional_tools`,
  `custom_tool_call`) well enough to answer a clear 400 that names the fix:
  "use a `provider/model` name or route this model through the chatgpt
  provider".
- **The passthrough must not touch Lite.** The recommended config is
  `defaultProvider: "chatgpt"` with bare OpenAI model names, so Codex keeps
  Lite and code mode; a `chatgpt/gpt-5.6-sol` name would silently downgrade
  Codex to the classic dialect (it works, the backend accepted renamed classic
  requests, but code mode is lost).
- The freeform `apply_patch` lowering planned below was dormant with 0.153.4:
  classic Codex declared no custom tool. 0.155.1 does (`exec`, see the
  milestone 3 acceptance note), so the generic custom-tool lowering (one
  string parameter named `input`) is live; the apply_patch-specific envelope
  repair stays dropped.
- `features.code_mode_host = false` does **not** switch Codex to classic
  tools; it only disables the host and the model keeps calling `exec`. Do not
  recommend it.

### Step 1. Freeze the ingress-side lowering table

The Responses request contains things no Chat Completions provider can take.
The ingress handles all of them **before** the IR so wires never see them, and
records what it did in `ParsedIngress` (request-local, no server state) so
`respond` can restore the client's shape on the way back.

| Responses feature | Ingress action | Restore on output |
|---|---|---|
| `tools[].type: "namespace"` (`multi_agent_v1` in classic) | Flatten children to `<namespace>__<name>`; remember the alias map; rewrite replayed calls and `tool_choice` the same way | Alias back to the namespaced call item |
| Hosted tools (`web_search` with `external_web_access`, `code_interpreter`, `image_generation`, `local_shell`) | Drop; log once per request at debug level | none |
| `tools[].type: "custom"` (any freeform tool) | Lower to a function tool with one required string parameter `input`; remember the name | A `tool_call` for a remembered name becomes `custom_tool_call` with `input` = parsed `arguments.input` |
| Lite items (`additional_tools`, `custom_tool_call` named `exec`) | 400 naming the fix; never attempt to translate code mode for a routed model | — |
| `previous_response_id` | 400 `unsupported: modelplug is stateless; send the full transcript (store: false)` | — |
| `compaction` items | Drop with a one-line warning (M8 owns routed compaction; the passthrough relays the backend's own) | — |
| `instructions` + `system`/`developer` messages | Concatenate in order into `Turn.system`, separated by blank lines | — |
| `reasoning` items in input | `ReasoningPart` with `text` from summary and `opaque` decoded from `encrypted_content` when it carries a modelplug envelope; foreign blobs (the backend's own) dropped | — |
| `client_metadata`, `prompt_cache_key`, `internal_chat_message_metadata_passthrough` | `prompt_cache_key` → `metadata.conversationId`; the rest ignored | — |

### Step 2. `src/ingress/responses.ts`: parse

`parse(body, headers) -> ParsedIngress`. Zod schema for the subset of the
Responses request modelplug understands; unknown top-level fields are ignored,
unknown item types are rejected with a 400 that names the type. Mapping:

| Responses | IR |
|---|---|
| `model` | `modelRef` (unrouted) |
| `input[]` message user/assistant | `UserMessage` / `AssistantMessage`; `input_text`, `output_text`, `input_image` (data URL or https) |
| `function_call` | `ToolCallPart` on the preceding assistant message, or a new assistant message |
| `function_call_output` (`output` string in classic; list of parts in Lite) | `ToolMessage`; image parts kept |
| `custom_tool_call` / `_output` | Same as function call/output, via the lowering table |
| `tools[]` function | `Tool` with `strict` |
| `tool_choice` | `"auto" \| "none" \| "required" \| {name}`; `allowed_tools` reduced to `"auto"` over the intersection |
| `parallel_tool_calls` | pass |
| `reasoning.effort/summary` | `ReasoningRequest` |
| `max_output_tokens`, `temperature`, `top_p` | `Sampling` |
| `text.format` json_schema / json_object | `ResponseFormat` |
| `stream` | `stream`, default false; Codex always sends `true` |
| `prompt_cache_key` | `metadata.conversationId` (logs only) |

Tests: one parse test per step-0 fixture asserting the key shape (counts, roles,
tool names, that `system` starts with the instructions text), plus targeted
tests for lowering, `previous_response_id`, unknown item type.

### Step 3. `src/ingress/responses.ts`: respond

`respond(events, parsed, sink)` writes the Responses SSE sequence Codex expects.
Fixed order, `sequence_number` on every event, ids minted per item:

```
response.created  →  response.in_progress
  reasoning item:  output_item.added → reasoning_summary_part.added → reasoning_summary_text.delta* → reasoning_summary_text.done → reasoning_summary_part.done → output_item.done
  message item:    output_item.added → content_part.added → output_text.delta* → output_text.done → content_part.done → output_item.done
  function call:   output_item.added → function_call_arguments.delta* → function_call_arguments.done → output_item.done
response.completed   (status completed, full output[], usage)
```

Rules that fixtures pin down:

- `usage.input_tokens_details.cached_tokens` and
  `usage.output_tokens_details.reasoning_tokens` are always present, zero when
  unknown. Strict clients crash after `response.completed` without them.
- `done` with `stopReason: "max_tokens"` emits `response.incomplete` with
  `incomplete_details.reason = "max_output_tokens"`, not `completed`.
- An `error` event after output has started closes any open function call
  **without** `function_call_arguments.done` and ends with `response.failed`
  carrying `error.code` and `error.message`. The client must never see a
  completed call ahead of a failure.
- An `error` before any output is not streamed: the pipeline answers a JSON
  error with an HTTP status from the kind table (step 6).
- Reasoning items carry `encrypted_content` = base64 JSON of the `Opaque`
  (`{"v":1,"provider","model","kind","data"}`) when the wire produced one, so
  the client replays it and step 2 can decode it. Codex asks for this with
  `include: ["reasoning.encrypted_content"]`; emit it regardless.
- A `tool_call` whose arguments fail `JSON.parse` at `tool_call_end` is closed
  as incomplete and the response ends with `response.failed`
  (`invalid_tool_arguments`). Never forward unparseable arguments as a call.
- `stream: false` collects events and returns the final `response` object.

Tests: synthetic `Event[]` in, exact event-name sequence out, for text-only,
reasoning + text, one tool call, two parallel tool calls, max_tokens, error
after text, error mid tool call, unparseable arguments, custom tool restore.

### Step 4. `src/wire/openai-chat.ts`: encode

```
messages: system → user (string or parts with image_url) → assistant (content, tool_calls, optional reasoning_content) → tool (tool_call_id, string content)
tools:    [{type:"function", function:{name, description, parameters, strict?}}]
tool_choice, parallel_tool_calls, temperature (if caps.temperature), top_p, stop
max_tokens (see decision below), stream, stream_options.include_usage: true
response_format: json_schema | json_object
reasoning per caps.reasoning:
  effort            → reasoning_effort: <level clamped to caps.reasoningLevels>
  reasoning_content → no request field; assistant ReasoningPart.text is sent back as reasoning_content only when the provider requires it (decision below)
  toggle            → <caps.reasoningToggle.field> = on/off (off when effort is "minimal" or reasoning absent)
  budget / none     → nothing
```

Rules:

- Assistant message with tool calls and no text omits `content` rather than
  sending `null` or `""`. If a provider needs one of those, it arrives as a
  fixture and a decision, not a guess.
- Image parts inside a tool result: the `tool` message gets the text parts and
  a placeholder line `[image attached below]`; the images are appended as a
  following `user` message when `caps.images`, otherwise `[image omitted]`.
- `Opaque` values minted by another provider are dropped here.

Two decisions to make with evidence during this step, then pinned by fixture:

1. **DeepSeek `reasoning_content` on replay.** Their docs have said both
   "never send it back" and, for thinking mode with tool calls, "send it back
   within the same turn". Read the current doc, test both against the live API,
   and encode the result as a capability `reasoningReplay: "never" | "same_turn"`
   only if the two behaviours are really both needed.
2. **`max_tokens` vs `max_completion_tokens`.** Default to `max_tokens` for
   compatible providers; revisit if a preset needs the other.

### Step 5. `src/wire/openai-chat.ts`: decode and classify

Decode over `decodeSse`; `[DONE]` ends the stream but is not itself a terminal
if `done` was already emitted from `finish_reason`.

| Chunk field | Event |
|---|---|
| `choices[0].delta.content` | `text_delta` |
| `delta.reasoning_content` or `delta.reasoning` | `reasoning_delta` |
| `delta.tool_calls[]` by `index`: first appearance with `id`/`function.name` | `tool_call_start`, then `tool_call_delta` for `function.arguments` |
| `finish_reason: stop / tool_calls / length / content_filter` | close open tool calls with `tool_call_end`, then `done` with mapped `stopReason` (deferred until usage arrives if the stream is still open) |
| `usage` (in the last chunk or a trailing chunk with empty `choices`) | attached to `done`: `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit_tokens`, `completion_tokens_details.reasoning_tokens` |
| `{"error": {...}}` as a data payload | `error` event, classified |
| stream ends without `finish_reason` | `done` with `stopReason: "end_turn"` only if text was produced, else `error` kind `upstream` ("stream ended without a terminal chunk") |

`classifyError(status, headers, bodyText)`:

| Status / body | kind | retryable |
|---|---|---|
| 401, 403 | auth | no |
| 402, or body mentions insufficient balance / quota exceeded | quota | no |
| 429 | rate_limit | yes, `retryAfterMs` from `Retry-After` or `retry-after-ms` |
| 400 with context / too long / maximum tokens wording | context_length | no |
| 400 other, 422 | invalid_request | no |
| 404 | not_found | no |
| 408, 500, 502, 503, 504, 529 | overloaded for 503/529, upstream otherwise | yes |
| fetch throws | network | yes |

Golden fixtures in `test/fixtures/openai-chat/`: `text.sse`,
`tool-call-two-chunks.sse`, `parallel-tool-calls.sse`, `deepseek-reasoning-content.sse`,
`usage-trailing-chunk.sse`, `usage-in-last-content-chunk.sse`, `error-mid-stream.sse`,
`finish-length.sse`, `done-without-usage.sse`, `kimi-reasoning.sse` (recorded
from the real APIs, then trimmed). Each has an `.events.json` twin.

### Step 6. `src/pipeline.ts`: join them

```
parse → resolveRoute → runAttempts(targets, attempt) → ingress.respond
attempt(target, n):
  provider, wire, caps = lookup
  credential = credentials.resolve(target, n, conversationId)      ← api-key or the chatgpt provider from M2
  providerTarget = { name, baseUrl: credential.baseUrl ?? provider.baseUrl, apiKey: credential.apiKey, headers: merged }
  request = wire.encode({...turn, model: target.model}, caps, providerTarget, stream)
  response = fetch(request, { signal, connect/first-byte timeout 30 s })
  if !ok → { ok:false, error: wire.classifyError(status, headers, await text()) }
  events = wire.decode(response, caps, providerTarget)
  first = await events.next()            ← peek: retries happen only before bytes reach the client
  if first is error → { ok:false, error }
  else → { ok:true, value: replay(first, events) }
  credentials.report(target, credential, { outcome, error?, headers: response.headers })
```

The credential call and the same-protocol passthrough already exist from
milestone 2; this milestone adds the IR path beside them.

Also owned here:

- Client disconnect (`req.on("close")`) aborts the upstream fetch and stops
  decode.
- Idle stall: no event for 120 s ends the turn with an `error` kind `network`.
- Error kind → HTTP status for failures before streaming:
  auth 401, rate_limit 429 (+`Retry-After`), quota 429, context_length 400,
  invalid_request 400, content_filter 400, not_found 404, overloaded 503,
  upstream 502, network 502, cancelled 499. Body shape
  `{"error":{"type","code","message"}}`, message prefixed with the provider name.
- `RouteError` → 400 with the route message. `ConfigError` cannot happen here.
- Usage log (`config.usageLog`): after `done`, append one JSON line to
  `$XDG_STATE_HOME/modelplug/usage.jsonl` (default `~/.local/state/…`):
  `{ts, ingress, modelRef, provider, model, attempt, status, usage, durationMs}`.
  Never prompts, never keys.

Tests: real `createServer` against a fake upstream `node:http` server that
replays fixtures: end-to-end SSE; 429 then success is one clean client
response; non-retryable error is a JSON error with the mapped status; client
abort reaches the fake upstream as a closed socket; stall timeout fires with
fake timers.

### Step 7. `modelplug check` learns the network

For each provider, `GET {baseUrl}/models` with the key. Report reachable /
auth failed / unreachable in the table. Model ids from the response fill
`/v1/models` when the provider lists none in config. Five second timeout,
never blocks `start`.

### Step 8. Conformance scenario and the boundary test

`test/conformance.test.ts`: one scenario, run once per registered wire (only
`openai-chat` for now, the table grows in M3 and M5). Prompt asks for an
`apply_patch` on a file named `résumé "draft".md` containing a backslash; a
scripted upstream answers with the corresponding tool call; the test asserts
the Responses SSE the client sees restores the `custom_tool_call` with the
exact input text. Borrowed in spirit from opencodex's
`adapter-tool-conformance`.

`test/boundary.test.ts`: reads `src/presets.json` keys and fails if any of them
(or `deepseek`, `kimi`, `moonshot`, `qwen`, `zhipu`, `openai`, `anthropic`,
`google`, `xai`) appears as a string literal in any `src/**/*.ts` other than
`src/wire/*.ts`. Cheap, and it is the whole architecture in one grep.

### Step 9. Manual acceptance and docs

Run the exit-criterion task with real Codex against DeepSeek and against Kimi
(second provider on the same wire, to catch presets that only worked by
accident). Record what broke as fixtures. Update `README.md` status and the
quick start; add `docs/CLIENTS.md` with the exact Codex and Claude Code
snippets and the "why my model is not in the picker" note.

---

## Milestone 4: account pool

1. **Login.** `modelplug login chatgpt` runs the PKCE flow with Codex's client
   id and its registered callback `http://localhost:1455/auth/callback` (the
   port is fixed by the registration; refuse to start if it is busy). Repeat
   to add accounts; `account list`, `account remove`, `account use` to pin.
2. **Selection.** Strategy per provider: `lowest-usage` (default, from quota
   headers across both windows), `round-robin`, `fill-first`. Paused accounts
   are skipped.
3. **Affinity.** `conversationId` (Codex's `prompt_cache_key`) → account, in
   memory, one-hour sliding TTL, so prompt caches and encrypted reasoning stay
   on the account that minted them.
4. **Rotation.** 429 with a usage-limit error cools the account down until its
   reset-after; 401 refreshes once then rotates; a 400 that names encrypted
   reasoning strips the reasoning items and retries once on the new account.
   All of this is `resolve()` returning a different account on the next
   attempt of the same target.
5. **Policy note.** README and `login` output carry the provider-policy text.

Exit: with two accounts and a fake upstream that exhausts one of them
mid-session, conversations continue on the other with no client-visible error,
and a conversation stays on its account until that account is exhausted.

**Status (2026-09-22): built against fakes; the exit criterion passes end to
end in `test/pool.test.ts`.** `src/credentials/chatgpt.ts` is the pool:
`strategy` per provider (`lowest-usage` default, scoring the busiest quota
window and treating a window whose reset time has passed as empty;
`round-robin`; `fill-first`), a pinned account (`account use <id>`, `use auto`
to unpin) that beats both, conversation affinity with a one-hour sliding TTL,
usage-limit cooldowns until the exhausted window's reset (else the nearest
reset, else 15 minutes, clamped to 30 s … 7 d), a 401 that refreshes once and
on repeat marks the account `needsLogin` and rotates, and a rejected refresh
that rotates instead of failing the request. `src/credentials/chatgpt-login.ts`
is the PKCE flow with Codex's client id, callback on 1455 (both address
families; a busy port is refused), state check, ten-minute timeout, and the
same claim parsing as the import. Import no longer pins the first account.
89 tests green.

Checked live (2026-09-23): OpenAI's authorize endpoint renders the login form
with the Codex consent text for the URL `login chatgpt` builds, so the client
id, callback and Codex parameters are accepted; the token exchange itself has
not been run. Open: item 4's third clause: the 400
the backend returns when a transcript carries reasoning minted by another
account has not been recorded, so no code strips reasoning items yet. Record it
with two accounts first; it is one named function with one fixture when it lands.

## Milestone 5: `anthropic` wire

Forces the `Opaque` design. Specified against the Claude API as of 2026-06
(the `claude-api` reference), which moved under the original scope:

**Facts that changed the scope.**

- Current models (Opus 5, Sonnet 5, Fable 5.1, Opus 4.6 to 4.8) take
  `thinking: {type: "adaptive"}` plus `output_config: {effort}` with levels
  `low | medium | high | xhigh | max`; `budget_tokens` returns 400 on them.
  Only older models (Haiku 4.5, Sonnet 4.5, …) still take
  `thinking: {type: "enabled", budget_tokens}`. So `Capabilities.reasoning`
  is `effort` in the preset and `budget` when the user says so for an old
  model, and the IR gained `xhigh` (Codex sends it; the ingress used to fold
  it into `max`).
- `temperature` / `top_p` return 400 on current models: the preset sets
  `temperature: false`.
- Thinking blocks must go back unchanged. The API drops blocks a target model
  cannot read, and stripping them yourself can trigger ordering and signature
  400s (Fable 5.1 also checks that the prefix before a block is byte-identical
  to when it was produced). So the `Opaque` carries the thinking text and the
  signature together and is replayed whenever this provider minted it, on any
  model; only a foreign provider's block is dropped. `display: "summarized"`
  is requested so Codex shows a readable summary.
- Forced tool use (`any` / `tool`) is rejected by Fable 5.1 and Opus 5.5 but
  accepted by Opus 5 and Sonnet 5; it is sent when the client asks for it.
- Assistant prefill is gone: a transcript ending in an assistant turn is a
  400. Codex never sends one.

**Spec.** `src/wire/anthropic.ts` implements `Wire` from `src/ir.ts`:

1. **encode.** `POST {baseUrl}/v1/messages`, headers `x-api-key`,
   `anthropic-version: 2023-06-01`. `system` as a string. Messages:
   consecutive same-role messages merged; `tool_result` blocks lead the user
   message, several together for parallel calls, and a result arriving after
   user text starts a new user message; images as `base64` or `url` source
   blocks, replaced by a `[n image(s) omitted …]` text when `caps.images` is
   off; assistant `thinking` / `redacted_thinking` blocks rebuilt from the
   Opaque (`kind: "thinking"` with JSON `{thinking, signature}`, `kind:
   "redacted_thinking"` with the raw data), foreign or malformed Opaques
   dropped; `tool_use.input` parsed from the arguments, `{}` when unparseable;
   empty text blocks skipped. Tools carry `input_schema`, `strict` when set,
   and `eager_input_streaming: true` when streaming. `tool_choice` maps
   auto / none / required→`any` / name→`tool`, with
   `disable_parallel_tool_use: true` when `parallelToolCalls` is false.
   `max_tokens` is the client's value, else `caps.maxOutputTokens`, else
   64000, clamped to the cap. Effort mode: `thinking: {type: "adaptive",
   display: "summarized"}` and `output_config.effort` clamped to
   `caps.reasoningLevels` (`minimal` → `low`). Budget mode:
   `thinking: {type: "enabled", budget_tokens}` from `budgetTokens` or the
   table low 2048 / medium 8192 / high 16384 / xhigh 24576 / max 32768,
   `max_tokens` raised above it; `minimal` or no reasoning request → no
   thinking field. `json_schema` → `output_config.format`. Top-level
   `cache_control: {type: "ephemeral"}` on every request.
2. **decode** over `decodeSse`: `message_start` usage (`input_tokens` +
   cache read + cache write = `inputTokens`, the two cache counts kept);
   `content_block_start/delta/stop` for text, thinking (`thinking_delta` →
   `reasoning_delta`, `signature_delta` accumulated, stop → `reasoning_opaque`
   even when the text is empty), `redacted_thinking` (→ `reasoning_opaque`),
   `tool_use` (`tool_call_start`, `input_json_delta` → `tool_call_delta`, a
   call that streamed nothing gets `{}` or the block's own `input`, then
   `tool_call_end`); unknown block types ignored; `message_delta` stop
   reason and usage; `message_stop` → `done` (`end_turn`, `stop_sequence`,
   `pause_turn` → end_turn; `tool_use`; `max_tokens`; `refusal` →
   content_filter); an `error` event → the classified error; a stream that
   ends without `message_stop` → error `upstream`, retryable only when
   nothing was emitted.
3. **classify** `{type: "error", error: {type, message}}`: 401/403 auth;
   402 or `billing_error` quota; 404 or `not_found_error` not_found; 429
   rate_limit with retry-after; 413 context_length; 400 with "prompt is too
   long" wording context_length, with credit/billing wording quota, otherwise
   invalid_request; 529 or `overloaded_error` overloaded, retryable; 5xx
   upstream, retryable.
4. **models.** `GET {baseUrl}/v1/models` with the same headers; ids from
   `data[].id`.
5. **Preset** `anthropic`: `reasoning: "effort"`, levels low…max,
   `temperature: false`, a note on the budget override for old models. The
   wire default for `wire: "anthropic"` matches.
6. **Tests.** `test/wire-anthropic.test.ts`: encode (every rule in 1 with a
   transcript that has a same-provider Opaque, a foreign one, a redacted one,
   a tool result with an image, a follow-up user text; budget mode; json
   schema; images off), decode (thinking summarized and omitted, redacted,
   tool use with and without deltas, refusal, max_tokens, an `error` event,
   a truncated stream), classify table, models request. An `anthropic`
   scenario in `test/conformance.test.ts`: the suite fails without one.
7. **Docs.** `src/wire/README.md` row, README status, this section's status.

**Status (2026-09-23):** steps 1 to 7 implemented and reviewed: wire,
shared effort clamp, `xhigh` in the IR, preset, registry, 12 focused wire
tests, and conformance scenarios for both routed wires. 113 tests defined.
Live Claude acceptance awaits an API key.

Exit: Codex runs the M2 task against Claude with thinking on, across at least
three tool-calling turns, with zero `invalid signature` or
`thinking block order` errors. Conformance scenario green on both wires.
Needs an Anthropic API key on the dev machine; none is present today.

## Milestone 6: `messages` ingress

Claude Code's protocol. Specified against the Claude API as of 2026-06 (the
`claude-api` reference) the same way milestone 5 was; recording real Claude
Code traffic (`--record --forward https://api.anthropic.com`) needs a key and
is acceptance work.

**Shape of the work.** Two units. 6a is the ingress module with its own tests
and the round-trip property test; 6b generalises the pipeline so the
`/v1/messages` route runs through the same attempt loop, adds the
same-protocol passthrough for `messages` → `anthropic`, and `count_tokens`.

### 6a. `src/ingress/messages.ts`

`parse(body, headers) -> ParsedMessages` (extends `ParsedIngress`):

| Messages request | IR |
|---|---|
| `model` | `modelRef` |
| `system` string, or `[{type: "text", text}]` blocks | `Turn.system`, blocks joined with a blank line; `cache_control` ignored |
| `messages[]` user, string content | `UserMessage` with one text part |
| user blocks `text` / `image` (`source.type` base64 → `ImagePart`, url → `ImageUrlPart`) | `UserMessage` parts in order |
| user block `tool_result` (`content` string or text/image blocks, `is_error`) | one `ToolMessage` per block, emitted **before** the user message that holds the remaining text/image blocks of the same message; `tool_use_id` → `callId`; the name is looked up from the preceding assistant `tool_use` |
| user block `document` | 400 `unsupported` naming the block type |
| assistant blocks `text` / `tool_use` (`input` re-serialised with `JSON.stringify` → `arguments`) | `AssistantMessage` parts |
| assistant block `thinking {thinking, signature}` | `ReasoningPart{text: thinking, opaque}` where `opaque = decodeOpaque(signature)`; a signature that is not our envelope is dropped (the text stays) |
| assistant block `redacted_thinking {data}` | `ReasoningPart{opaque: decodeOpaque(data)}`, dropped when foreign |
| assistant block `fallback`, `compaction`, `server_tool_use`, `web_search_tool_result`, … | dropped with a warning in `lowering.warnings` |
| `tools[]` without `type`, or `type: "custom"` (`name`, `description`, `input_schema`, `strict`) | `Tool` |
| `tools[]` with an Anthropic-defined `type` (`bash_*`, `text_editor_*`, `web_search_*`, `web_fetch_*`, `computer_*`, `code_execution_*`, `tool_search_*`, `memory_*`, `mcp_toolset`, …) | dropped, listed in `lowering.droppedTools` |
| `tool_choice` `{type: auto \| any \| tool \| none, disable_parallel_tool_use}` | `"auto"` / `"required"` / `{name}` / `"none"`; `disable_parallel_tool_use: true` → `parallelToolCalls: false` |
| `thinking {type: "adaptive"}` + `output_config.effort` | `ReasoningRequest{effort}` (effort defaults to `"high"` when adaptive without an effort, the API's default) |
| `thinking {type: "enabled", budget_tokens}` | `ReasoningRequest{budgetTokens, effort}` with effort from the nearest budget band (≤2048 low, ≤8192 medium, ≤16384 high, ≤24576 xhigh, else max) |
| `thinking {type: "disabled"}` or absent | no reasoning request |
| `output_config.format {type: "json_schema", schema}` | `ResponseFormat` |
| `max_tokens`, `temperature`, `top_p`, `stop_sequences` | `Sampling`; `top_k` ignored |
| `metadata.user_id` | `metadata.conversationId` (Claude Code sends a stable per-session hash) |
| `stream` | `stream`, default false |
| `context_management`, `mcp_servers`, `container`, `betas`, `fallbacks`, `speed`, `service_tier` | ignored; the `anthropic-beta` request header is forwarded on same-protocol passthrough |

Rules: the first message must be `user` (400 `invalid_request` otherwise);
consecutive same-role messages are accepted in order, as the API does.
Empty content is 400. Unknown block types are 400
naming the type, like the Responses ingress. `previous_response_id`-style
state does not exist in this protocol.

`respond(events, parsed, sink)` writes the Messages SSE sequence:

```
message_start   {message: {id: msg_…, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0}}}
ping
  reasoning:  content_block_start {type: "thinking", thinking: ""} → thinking_delta* → signature_delta (encodeOpaque of the reasoning_opaque, when one arrived) → content_block_stop
              a reasoning_opaque with no open thinking block opens one and closes it at once (display-omitted thinking)
              kind "redacted_thinking" → content_block_start {type: "redacted_thinking", data: encodeOpaque(opaque)} → content_block_stop
  text:       content_block_start {type: "text", text: ""} → text_delta* → content_block_stop
  tool call:  content_block_start {type: "tool_use", id, name, input: {}} → input_json_delta* → content_block_stop
message_delta   {delta: {stop_reason, stop_sequence: null}, usage: {input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}}
message_stop
```

Rules that tests pin down:

- `stop_reason` mapping: `end_turn` → `end_turn`, `tool_use` → `tool_use`,
  `max_tokens` → `max_tokens`, `content_filter` → `refusal`, `cancelled` →
  `end_turn`.
- Every event is an SSE frame with `event: <type>` and one `data:` line;
  block `index` counts from 0 per message.
- An `error` event after output has started closes nothing: the stream ends
  with `event: error` `{type: "error", error: {type, message}}` where `type`
  is the Anthropic error type for the kind (`overloaded_error`, `api_error`,
  `rate_limit_error`, `authentication_error`, `invalid_request_error`,
  `permission_error`, `not_found_error`; `context_length` → `invalid_request_error`).
- An error before any output is not streamed: JSON `{type: "error", error}`
  with the HTTP status from the pipeline's kind table.
- A `tool_call` whose arguments fail `JSON.parse` at `tool_call_end` ends the
  stream with an `error` event (`invalid_request_error`, "the model returned
  tool arguments that are not valid JSON"); nothing is forwarded as a call.
- `stream: false` collects and returns the final message object with the
  same `content` blocks, `stop_reason` and `usage`.
- Usage: `input_tokens` = IR `inputTokens` minus cache reads and writes (the
  API's convention), the two cache counts as given, `output_tokens`.

Tests: `test/ingress-messages.test.ts` — parse tests for each row above
(synthetic requests in Claude Code's shape: system blocks with
`cache_control`, a tool loop with parallel `tool_use` and two `tool_result`
blocks followed by text, thinking blocks with our envelope and with a
foreign signature, an Anthropic-defined tool, `disable_parallel_tool_use`,
adaptive thinking with effort, budget thinking), respond tests (text only;
thinking with signature; display-omitted thinking; tool call; parallel tool
calls; max_tokens; refusal; error after text; error before output;
unparseable arguments; non-streaming), and the **round-trip property**: for
several generated Messages requests, `parse` → `encodeAnthropicRequest`
reproduces the original `system`, `messages` blocks (text, tool_use with the
same `input`, tool_result, thinking with the same text and signature) and
`tools` up to the fields the wire adds (`eager_input_streaming`,
`cache_control`, `max_tokens`).

### 6b. Pipeline: the `/v1/messages` route

- `src/pipeline.ts` gets one handler factory parameterised by ingress:
  `parse`/`respond` come from the ingress; the model ref, the conversation id
  (`prompt_cache_key` for Responses, `metadata.user_id` for Messages) and the
  passthrough decision are the only per-ingress facts. Passthrough matrix:
  `responses` → `openai-responses` and `messages` → `anthropic`; every other
  pair goes through the IR. The passthrough for `messages` relays to
  `{baseUrl}/v1/messages` (and `/v1/messages/count_tokens`), injects
  `x-api-key` and `anthropic-version`, drops the client's own `x-api-key` and
  `authorization` and forwards everything else, including `anthropic-beta`;
  it reads usage from `message_start` / `message_delta` for the log.
- `POST /v1/messages/count_tokens`: passthrough relays it; routed providers
  answer `{input_tokens}` estimated as `ceil(bytes of the concatenated text / 4)`
  plus a fixed per-image allowance, honestly labelled an estimate in the docs.
- Error bodies for the Messages route use the Anthropic shape
  `{type: "error", error: {type, message}}`; the status table is shared.
- `usage.jsonl` records `ingress: "messages"`.
- `modelplug print claude` stays as is; `docs/CLIENTS.md` loses its "501
  until milestone 6" note and gains the passthrough sentence.
- Tests: `test/pipeline-messages.test.ts` through the HTTP shell with a fake
  upstream — IR path to a Chat Completions fake (Claude Code-shaped request
  in, Messages SSE out, tool loop across two turns), passthrough to an
  Anthropic-shaped fake (bytes relayed, key injected, usage logged),
  `count_tokens` both ways, a 401 and a 529 mapped to Anthropic error bodies.

**Status (2026-09-23): 6a and 6b implemented; the `/v1/messages` route, the
messages → anthropic passthrough and `count_tokens` are in. 127 tests green.**

Exit: Claude Code runs a coding task against DeepSeek (or Kimi) through
modelplug; the round-trip property test is green; the conformance scenario
still runs per wire. Recording real Claude Code traffic and the live run need
an Anthropic key or a Claude Code install pointed at the proxy.

## Milestone 7: Kimi and Grok logins, `openai-responses` through the IR, `gemini`

Four independent units, each its own PR off `main`. Order follows what the
maintainer uses daily: the Kimi subscription first.

### 7a. Kimi login: a second credential kind

Kimi Code is a subscription; its API (`https://api.kimi.com/coding/v1`, Chat
Completions) takes the OAuth access token as a Bearer key and the token lives
about an hour. Protocol facts (device authorization grant, public client):

| Step | Request |
|---|---|
| start | `POST https://auth.kimi.com/api/oauth/device_authorization`, form body `client_id=17e5f671-d194-4dfb-9706-5516cb48c098` → `{user_code, device_code, verification_uri, verification_uri_complete?, expires_in, interval}` |
| poll | `POST https://auth.kimi.com/api/oauth/token`, form body `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id` → `{access_token, refresh_token, expires_in}`, or `{error: "authorization_pending" \| "slow_down" \| "expired_token" \| "access_denied", error_description?, interval?}`; poll every `interval` seconds (default 5), add 5 s on `slow_down`, give up at `expires_in` (default 15 min) |
| refresh | `POST https://auth.kimi.com/api/oauth/token`, form body `grant_type=refresh_token`, `refresh_token`, `client_id` → same token shape; a missing `refresh_token` in the answer keeps the old one |
| headers on all three | `User-Agent: KimiCLI/0.14.0`, `X-Msh-Platform: kimi_code_cli`, `X-Msh-Version: 0.14.0`, `X-Msh-Device-Name` (hostname), `X-Msh-Device-Model` (e.g. `macOS 25.0.0 arm64`), `X-Msh-Os-Version`, `X-Msh-Device-Id` (32 hex chars, generated once and kept in `credentials.json`) |
| identity | JWT claims of the access token, then the refresh token: `user_id` else `sub` is the account id; `email` lowercased |

Spec:

1. `src/credentials/kinds.ts`: `CREDENTIAL_KINDS` gains `"kimi"`.
2. `src/credentials/store.ts`: the store gains an optional `kimi: {accounts: KimiAccount[], deviceId?: string}` beside `chatgpt` (same `schemaVersion: 1`; an old file without the key loads as empty). `KimiAccount`: `id` (the account id), `email?`, `accessToken`, `refreshToken`, `expiresAt` (ms since epoch, from `expires_in` minus a five-minute skew), `lastRefresh`, `source: "login"`, `needsLogin?`. `saveCredentialStore` unchanged (mode 0600, atomic).
3. `src/credentials/kimi.ts`: `kimiCredentials(provider, deps)` implementing `CredentialProvider` for one account (the pool from milestone 4 stays ChatGPT-only in this unit; a second Kimi account replaces the first): `resolve` refreshes when `expiresAt` is within five minutes or after a 401 once (`report` answers `{retry: true}` exactly like the ChatGPT kind, then marks `needsLogin` on a second 401), returns `{id, apiKey: accessToken}` and no extra headers (the API accepts a bare Bearer token: verified live 2026-09-23); `status()` returns one line per account (`email (kimi) token valid until … / NEEDS LOGIN`). `loginKimi(deps)` runs the device flow: prints the verification URL and the user code through `deps.log`, polls, returns the account; `deps` has `fetch`, `now`, `oauthHost` (default `https://auth.kimi.com`), `timeoutMs`, `log`, `deviceId`. A refresh that answers 400/401 marks `needsLogin` and throws `CredentialError("kimi", …)`.
4. `src/credentials/index.ts`: `credentialProviderFor` dispatches `"kimi"`.
5. `src/presets.json`: preset `kimi` — wire `openai-chat`, baseUrl `https://api.kimi.com/coding/v1`, credential `kimi`, capabilities `reasoning: "reasoning_content"`, `tools`, `images`, `temperature: true`, note "Kimi Code subscription; log in with `modelplug login kimi`. API-key users of the Moonshot platform use the `moonshot` preset."
6. CLI (`src/main.ts`): `modelplug login kimi` (device flow; prints the URL and code, waits), `modelplug logout kimi`, `modelplug account list` lists both kinds with a kind column, `account use <id>` / `account remove <id>` find the id in either kind (`use auto` unpins ChatGPT; pinning is a no-op for Kimi with one account). `check` shows `kimi accounts=N`. The usage line printed at `start` for passthrough is unchanged.
7. Tests: `test/credentials-kimi.test.ts` — the device flow against a fake auth server (`authorization_pending` then `slow_down` then a token; the poll interval grows; `access_denied` and `expired_token` become errors; the common headers are sent; the device id is generated once and persisted), refresh (proactive on expiry, reactive on one 401 via `report`, second 401 marks `needsLogin`, a refresh answer without `refresh_token` keeps the old one, a 400 marks `needsLogin`), identity from the JWT claims, `status()`. `test/boundary.test.ts` stays green (`src/credentials/` is exempt). `test/config.test.ts`: the `kimi` preset resolves with credential kind `kimi`.
8. Docs: README quick start gains `modelplug login kimi`; `docs/CLIENTS.md` mentions the `kimi` preset; `docs/PLAN.md` M7 status.

**Status (2026-09-23):** implemented; 21 tests in `test/credentials-kimi.test.ts`. The live login and the Codex run through `kimi/k3` with modelplug's own refresh are the exit criterion and pending.

Exit: with the maintainer's Kimi subscription, `modelplug login kimi` completes in the browser, `check` reports the kimi provider reachable with its model list, and Codex runs the milestone 3 task through `kimi/k3` with the token refreshed by modelplug alone (no opencodex).

### 7b. `openai-responses` through the IR, and an explicit passthrough switch

Today every `openai-responses` provider is served by the same-protocol
passthrough (the ChatGPT backend) and the wire has no encode/decode. Two things
need the IR path: Claude Code (the `messages` ingress) talking to OpenAI or xAI
API keys, and API-key providers that reject Codex's private dialect fields.

1. Provider config gains `passthrough?: boolean` (schema + `ResolvedProvider`). Default: `true` when the credential kind is `chatgpt` or the wire is `anthropic` (Claude Code speaks that wire natively; Codex's dialect fits only the ChatGPT backend), `false` otherwise; a preset may set it. The pipeline's passthrough decision becomes `ingress-and-wire match AND provider.passthrough`; the `messages` → `anthropic` passthrough follows the same switch (default `true` for the `anthropic` preset, i.e. API-key Anthropic is relayed as today). Document the switch in README's config section.
2. `src/wire/openai-responses.ts` encode: `POST {baseUrl}/responses` with `Authorization: Bearer`; `instructions` = `Turn.system`; `input[]`: user messages as `{type: "message", role: "user", content: [input_text | input_image {image_url: data URL or url, detail: "auto"}]}`, assistant text as `{type: "message", role: "assistant", content: [output_text]}`, tool calls as `function_call {call_id, name, arguments}`, tool results as `function_call_output {call_id, output}` (string; image parts appended as a following user message with `input_image`, like the Chat wire does), reasoning parts with a same-provider Opaque of kind `encrypted_reasoning` as `{type: "reasoning", id, summary: [], encrypted_content}` (foreign Opaques dropped, reasoning without an Opaque dropped); `tools[]` as `{type: "function", name, description, parameters, strict}`; `tool_choice` auto/none/required/`{type: "function", name}`; `parallel_tool_calls`; `reasoning: {effort}` clamped to `caps.reasoningLevels` (`minimal` passes through, `xhigh` passes through) plus `summary: "auto"` when the client asked for summaries; `max_output_tokens`, `temperature`/`top_p` when `caps.temperature`; `text: {format: {type: "json_schema", name, schema, strict}}`; `store: false`; `include: ["reasoning.encrypted_content"]`; `stream`. Never `previous_response_id`.
3. decode over `decodeSse`: `response.output_text.delta` → `text_delta`; `response.reasoning_summary_text.delta` → `reasoning_delta`; `response.output_item.done` for a `reasoning` item with `encrypted_content` → `reasoning_opaque {kind: "encrypted_reasoning", data: encrypted_content}`; `response.output_item.added` for `function_call` → `tool_call_start` (id = `call_id`), `response.function_call_arguments.delta` → `tool_call_delta`, `response.function_call_arguments.done`/`output_item.done` → `tool_call_end`; `response.completed` → `done` (status `completed` → `end_turn` or `tool_use` when a call was emitted; `response.incomplete` with `max_output_tokens` → `max_tokens`, `content_filter` → `content_filter`); `response.failed` and `error` events → the classified error; usage from `response.completed.response.usage` (`input_tokens` incl. cached; `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`); hosted-tool items (`web_search_call`, …) ignored; a stream ending without a terminal event → `upstream` error, retryable only if nothing was emitted.
4. classify stays `classifyOpenAiError`; `modelsRequest`/`parseModels` stay.
5. Tests: `test/wire-openai-responses.test.ts` grows encode/decode cases (synthetic frames modelled on the recorded `test/fixtures/responses/classic/*.response.sse`, which are the ground truth for event names and order — a decode test may read `classic/turn-1-first.response.sse` directly); an `openai-responses` conformance scenario (the conformance test's skip for this wire goes away; the scenario asserts the Responses request shape and streams `function_call` events); `test/pipeline.test.ts` gains: an `openai-responses` API-key provider with `passthrough: false` goes through the IR (Codex's `namespace` tools flattened, `client_metadata` absent upstream), the `chatgpt` provider still relays byte for byte.
6. Docs: README config section (`passthrough`), `src/wire/README.md` row 4, PLAN status.

Exit: conformance green on three wires; the pipeline test proves both paths; live acceptance against an OpenAI or xAI key when one is available.

**Status (2026-09-23):** encode/decode, the `passthrough` switch, the
conformance scenario and the API-key pipeline test are in; 109 tests green.
Live acceptance against an OpenAI or xAI key is pending.

### 7c. `gemini` wire

**Status (2026-09-23):** wire, synthetic-frame tests and the conformance scenario
are in; 112 tests green. Thought signatures ride through the Responses ingress
in a `reasoning` item bound to the call (the Messages ingress gets the same in a
follow-up once its PR lands). Live acceptance against a Google key is pending.

Gemini API (`generativelanguage.googleapis.com`), API key in the
`x-goog-api-key` header. Spec (no fixtures on the dev machine; the wire is
written against the public API reference and recorded when a key exists):

1. encode: `POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse` (`:generateContent` when not streaming); `systemInstruction: {parts: [{text}]}`; `contents[]` with roles `user`/`model`: text parts, `inlineData {mimeType, data}` for base64 images, `fileData {fileUri, mimeType}` for URL images; assistant tool calls as `functionCall {name, args}` parts (arguments parsed, `{}` when unparseable) each carrying a `thoughtSignature` when the tool call's Opaque (kind `thought_signature`, same provider) has one; tool results as a `user` content with `functionResponse {name, response: {output: text}}` parts, several results in one content; reasoning parts with a same-provider Opaque of kind `thought_signature` and no tool call → a `thought: true` part is NOT replayed (only signatures on function calls are); `tools: [{functionDeclarations: [{name, description, parameters}]}]` with the schema sanitised: strip `additionalProperties`, `$schema`, `default`, `examples`, `strict`, `format` values Gemini rejects (keep `enum`, `date-time`), convert `type: ["string","null"]` to `type: "string", nullable: true`; `toolConfig.functionCallingConfig.mode` AUTO/NONE/ANY (+ `allowedFunctionNames` for a named choice); `generationConfig`: `maxOutputTokens`, `temperature`/`topP` when `caps.temperature`, `stopSequences`, `responseMimeType: "application/json"` + `responseSchema` for json_schema, `thinkingConfig: {includeThoughts: true, thinkingBudget}` from the effort table (low 2048 / medium 8192 / high 16384 / xhigh 24576 / max 32768; `minimal` → 0; absent → omit).
2. decode over `decodeSse`: each frame is a `GenerateContentResponse`; `candidates[0].content.parts[]`: `text` with `thought: true` → `reasoning_delta`, plain `text` → `text_delta`, `functionCall` → `tool_call_start` (id synthesised as `call_<n>` per response, since Gemini has none) + one `tool_call_delta` with the JSON args + `tool_call_end` carrying `Opaque{kind: "thought_signature", data: thoughtSignature}` when present; `finishReason` `STOP` → `end_turn`/`tool_use`, `MAX_TOKENS` → `max_tokens`, `SAFETY`/`RECITATION`/`PROHIBITED_CONTENT` → `content_filter`; `usageMetadata` → `promptTokenCount` (+ `cachedContentTokenCount` as cached), `candidatesTokenCount` + `thoughtsTokenCount` as output with `reasoningTokens`; `promptFeedback.blockReason` before any candidate → `content_filter` error; a frame with `error` → classified.
3. classify: `{error: {code, status, message}}`: 400 `INVALID_ARGUMENT` invalid_request (context wording → context_length), 401/403 auth, 404 not_found, 429 `RESOURCE_EXHAUSTED` rate_limit (quota wording → quota), 500/503 upstream/overloaded retryable, 504 upstream.
4. models: `GET {baseUrl}/v1beta/models` → `models[].name` with the `models/` prefix stripped.
5. Tests: `test/wire-gemini.test.ts` (encode incl. schema sanitiser cases, decode incl. thought parts and signatures, classify, models) and a `gemini` conformance scenario (the tool call id is synthesised, so the scenario checks the name and arguments and that the replayed `functionResponse` carries the same name and output).
6. Docs: `src/wire/README.md` row 3, README status, PLAN status.

Exit: conformance green on four wires; live acceptance when a Google key exists.

### 7d. Grok login: a third credential kind

Status (2026-09-23): Grok credential, OIDC login, preset, CLI, and fake-endpoint
tests implemented in this branch. The callback tests require loopback sockets.
Merged after 7a and 7b: Codex-to-Grok routing goes through the Responses IR
path (`passthrough: false`); the live login is the exit criterion.

xAI's Grok subscription login is an OIDC authorization-code flow with PKCE
(public client `b1a00492-073a-47ea-816f-4c329264a828`, scope
`openid profile email offline_access grok-cli:access api:access`, endpoints
from `https://auth.x.ai/.well-known/openid-configuration`, callback
`http://localhost:56121/callback`, identity from the id token's `sub`/`email`).
The API is `https://api.x.ai/v1` (Responses wire) with the access token as a
Bearer key; refresh with `grant_type=refresh_token` at the discovered token
endpoint.

1. `src/credentials/grok.ts` mirrors the Kimi kind (single account, proactive and reactive refresh, `needsLogin`, `status()`), reusing the PKCE and callback-server pieces from `chatgpt-login.ts` (extract `pkcePair`, the callback listener and the browser opener into `src/credentials/oauth.ts` — same behaviour, no new dependency). Kind `"grok"`, store key `grok`, preset `grok` (wire `openai-responses`, baseUrl `https://api.x.ai/v1`, credential `grok`, `passthrough: false` — Codex's private dialect is translated through the IR of 7b).
2. CLI: `login grok` / `logout grok`; `account` commands see the third kind.
3. Tests: `test/credentials-grok.test.ts` against fake discovery, authorize (a scripted browser hits the callback), token and refresh endpoints; endpoint host validation (only `auth.x.ai` / `accounts.x.ai` over https); `test/config.test.ts` for the preset.
4. Docs: README quick start, CLIENTS, PLAN status.

Exit: with a Grok subscription, `login grok` completes and Codex runs a task through `grok/<model>`; the conformance scenario of 7b covers the wire.

## Milestone 8: 0.1.0

`POST /v1/responses/compact` for routed (non-passthrough) providers as a
summarization turn through the routed model, after capturing what Codex sends
and expects. Alias fallback documented honestly: failover happens before the
first byte only. `check` network probes, usage JSONL, `docs/CLIENTS.md`,
`CHANGELOG.md`, npm publish. Nothing from the non-goals list.
