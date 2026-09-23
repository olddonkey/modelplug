# Pointing clients at modelplug

modelplug never writes into `~/.codex` or `~/.claude`. Every snippet below is
printed by `modelplug print codex` or `modelplug print claude` with your
configured host and port; you paste it.

## Codex

Add to `~/.codex/config.toml` (root keys first, then the table):

```toml
model_provider = "modelplug"
model = "deepseek/deepseek-v4"

[model_providers.modelplug]
name = "modelplug"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
```

Switch models by editing `model`, with `codex -m provider/model`, or with
profiles:

```toml
[profiles.deepseek]
model_provider = "modelplug"
model = "deepseek/deepseek-v4"

[profiles.chatgpt]
model_provider = "modelplug"
model = "gpt-5.5"
```

then `codex --profile deepseek`.

### Why my routed model is not in Codex's model picker

Codex's picker lists the models it knows from its own catalog. modelplug does
not write into `~/.codex` to add entries (a permanent non-goal, see
[DESIGN.md](DESIGN.md)), so a routed model is selected by name in
`config.toml`, on the command line, or through a profile. `modelplug models`
and `GET /v1/models` list every `provider/model` and alias modelplug will
accept; `/v1/models` also carries the ids each provider reported when the
proxy probed it at start.

### Model names decide the dialect

Codex chooses its wire dialect from the model name, so the name you put in
`model` matters more than it looks:

| Model name | What Codex sends | What modelplug does |
|---|---|---|
| A bare OpenAI name (`gpt-5.5`, `gpt-5.6-sol`) | Responses Lite: code mode, `additional_tools`, hosted web search | With `defaultProvider: "chatgpt"`, relays it byte for byte to the ChatGPT backend on your subscription. Everything native keeps working. |
| `provider/model` (`deepseek/deepseek-v4`, `kimi/k3`) | The classic Responses dialect: `instructions`, function tools, `function_call` items | Translates to the provider's wire and back. |
| `chatgpt/gpt-5.6-sol` | Classic, because the name has a prefix | Works, but Codex loses code mode. Prefer the bare name with `defaultProvider`. |

For a Kimi Code subscription, run `modelplug login kimi`, configure a provider
with `{ "preset": "kimi" }`, and select `kimi/k3`. The login prints a URL and
code to enter in your browser; modelplug refreshes the token automatically.
The `moonshot` preset is for Moonshot API keys.

A Lite request that reaches a routed provider is refused with a 400 that says
so, because code mode cannot be translated. Use a `provider/model` name, or
route that model through the `chatgpt` provider.

Recommended config for both worlds:

```json
{
  "providers": {
    "chatgpt":  { "preset": "chatgpt" },
    "deepseek": { "preset": "deepseek", "apiKey": "${DEEPSEEK_API_KEY}" }
  },
  "defaultProvider": "chatgpt"
}
```

`gpt-5.5` goes to your subscription unchanged; `deepseek/deepseek-v4` goes to
DeepSeek.

### Checking the setup

```bash
modelplug check
```

validates the config, probes every provider (`GET /models` through its
credential, five second timeout), and expands every alias. A provider that
answers 401, or does not answer, fails the check. `--offline` skips the
probes.

## Claude Code

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:10100"
export ANTHROPIC_AUTH_TOKEN="modelplug"
export ANTHROPIC_MODEL="deepseek/deepseek-v4"
# Optional: route the small/fast model too
# export ANTHROPIC_SMALL_FAST_MODEL="deepseek/deepseek-v4"
```

`ANTHROPIC_AUTH_TOKEN` can be anything; modelplug does not read it. Logging in
with a Claude subscription through modelplug is a permanent non-goal.
Use a `provider/model` name to route through the IR. An `anthropic` provider
relays Messages responses byte for byte with its configured key injected.
`/v1/messages/count_tokens` is exact on passthrough and an estimate for routed
providers (text bytes divided by four, rounded up, plus 1,500 per image).

## Any other Responses client

`POST /v1/responses` accepts the classic Responses dialect with the full
transcript in `input` and `store: false`. `previous_response_id` and
`item_reference` are refused: modelplug keeps no conversation state. Provider
reasoning that must be replayed (signatures, encrypted reasoning) travels in
`reasoning` items' `encrypted_content`; echo them back untouched.
