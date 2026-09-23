# Changelog

## 0.1.0 - 2026-09-23

### Added

- ChatGPT-subscription passthrough for Codex, with account import and browser login, pool selection strategies, conversation affinity, quota tracking, and cooldowns.
- Chat Completions routing through the shared IR, verified with real Codex against Kimi K3 for shell tools, `apply_patch`, and image input.
- The `anthropic` wire and the Claude Code `/v1/messages` ingress, including Messages-to-Anthropic passthrough and `count_tokens`.
- The `openai-responses` wire through the IR, with a per-provider `passthrough` switch. It defaults to on for ChatGPT credentials and the `anthropic` wire, and off otherwise.
- The `gemini` wire and tool-call Opaque replay through both Responses and Messages ingresses.
- Kimi and Grok subscription logins.
- `modelplug check` with network probes, a usage log, and client setup guidance in `docs/CLIENTS.md`.

### Known limits

- Alias failover and retries happen only before the first response byte reaches the client.
- `POST /v1/responses/compact` returns 400 for routed providers. Support is parked for milestone 8b, pending a live Codex recording; ChatGPT passthrough relays compaction unchanged.
- Real Codex has run through ChatGPT-subscription passthrough and the `openai-chat` wire to Kimi K3. The `anthropic` wire awaits live Claude acceptance with an API key; the `openai-responses` IR path awaits a live OpenAI or xAI key; the `gemini` wire awaits a live Google key. Those wire paths have fake-upstream and conformance coverage.
- The Claude Code ingress is implemented and tested, but a live Claude Code run is pending.
- The ChatGPT account pool is tested against fake upstreams; browser authorization reached the live login form, but the token exchange and a two-account live run remain pending. Kimi and Grok logins are exercised by tests, not yet live.
