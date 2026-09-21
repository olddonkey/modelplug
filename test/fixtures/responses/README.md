# Responses fixtures

Recorded 2026-09-21 from Codex CLI 0.153.4 (`codex exec`) against the real
ChatGPT Codex backend through `modelplug start --record --forward`, then
sanitized with `scripts/sanitize-captures.ts` (paths, username and every UUID
replaced; system prompts truncated to 240 characters; `encrypted_content`
replaced by a same-length placeholder; `usage.attribution` removed; the tool
catalog and `instructions` echoed inside `response.*` envelopes emptied or
truncated; the request keeps them).

Codex picks its wire dialect from the model name. `classic/` is what a routed
`provider/model` receives and is what milestone 2 parses. `lite/` is what
OpenAI model names receive and is what milestone 3 passes through untouched.

| Fixture | Shows |
|---|---|
| `classic/hello` | Smallest classic request: `instructions`, one developer message, environment context, the prompt; top-level function tools plus a `namespace` and a hosted `web_search`. Response is a text-only turn. |
| `classic/turn-1-first` | Same request shape; the **response** carries a `function_call` (`exec_command`) with `function_call_arguments.delta/done`. |
| `classic/turn-2-after-one-tool` | Replayed `function_call` + `function_call_output` (string output). |
| `classic/turn-3-after-two-tools` | Two call/output pairs, then a text answer. |
| `classic/apply-patch-turn` | `apply_patch` is executed through `exec_command` with a heredoc; there is no apply_patch tool in the classic catalog. |
| `classic/image-turn` | `input_image` with a base64 data URL and `detail: "high"`. |
| `classic/unknown-model-400` | The backend's 400 for a model name it does not serve; body and headers for `classifyError`. |
| `classic/request-headers.json` | The headers Codex sends (`originator`, `session-id`, `x-codex-turn-metadata`, …). |
| `lite/hello` | Responses Lite: no `instructions`, four developer messages, `additional_tools` input item with `functions` and `collaboration` namespaces, `text.verbosity`. |
| `lite/turn-2-after-exec` | Code mode: `custom_tool_call` named `exec` whose input is JavaScript, output as a list of `input_text` parts. Response streams `custom_tool_call_input.delta`. |
| `lite/turn-3-with-reasoning` | A replayed `reasoning` item with `encrypted_content` and an empty `summary`. |
| `lite/image-turn` | `input_image` in the Lite dialect. |
| `lite/request-headers.json` | Includes `x-openai-internal-codex-responses-lite: true`. |

Re-record after a Codex upgrade with the commands in `docs/PLAN.md`, step 0.
Never point a test at a live endpoint.
