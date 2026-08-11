# Development

Internal architecture and the provider contract for contributors. See the [README](../README.md#documentation) for the full docs index.

## How it works

```
cli (index.js)            — commander argument parsing, delegates to runCli
├── cli-main.js           — runCli: error handling (ApiError/CliError/ExitPromptError), dispatch to commands and config setters
├── cli-utils.js          — resolveFlagOrExit (throws CliError on invalid flag values), collectFlag (repeatable --attach)
├── cli-validation.js     — pure flag-combination validation (validateCliFlags) + flag-group predicates
├── commands/
│   ├── list-models.js    — --list-models handler
│   ├── list-endpoints.js — --list-endpoints handler
│   ├── list-sessions.js  — --list-sessions handler
│   ├── export-cmd.js     — --export handler
│   ├── delete-cmd.js     — --delete handler (confirm + remove session)
│   ├── delete-all-cmd.js — --delete-all-sessions handler (wipe all sessions)
│   ├── config-set.js     — standalone config setters (--model, --temperature, ... persist defaults)
│   ├── config-view.js    — bare --config: print the current preferences
│   ├── one-shot.js       — one-shot mode: prompt argument / stdin piping
│   ├── resume.js         — --resume handler (load session, return params)
│   ├── chat-start.js     — session context setup, chat start, end-of-chat persist
│   ├── image-gen.js      — image generation command (--image flag, sizing validation, persistence)
│   ├── image-session.js  — interactive image session REPL (sizing commands, /model handoff to chat)
│   └── chat/
│       └── index.js      — slash command registry (17 chatCommands) + budgetGuard
├── providers/
│   ├── index.js          — factory: getProvider(name) → provider module; common chatCompletion contract
│   ├── openrouter.js     — OpenRouter API client: models, endpoints, chat completions
│   └── venice.js         — Venice.ai API client: models, synthetic endpoints, chat
├── model-selection.js    — interactive and non-interactive (-m) selection flows
├── session-setup.js      — shared one-shot/chat-start helpers: resolveSessionFlags, attachGateOptions, persistSession
├── http.js               — fetchWithTimeout (30s) + fetchWithRetry (backoff, retries timeouts)
├── errors.js             — ApiError (status/provider/retryable), TimeoutError, CliError (exitCode), formatError
├── sse-parser.js         — shared SSE stream parser (idle-timeout stall detection; consumed by both providers)
├── attachments.js        — attachment model: classify/load files (size limits), capability gate, content parts ↔ text helpers (contentText/messageText)
├── attachment-store.js   — blob externalization/hydration, ref sentinels, artifact downloads
├── artifacts.js          — model-produced artifact handling (image/file output downloads and display)
├── config.js             — API key lookup (provider meta), preferences load/save (~/.communicator.json)
├── constants.js          — shared constants (paths, labels, temperature bounds, SSE markers) and formatCost
├── prompts.js            — interactive TUI pickers using @inquirer/prompts (model, provider, reasoning effort)
├── flags.js              — CLI flag resolvers (temperature, web search/results, reasoning, budget)
├── reasoning.js          — reasoning effort default resolution + web search capability check
├── image-sizing.js       — pixel sizing helpers for pixel-based Venice image models
├── chat-state.js         — ChatState: session state + pure transitions + final-state snapshot
├── turn-runner.js        — per-turn orchestration (stream render, abort, interrupt salvage, usage tracking)
├── signals.js            — process signal registration (SIGINT/beforeExit/uncaughtException) + cleanup
├── sessions.js           — session persistence: save, load, list, title generation, delete, sidecar index, resolve
├── session-picker.js     — interactive session selector for --resume, --export, and --delete
├── export.js             — markdown exporter: format session data, write to file
├── tracker.js            — per-turn + cumulative token/cost accounting with cache detection, budget status helpers
├── clipboard.js          — clipboard copy via pbcopy/clip/wl-copy/xclip/xsel
├── input.js              — chat input via vendored read-multiline (with command suggestions)
├── suggest.js            — prefix matching for command suggestions (matchCommands)
├── vendor/
│   └── read-multiline/   — vendored @toiroakr/read-multiline@0.4.1 + suggest patch (see its README)
├── ui/
│   ├── style.js          — ANSI helpers (dim, bold, sep, thinking, answer)
│   ├── format.js         — price formatting (formatModelPrice, formatPricePerM)
│   ├── io.js             — output helpers (out/err) and debug logging (COMMUNICATOR_DEBUG=1)
│   ├── markdown.js       — streaming terminal markdown renderer (in-place line redraw)
│   ├── md-it.js          — markdown-it engine: ANSI token rendering, line classification, aligned tables
│   ├── hyperlink.js      — OSC 8 hyperlink escape helper
│   ├── loader.js         — waiting indicator (braille spinner) for pending responses
│   └── stream.js         — stream renderer + history replay
└── chat.js               — runChatSession: DI chat loop (readInput/renderer/stdout/exit/save/signals), banner, SIGINT
```

Dependencies: [`commander`](https://www.npmjs.com/package/commander) for CLI argument parsing, [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) and [`@inquirer/core`](https://www.npmjs.com/package/@inquirer/core) for the interactive search/select UI, [`markdown-it`](https://www.npmjs.com/package/markdown-it) for terminal markdown rendering, and [`string-width`](https://www.npmjs.com/package/string-width) for emoji-aware column measurement (stream rewind math). Multi-line input uses a vendored copy of [`@toiroakr/read-multiline`](https://www.npmjs.com/package/@toiroakr/read-multiline) 0.4.1 (see `src/vendor/read-multiline/README.md`).

## Architecture

The chat flow is built around four pieces:

- **`ChatState` (`src/chat-state.js`)** — the mutable session state (model, reasoning effort, temperature, budget, web search, messages, …) with pure transitions (`setTemperature`, `applyModelSelection`, `toggleMarkdown`, …). `toFinalState()` produces the exact snapshot written to the session file; `resetForNewSession()` backs `/new`.
- **Command registry (`src/commands/chat/index.js`)** — the 17 slash commands live in a data-driven map of `/name → async (ctx) => outcome`; `CHAT_COMMANDS` is derived from the registry keys so the suggestion list and the loop can never drift. Handlers never call `process.exit` — they return `{ exit }` / `{ reset }` signals that the loop translates into exit codes, which keeps every handler unit-testable (`test/chat-commands.test.js`).
- **`runChatSession(ctx, deps)` (`src/chat.js`)** — the chat loop is dependency-injected: `deps = { readInput, renderer, stdout, exit, saveSession, savePrefs, onSignal, newSessionId }`, each defaulting to the real implementation, so production behavior is unchanged while the whole loop is drivable with fakes (`test/chat-loop.test.js`). Signal handling (idle/streaming SIGINT, `beforeExit`, `uncaughtException`) is registered through `onSignal` (`src/signals.js`); per-turn orchestration — stream rendering, abort, interrupt salvage, usage tracking — lives in `src/turn-runner.js` on a shared `sessionState` object.
- **`src/flags.js`** — CLI flag parsing helpers (`resolveTemperatureFlag`, `resolveWebResultsFlag`, `resolveWebSearchFlag`, `resolveReasoningFlag`, `resolveBudget`) shared by the chat loop, one-shot mode, and chat-start.

`src/reasoning.js` holds the two model-capability helpers: `resolveEffortDefault` (forced flag → auto-reasoning → saved pref → model default, `'none'` normalized to `null`) and `isWebSearchSupported` (provider-wide or per-model capability).

## Provider contract

Adding a new provider requires implementing the following exports:

```js
export const meta = { name, baseURL, apiKeyEnv, hasEndpoints }
export async function fetchModels(apiKey) → [{id, name, provider, contextLength, description, reasoning, pricing, capabilities}]
export async function fetchEndpoints(apiKey, modelId, allModels?) → [{name, providerName, tag, status, uptime30m, pricing, ...}]
export async function chatCompletion({apiKey, model, messages, onToken, provider, reasoningEffort, supportsReasoning, sessionId, temperature, webSearch, webResults, signal}) → {content, reasoning, usage}
export function normalizePricing(rawPricing) → {prompt, completion}
export function handleHttpError(status, body) → throws ApiError
```

- `pricing` is `{ prompt, completion }` USD per token (or `null`) — use `normalizePricing` and the helpers in `src/ui/format.js` for display
- `chatCompletion` receives `signal` (AbortController) for SIGINT cancellation, `sessionId` for server-side prompt caching (OpenRouter currently ignores it; Venice maps it to `prompt_cache_key`), and `temperature` (default `0.7`, must be set in the request body). `webSearch` is a mode string (`'off' | 'auto' | 'always'`); `webResults` is the OpenRouter result count — providers may ignore options they do not support (see the contract doc in `src/providers/index.js`). It also receives `onSources(sources)` and returns `sources: [{ title, url }]` (empty when web search is off or the provider returned no citations)
- HTTP calls should go through `fetchWithRetry` from `src/http.js`; errors must be thrown as `ApiError`, never `process.exit`

See `src/providers/openrouter.js` and `src/providers/venice.js` for reference implementations.

## Documentation maintenance

`test/docs-consistency.test.js` mechanically verifies that the user-facing docs (`README.md`, `docs/`) stay in line with the code: CLI flags and slash commands match their registries, env vars / data paths / Node version / key defaults are mentioned, example flags exist, and every markdown link resolves. It runs as part of `npm test` — keep it green whenever a flag, command, default, path, or doc page changes.

The check cannot verify behavioral prose. When touching related code, re-verify these documented behaviors (each is correct as of v3.29.0):

- CTX indicator: hidden below 5% occupancy, yellow at ≥80%, red at ≥95%, peak never decreases (`src/tracker.js`).
- Budget: warning row at ≥80% used, turns refused at ≥100% (`src/tracker.js`, `src/commands/chat/index.js`).
- Smooth streaming: default on in TTY sessions, ~40 chars per 20 ms tick, presets slow/normal/fast = 500/2000/8000 chars/s, piped output never paced (`src/constants.js`).
- Config, session and sidecar files are written atomically (temp + rename) and crash-safe: a killed process never leaves a truncated JSON file behind (`src/fs-utils.js`).
- E2EE streams fail closed: an unencrypted chunk in an `--e2ee` session aborts the stream instead of rendering (`src/sse-parser.js`).
- One-shot mode: piped stdin capped at 10 MB; exit codes 0 / 1 / 130 (`src/cli-utils.js`, `src/cli-main.js`, `src/turn-runner.js`).
- Attachment limits: images 20 MB, pdf/office/text 25 MB, inline text 256 KB warning; office formats are Venice-only.
- Clipboard probe order: macOS `pbcopy`, Windows `clip`, Linux `wl-copy` → `xclip` → `xsel`, with a 10 s timeout per tool (`src/clipboard.js`).
- Reasoning effort: `EFFORT_LABELS` mapping; `none` disables reasoning; Venice uses `reasoning_effort`, OpenRouter its native format.
- Web search: modes `off`/`auto`/`always` (`on` maps to `auto`); OpenRouter `auto` = server tool with a total result cap, `always` = legacy plugin; Venice maps to `enable_web_search`; the chat banner shows a `[web: <mode>]` badge.
- ZDR: OpenRouter-only, filters pickers to ZDR-capable endpoints, runtime error kept as a safety net, not persisted.
- Venice watermark (image-session `/watermark off` hides it → `hideWatermark: true`) and safe-mode are global preferences.
- Session file format: `providerName`/`providerType`/`usage`/`sources` fields, `ref://attachments/` blobs, the `.index.json` sidecar rebuild, title from the first user message truncated to 50 chars.
- Command autocomplete: hints appear on `/`, Tab fills the first match, Shift+Tab the last, Enter always submits.
