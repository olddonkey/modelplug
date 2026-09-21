# Fixtures

`<wire>/<behaviour>.sse` holds recorded upstream frames; `<wire>/<behaviour>.events.json`
holds the `Event[]` a correct decode produces. The file name says what breaks
without it, for example `anthropic/tool-use-with-thinking-signature.sse`.
Record with real upstreams, then strip anything identifying. Never point a test
at a live endpoint.
