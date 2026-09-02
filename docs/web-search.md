# Web Search

Web search modes, OpenRouter vs Venice behavior, result counts, and clickable sources. See the [README](../README.md#documentation) for the full docs index.

## Modes

Web search has three modes, persisted per model in `~/.communicator.json` under `webSearch` (default `off`):

- `auto` — the model decides when to search (recommended — searches only when useful)
- `always` — forces a search on every request
- `off` — disables web search

Set the mode with `--web-search <mode>` at launch or `/web-search <mode>` mid-chat. Legacy `on` maps to `auto` in both the CLI and slash commands; bare `--web-search` means `auto`, and bare `/web-search` shows the current mode. The chat banner shows the mode with a `[web: <mode>]` badge (`[web: auto]` / `[web: always]`), plus a result count when set.

## OpenRouter

- `auto` mode uses the `openrouter:web_search` server tool: the model decides whether to search, with 0–N searches per request and results surfacing as `url_citation` citations. The result count caps the *total* number of sources per answer — OpenRouter limits each search call individually, so a total cap is set explicitly.
- `always` mode uses the `web` plugin, which works on *any* model — powered by the provider's native search for Anthropic, Google, OpenAI, Perplexity and SpaceXAI models, with Exa as the fallback — and forces one search per request. OpenRouter now recommends the `openrouter:web_search` server tool over the plugin, but the plugin is still fully documented and functional; if it is ever removed, `always` requests will fail until this client is updated (no automatic fallback is implemented).
- The result count defaults to 10. OpenRouter bills web search per request: the default engine (Exa `auto`) costs $0.007/request including 10 results, then $0.001 per further result; Parallel (Basic/Advanced) and Perplexity cost $0.005/request; native search on supporting models is billed by the provider. Check [OpenRouter's web search docs](https://openrouter.ai/docs/features/web-search) for current rates. Override it per session with `--web-results <n>` or `/web-results <n>` (the banner then shows `[web: auto: N]` / `[web: always: N]`).
- `--web-results` implies `auto` mode for that invocation unless an explicit `--web-search <mode>` is given (e.g. `--web-search always --web-results 5` stays `always`); `/web-results` only sets the count, it does not change the mode. Validation accepts 1–20; larger values are rejected with an error (`--web-results must be at most 20.`).

## Venice

Venice.ai maps the mode to `venice_parameters.enable_web_search`: `auto` → `"auto"`, `always` → `"on"`, `off` → `"off"`. There is no result-count knob, so `--web-results`/`/web-results` have no effect there. Venice gates on the model's `supportsWebSearch` capability: enabling `auto`/`always` for a model that doesn't support web search refuses with a message (interactive) or exits with an error (CLI flags). Venice web search is billed per usage.

## Sources & persistence

- When web search is enabled, a numbered `Sources` section is printed after each answer (italic clickable OSC 8 hyperlinks in supporting terminals, plain text otherwise). Inline citations are also clickable and italic: OpenRouter models emit markdown links `[domain](url)`, Venice models emit `^n^` markers that map to the sources list.
- Sources are saved with each assistant message, so `--resume` replays the list and inline citations as clickable links, and `--export` includes them as a markdown `Sources` list with `^n^` markers converted to `[n](url)` links.
- Web search state is stored in the session file (`webSearch` mode / `webResults`) and restored on `--resume`. Existing `webSearch: true` prefs and sessions are read as `auto` (the smart mode), so previously-forced searches become model-decided unless you pick `always`.
