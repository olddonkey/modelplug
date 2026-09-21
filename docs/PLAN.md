# modelplug plan

Milestone 1 (skeleton) is done: IR, config, route, attempt loop, SSE codec,
HTTP shell, 25 tests. This document plans milestone 2 in detail and the rest
in outline. Each milestone has an exit criterion that is observable, not a
feeling.

Working rules for every milestone:

- Every provider quirk lands as a fixture first, code second. The fixture name
  says what breaks without it.
- No provider name outside `src/wire/<name>.ts` and `src/presets.json`.
  A test greps for preset names to enforce it.
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

Exit criterion still open: a full working day on the subscription without
switching back to opencodex, with hosted web search, compaction and
`apply_patch` behaving exactly as with native Codex.

## Milestone 3: Codex talks to DeepSeek

**Status (2026-09-21): built; end-to-end verified against a real Chat Completions
upstream.** `src/ingress/responses.ts` (parse + respond), `src/wire/openai-chat.ts`
(encode + decode + classify) and the IR path in `src/pipeline.ts` are in. Real
Codex 0.153.4 ran a hello turn and a shell-tool loop (tool call, tool result,
summary) through modelplug to Kimi K3 over Chat Completions; 70 tests green.
Still open from the exit criterion below: the DeepSeek run itself (no key on the
dev machine), `apply_patch` and `view_image` turns against a live model, the
conformance scenario (step 8), the boundary test, and `check` probes (step 7).

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
- The freeform `apply_patch` lowering planned below is dormant in practice:
  classic Codex never declares a custom tool. Keep the generic custom-tool
  lowering (one string parameter named `input`) because other Responses
  clients may, and drop the apply_patch-specific envelope repair.
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

## Milestone 5: `anthropic` wire

Forces the `Opaque` design. Scope: system as top-level `system`; `thinking`
budget from effort (`low 2k / medium 8k / high 16k / max 32k`, `max_tokens`
raised above the budget); `tool_use` / `tool_result` pairing with results as the
leading blocks of the next user message; thinking block signatures as
`Opaque{kind:"signature"}` replayed only to the same provider and model;
`redacted_thinking` carried opaque; images as base64 blocks; `stop_reason`
mapping; 529 `overloaded_error` retryable; prompt-caching breakpoints on the
system block and the last user message (on by default, it is free).

Exit: Codex runs the M2 task against Claude with thinking on, across at least
three tool-calling turns, with zero `invalid signature` or
`thinking block order` errors. Conformance scenario green on both wires.

## Milestone 6: `messages` ingress

Claude Code's protocol. Parse `system` (string or blocks), messages with
`text`/`image`/`tool_use`/`tool_result`/`thinking`/`redacted_thinking` blocks,
`tools`, `tool_choice`, `thinking`, `metadata`. Respond with `message_start`,
`content_block_start/delta/stop`, `message_delta` (stop_reason + usage),
`message_stop`, periodic `ping`. `POST /v1/messages/count_tokens` answers an
estimate. Server-side Anthropic tools are dropped like hosted tools in M2.
Record Claude Code traffic first with `--record --forward https://api.anthropic.com`.

Exit: Claude Code runs a coding task against DeepSeek through modelplug; and a
round-trip property test shows `messages` → IR → `anthropic` wire reproduces the
original request's blocks for text, tools and thinking.

## Milestone 7: `gemini`, `openai-responses` through the IR, Grok and Kimi logins

Gemini: `systemInstruction`, `contents` with `user`/`model`, `functionCall` /
`functionResponse`, thought signatures as `Opaque{kind:"thought_signature"}`,
`thinkingConfig.thinkingBudget`, `streamGenerateContent?alt=sse`,
`usageMetadata`, and a fixture-backed JSON Schema sanitizer for keywords Gemini
rejects.

openai-responses via the IR (for API-key OpenAI, xAI, and any Responses
gateway): decisions deferred from M2 land here: whether `freeform` tools enter
the IR, whether hosted tools get a `Turn.hosted` list for wires that can pass
them through, and whether upstream `encrypted_content` rides as an `Opaque`.

Grok and Kimi logins as two more credential kinds in `src/credentials/`, only
because the maintainer uses them. Grok's transport has a history of breaking;
every quirk is a fixture in the wire, and the login lives in its own file so a
breakage is contained.

Exit: conformance scenario green on all four wires; Codex runs the M2 task
against Gemini and against OpenAI via API key.

## Milestone 8: 0.1.0

`POST /v1/responses/compact` for routed (non-passthrough) providers as a
summarization turn through the routed model, after capturing what Codex sends
and expects. Alias fallback documented honestly: failover happens before the
first byte only. `check` network probes, usage JSONL, `docs/CLIENTS.md`,
`CHANGELOG.md`, npm publish. Nothing from the non-goals list.
