# Providers

The two API backends, including zero-data-retention routing. See the [README](../README.md#documentation) for the full docs index.

Communicator supports two API backends:

- **OpenRouter** — Multi-provider gateway with endpoint-level routing. When you select a model, you'll pick which provider (e.g., OpenAI, Azure, Anthropic) actually serves the request. Supports cache-hit detection and per-endpoint pricing comparisons. Use `--provider openrouter` (this is the default).

- **Venice.ai** — Direct model access without multi-provider routing. Models are available directly; there's no endpoint picker step. Venice's `/models` endpoint is public, so you can list models without an API key. Use `--provider venice`.

The provider is saved in each session, so resuming a Venice session automatically uses the Venice backend — no need to pass `-p venice` again.

## Zero data retention (ZDR)

OpenRouter lets you force **zero data retention** per request: no caching, no logging, no training on your prompts or responses. Pass `--zdr` (OpenRouter only — silently ignored on Venice) and every request in the session carries `provider.zdr: true`. Selection is **filtered to ZDR-capable entries**: the model picker shows only models that have a zero-retention endpoint, the provider picker shows only `[zero retention]` endpoints, and a non-interactive `-m <model>` fails at selection — before any request — if the model has no ZDR endpoints. The runtime error is kept as a safety net for paths that bypass selection (`--resume`, mid-chat model switches, index drift). Without `--zdr` nothing changes — normal (non-ZDR) routing applies.

Privacy metadata comes from OpenRouter's own public endpoints and is fetched live (cached briefly, non-fatal on failure):

- **`[zero retention]` tag** — the provider picker marks endpoints listed in OpenRouter's ZDR index; `--list-endpoints` shows a `zdr yes/no` column; `--list-models` marks models that have at least one ZDR-capable endpoint as `[zdr]`
- **Privacy policy links** — each provider row in `--list-endpoints` prints its `privacy policy` URL, and the picker's description line shows a clickable `privacy policy` OSC 8 hyperlink (plain text in terminals without hyperlink support)

Caveats: `--zdr` is a per-invocation flag, not persisted. ZDR-capable providers may not support web search — combining `--zdr` with `--web-search` is allowed, but the request can be rejected by the API depending on the provider. If OpenRouter's ZDR index can't be fetched, `--zdr` prints a warning and skips filtering, relying on the runtime error instead. `--resume` keeps the session's model/effort/temperature but ZDR must be re-passed with `--zdr` on the resuming invocation.
