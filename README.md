# modelplug

A small local proxy that lets **Codex** and **Claude Code** talk to any model.

One process, one config file, two ingress protocols, four wire protocols, zero
writes to your Codex or Claude Code installation. Bring API keys, or log in
with your ChatGPT subscription. You can read the whole thing in a day.

> Status: pre-alpha. The ChatGPT-subscription passthrough works end to end with
> real Codex; routed providers (DeepSeek, Anthropic, Gemini, …) are the next
> milestones and answer a clear error until then.
> See [docs/DESIGN.md](docs/DESIGN.md) and [src/wire/README.md](src/wire/README.md).

## What it does

```
Codex ───── /v1/responses ──┐                                ┌─ openai-chat ──────▶ DeepSeek / Kimi / Qwen / GLM / Groq / OpenRouter / Ollama / vLLM
                            ├─▶ Turn (IR) ─▶ route ─▶ attempt ─┼─ openai-responses ─▶ OpenAI / xAI
Claude Code ─ /v1/messages ─┘                                  ├─ anthropic ────────▶ Anthropic
                                                               └─ gemini ───────────▶ Google
```

Streaming, tool calls, image input and reasoning are translated in both
directions. Model aliases can name an ordered fallback list.

## What it deliberately does not do

If you need any of these, use [opencodex](https://github.com/lidge-jun/opencodex),
which does all of them well:

- A web dashboard
- Writing into `~/.codex` so routed models show up in Codex's model picker
- Cross-provider replay of reasoning between turns
- Kiro, Cursor, Azure and other long-tail transports
- Web-search and vision sidecars, image generation, WebSocket mode
- Service installation, self-update, system tray
- Logging in with a Claude subscription. Anthropic forbids third-party use of
  those tokens and blocks it; modelplug will not chase that.

modelplug stays small by saying no to these. That is the product.

> **Provider policy.** Using several ChatGPT accounts through modelplug is for
> convenience and resilience only. It gives no protection from provider rate
> limits, enforcement, or account actions, and it is not an endorsement of
> circumventing limits or sharing accounts between people. You are responsible
> for complying with each provider's current terms.

## Quick start

```bash
npm install -g modelplug

# ChatGPT subscription: reuse the login Codex already has, then run
modelplug login chatgpt --import
MODELPLUG_PRESET=chatgpt modelplug
modelplug print codex --model gpt-5.5       # paste into ~/.codex/config.toml

# or an API-key provider, no config file needed (routed wires land in later milestones)
MODELPLUG_PRESET=deepseek DEEPSEEK_API_KEY=sk-... modelplug

# or a config file for several providers
modelplug login chatgpt --import   # reuse the login Codex already has
modelplug check            # validate config, show resolved providers and aliases
modelplug print codex      # snippet to paste into ~/.codex/config.toml
modelplug print claude     # environment variables for Claude Code
```

`~/.config/modelplug/config.json` (or `./modelplug.json`):

```json
{
  "providers": {
    "deepseek":  { "preset": "deepseek", "apiKey": "${DEEPSEEK_API_KEY}" },
    "anthropic": { "preset": "anthropic", "apiKey": "${ANTHROPIC_API_KEY}" },
    "local":     { "wire": "openai-chat", "baseUrl": "http://localhost:11434/v1" }
  },
  "aliases": {
    "fast": ["deepseek/deepseek-v4", "local/qwen3"]
  }
}
```

Models are addressed as `provider/model`. An alias whose value is a list is
tried in order until one target answers.

## Design in one paragraph

Everything pivots on one intermediate representation (`src/ir.ts`). Ingress
modules turn a client request into a `Turn`; wire modules turn a `Turn` into an
upstream request and the upstream stream into `Event`s; ingress modules turn
`Event`s back into the client's protocol. Two ingresses times four wires gives
eight paths from six modules. Nothing outside a wire module may name a
provider. Provider differences live in a small typed `Capabilities` record
(`src/presets.json`), not in flags. Errors are classified once, inside the wire
that understands the format. There is exactly one retry loop. There is no
server-side conversation state: anything a provider needs replayed is carried
inside the client's own transcript. Credentials, including ChatGPT account
pools, live in one separate layer behind a two-function interface; the kernel
and the wires never see a token.

## Acknowledgements

modelplug borrows its cross-wire conformance scenarios and a good deal of
hard-won protocol knowledge from [opencodex](https://github.com/lidge-jun/opencodex)
(MIT). It is not a fork and shares no code; it is the small product that
project's design space also contains.

## License

MIT
