# Ingress modules

An ingress speaks one client protocol.

| Ingress | Path | Client | Notes |
|---|---|---|---|
| `responses` | `POST /v1/responses`, `POST /v1/responses/compact` | Codex | Codex sends `store: false` with the full transcript, so there is no `previous_response_id` support and no server-side state. Provider `Opaque` blobs ride in `reasoning` items' `encrypted_content`; a tool call's provider data rides in a `reasoning` item bound to the call by our envelope. `usage.input_tokens_details` and `output_tokens_details` are always emitted because strict clients require them. |
| `messages` | `POST /v1/messages`, `POST /v1/messages/count_tokens` | Claude Code | Thinking signatures carry our `Opaque` envelope through the client transcript; tool-call provider data rides in a `redacted_thinking` block bound to the call by our envelope. `count_tokens` is relayed exactly for same-protocol passthrough and estimated locally for routed providers. |

`parse(body, headers)` produces a `Turn` plus the raw `modelRef`; the caller
routes and runs attempts. `respond(events, parsed, sink)` writes the client
protocol from the event stream. An ingress never sees a provider name.
