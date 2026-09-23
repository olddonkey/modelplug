# modelplug design

## Positioning

One process, one config file, two ingress protocols, four wire protocols, zero
writes to the user's Codex or Claude Code installation. Readable in a day.

For: an individual developer who wants Codex or Claude Code to use other
models, with API keys or a ChatGPT subscription, and does not want a daemon or
a dashboard.

Not for: anyone who needs a GUI, Codex model-picker integration,
cross-provider reasoning replay, long-tail transports, or a Claude-subscription
login. For everything but the last one, opencodex does it well and the README
points there on its first screen. Staying small is the product.

## Why four wires are enough

In opencodex's provider registry, 66 preset references use the OpenAI Chat
Completions adapter, 11 use Anthropic, Gemini or OpenAI Responses, and 5 use
everything else (Kiro, Cursor, Azure, Mimo, command-code). The long tail costs
the most and serves the fewest.

## The one abstraction

```
Codex ───── /v1/responses ──┐                                ┌─ openai-chat
                            ├─▶ Turn (IR) ─▶ route ─▶ attempt ─┼─ openai-responses
Claude Code ─ /v1/messages ─┘                                  ├─ anthropic
                                                               └─ gemini
      ◀─── client SSE ◀──── encode ◀──── Event (IR) ◀──── decode ◀──── upstream
```

`src/ir.ts` is the whole contract. Two ingresses times four wires is eight
paths from six modules.

## Credentials are a separate layer

`src/credentials/` is the only part of modelplug that holds secrets or
per-account state. The kernel calls two functions per attempt:

```
resolve(target, attempt, conversationId) -> Credential { id, apiKey?, headers?, baseUrl? }
report(target, credential, { outcome, error?, headers? })
```

`api-key` is the trivial implementation. `chatgpt` (milestones 2 and 4) is a
pool of ChatGPT accounts: it imports or logs in, refreshes tokens, reads quota
headers, picks an account per conversation, cools an account down on 429 and
rotates on 401. Rotating an account is the same target on a later attempt, so
the retry loop does not change; falling to another target is still alias
fallback.

Rules:

- Wires never see credentials beyond the `ProviderTarget` they already get.
  The IR does not change for any credential kind.
- One file, `credentials.json` (mode 0600), holds tokens and account lists.
  Quota and affinity live in memory and are lost on restart, deliberately.
- Same-protocol passthrough: when the ingress is `responses` and the wire is
  `openai-responses`, the kernel relays bytes instead of round-tripping the
  IR, so ChatGPT-native features (hosted web search, compaction, custom tools)
  survive. The passthrough may inject headers, relay the stream, and read
  status codes and response headers. It may not rewrite payloads. A rewrite
  that ever becomes unavoidable is one named function with one fixture, never
  a list.
- Anthropic OAuth (Claude subscription tokens) is a permanent non-goal.
  Anthropic forbids third-party use of those tokens and actively blocks it.
- The README carries a provider-policy note: pooling is for convenience and
  resilience, gives no protection from provider limits or enforcement, and the
  user is responsible for each provider's terms.

The layer is written so it can move to its own package later. The interface is
the boundary; the directory is a convenience.

## Five stances that keep it small

1. **No conversation state.** Anything a provider needs replayed across turns
   (thinking signatures, thought signatures, encrypted reasoning) is wrapped in
   an `Opaque` and carried inside the client's own transcript, in fields the
   client already echoes back. No response cache, no replay store, no spill
   directory. The only persisted files are the config, `credentials.json`, and
   the usage log.
2. **Zero host mutation.** `modelplug print codex` and `print claude` emit
   the snippet; the user pastes it. Reading `~/.codex/auth.json` to import a
   login is allowed; writing anything under `~/.codex` or `~/.claude` is not.
   No journal, no restore, no shim, no signals to other processes.
3. **Capabilities, not flags.** A closed `Capabilities` record with a handful
   of dimensions, resolved from wire defaults, a preset, and user overrides.
   Adding a dimension is an IR change and is done deliberately. Anything that
   cannot be a capability is a named, fixture-backed middleware inside the
   wire that needs it.
4. **Errors classified once.** The wire that understands the format produces a
   structured `WireError`. The attempt loop and the credential layer read
   `kind`, `retryable` and `retryAfterMs`. No string matching on upstream text
   anywhere else.
5. **One retry loop.** `attempt.ts`. Retry the same target while the error is
   retryable and bytes have not reached the client; then the next target in the
   alias list; then a single structured failure.

## Runtime

Node 24+, TypeScript executed natively in development, `tsc` emit for the
published package because Node does not strip types under `node_modules`.
One runtime dependency (zod). No bundled runtime, no install scripts.

## Milestones

Detailed plan with steps and exit criteria: [PLAN.md](PLAN.md).

| # | Milestone | Proves |
|---|---|---|
| 1 | IR, config, route, attempt, SSE codec, server shell | done |
| 2 | ChatGPT subscription: import from Codex's `auth.json`, refresh, same-protocol passthrough | the credential seam and the passthrough rules |
| 3 | `responses` ingress + `openai-chat` wire; Codex runs a Chat Completions model end to end | the IR (built; Codex 0.155.1 ran shell, apply_patch and tests against Kimi; golden fixtures recorded) |
| 4 | Account pool: several accounts, quota headers, selection, affinity, cooldown, PKCE login | the pool fits inside one retry loop (built against fakes; first live login pending) |
| 5 | `anthropic` wire | the `Opaque` design |
| 6 | `messages` ingress | the IR under a second client |
| 7 | `gemini` and `openai-responses` through the IR; Grok and Kimi logins | four wires, conformance green |
| 8a | 0.1.0 release hygiene: changelog, version, package contents, README status | done (2026-09-23); usage log and `check` probes already shipped |
| 8b | Routed `/v1/responses/compact` | parked pending a live Codex recording |

## Testing shape

- Wires: golden fixtures, recorded upstream frames in, expected `Event[]` out.
- Kernel: one conformance scenario run through every wire with a fake
  upstream (the apply_patch scenario with a non-ASCII filename, quotes and a
  backslash, borrowed from opencodex).
- Credentials: fake token and quota endpoints; never a live login in CI.
- A handful of real-server tests for the HTTP shell. Not more.

## Non-goals, permanently

GUI, i18n, service install, self-update, tray, hub or remote mode, routing
policies beyond alias fallback, image generation, WebSocket ingress,
web-search or vision sidecars, writing into `~/.codex`, Anthropic OAuth.
