# Development

Internal architecture and the provider contract for contributors. See the [README](../README.md#documentation) for the full docs index.

## How it works

```
cli (index.js)            — commander argument parsing, delegates to runCli
├── cli-main.js           — runCli: error handling (ApiError/CliError/ExitPromptError), dispatch to commands
├── cli-utils.js          — resolveFlagOrExit (throws CliError on invalid flag values), collectFlag (repeatable --attach)
├── cli-validation.js     — pure flag-combination validation (validateCliFlags) + flag-group predicates
├── commands/
│   ├── list-models.js    — --list-models handler
│   ├── list-endpoints.js — --list-endpoints handler
│   ├── list-sessions.js  — --list-sessions handler
│   ├── export-cmd.js     — --export handler
│   ├── delete-cmd.js     — --delete handler (confirm + remove session)
│   ├── delete-all-cmd.js — --delete-all-sessions handler (wipe all sessions)
│   ├── config-view.js    — bare --config: print the current preferences
│   ├── one-shot.js       — one-shot mode: prompt argument / stdin piping
│   ├── resume.js         — --resume handler (load session, return params)
│   ├── rpg-resume.js     — --rpg --resume chapter resolution (picker / most recent)
│   ├── chat-start.js     — session context setup, chat start, end-of-chat persist
│   ├── image-gen.js      — image generation command (--image flag, sizing validation, persistence)
│   ├── image-session.js  — interactive image session REPL (sizing commands, /model handoff to chat)
│   └── chat/
│       └── index.js      — slash command registry (27 chatCommands) + budgetGuard
├── providers/
│   ├── index.js          — factory: getProvider(name) → provider module; common chatCompletion contract
│   ├── openrouter.js     — OpenRouter API client: models, endpoints, chat completions
│   ├── openrouter-meta.js — ZDR index / provider policies metadata with TTL caches
│   └── venice.js         — Venice.ai API client: models, synthetic endpoints, chat
├── model-selection.js    — interactive and non-interactive (-m) selection flows
├── session-setup.js      — shared one-shot/chat-start helpers: resolveSessionFlags, attachGateOptions, persistSession
├── http.js               — fetchWithTimeout (30s) + fetchWithRetry (backoff, retries timeouts), pinned-SSRF fetch for artifact downloads
├── fs-utils.js           — writeFileAtomic (tmp + rename, private mode)
├── errors.js             — ApiError (status/provider/retryable), TimeoutError, CliError (exitCode), formatError
├── sse-parser.js         — shared SSE stream parser (idle-timeout stall detection; consumed by both providers)
├── attachments.js        — attachment model: classify/load files (size limits), capability gate, content parts ↔ text helpers (contentText/messageText)
├── image-transform.js    — attachment image preprocessing: lazy sharp load, 2048 px downscale, EXIF orientation baked, metadata stripped
├── heic-decode.js        — macOS-only HEIC/HEIF decode through the system sips converter (temp dir, SIGKILL timeout, null on failure)
├── attachment-store.js   — blob externalization/hydration, ref sentinels, artifact downloads
├── artifacts.js          — model-produced artifact handling (image/file output downloads and display)
├── config.js             — API key lookup (provider meta), preferences load/save (~/.communicator.json)
├── constants.js          — shared constants (paths, labels, temperature/top-p bounds, SSE markers) and formatCost
├── prompts.js            — interactive TUI pickers using @inquirer/prompts (model, provider, reasoning effort)
├── flags.js              — CLI flag resolvers (temperature, top-p, web search/results, reasoning, budget)
├── rpg.js                — --rpg mode: template provisioning, Markdown loading, and system-prompt assembly
├── reasoning.js          — reasoning effort default resolution + web search capability check
├── image-sizing.js       — pixel sizing helpers for pixel-based Venice image models
├── chat-state.js         — ChatState: session state + pure transitions + final-state snapshot
├── turn-runner.js        — per-turn orchestration (stream render, abort, interrupt salvage, usage tracking)
├── stream-keys.js        — streaming-phase raw-mode key listener (Esc stop / \x03 interrupt)
├── signals.js            — process signal registration (SIGINT/beforeExit/uncaughtException) + cleanup
├── sessions.js           — session persistence: save, load, list, title generation, delete, sidecar index, resolve
├── session-sidecar.js    — sessions .index.json storage layer (read/write, staleness, entry maintenance)
├── session-picker.js     — interactive session selector for --resume, --export, and --delete
├── export.js             — session exporter: markdown + JSONL formatting, write to file
├── tracker.js            — per-turn + cumulative token/cost accounting with cache detection, budget status helpers
├── status-line.js        — session-setting badges and the live chat status line
├── scrape.js             — web-scraping context normalization (--scrape)
├── e2ee.js               — E2EE crypto (ECDH + HKDF + AES-256-GCM) and TEE attestation
├── clipboard.js          — clipboard copy via pbcopy/clip/wl-copy/xclip/xsel and clipboard image read for /paste (osascript/wl-paste/xclip/PowerShell)
├── editor/
│   ├── chars.js           — display-width helpers (wcwidth-style)
│   ├── style.js           — theme/style resolution (stateful prefixes, prompt header)
│   ├── footer.js          — help footer builder + kitty protocol detection
│   ├── history.js         — prompt history persistence (atomic append)
│   ├── model.js           — pure buffer/cursor/undo/redo/history state machine
│   ├── layout.js          — grid computation (explicit word-aware wrapping + cursor mapping)
│   ├── paint.js           — shadow-frame diff paint kernel (in-place/forward/absolute modes)
│   ├── keys.js            — raw-mode input consumer (paste markers, escapes, DSR replies)
│   └── index.js           — readEditor: terminal lifecycle, keymap, submit/cancel
├── spelling/
│   ├── index.js           — spelling provider composition + platform backend selection (darwin helper / portable nspell)
│   ├── jxa.js             — JXA program text for osascript (NSSpellChecker)
│   ├── osascript.js       — osascript backend (one child per call, hard timeout)
│   ├── helper.m           — Objective-C spelling daemon source (compiled into ~/.communicator)
│   ├── helper-backend.js  — compiled-helper backend (build/cache/spawn/watchdog, osascript fallback)
│   ├── provider.js        — platform-free spelling core (cache, debounce, failure policy)
│   ├── mask.js            — prose masking (which words may be underlined)
│   └── nspell.js          — portable spelling backend (nspell + the English dictionary, Linux/Windows)
├── input.js              — chat input via the frame-diffing editor (with command suggestions)
├── suggest.js            — prefix matching for command suggestions (matchCommands)
├── ui/
│   ├── style.js          — ANSI helpers (dim, bold, sep, thinking, answer)
│   ├── format.js         — price formatting (formatModelPrice, formatPricePerM)
│   ├── io.js             — output helpers (out/err) and debug logging (COMMUNICATOR_DEBUG=1)
│   ├── markdown.js       — streaming terminal markdown renderer (in-place line redraw)
│   ├── md-it.js          — markdown-it engine: ANSI token rendering, line classification, aligned tables
│   ├── wrap.js           — word-aware folding of terminal lines (styled lines + streaming plain pieces)
│   ├── hyperlink.js      — OSC 8 hyperlink escape helper
│   ├── loader.js         — waiting indicator (live wait clock + braille spinner) for pending responses
│   └── stream.js         — stream renderer + history replay
└── chat.js               — runChatSession: DI chat loop (readInput/renderer/stdout/exit/save/signals), banner, SIGINT
```

Dependencies: [`commander`](https://www.npmjs.com/package/commander) for CLI argument parsing, [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) and [`@inquirer/core`](https://www.npmjs.com/package/@inquirer/core) for the interactive search/select UI, [`markdown-it`](https://www.npmjs.com/package/markdown-it) for terminal markdown rendering, [`string-width`](https://www.npmjs.com/package/string-width) for emoji-aware column measurement (stream rewind math), [`nspell`](https://www.npmjs.com/package/nspell) and [`dictionary-en`](https://www.npmjs.com/package/dictionary-en) for the portable spelling backend (pure JS, loaded lazily), and [`sharp`](https://www.npmjs.com/package/sharp) for local image preprocessing (an optional dependency, imported lazily and only when an image is attached). Multi-line input uses the in-repo frame-diffing editor (`src/editor/`), whose behaviour contract was originally defined by the vendored `@toiroakr/read-multiline` 0.4.1 (removed in 2026-08; the contract now lives in MEMORY.md §Command autocomplete).

## Architecture

The chat flow is built around four pieces:

- **`ChatState` (`src/chat-state.js`)** — the mutable session state (model, reasoning effort, temperature, top-p, budget, web search, messages, …) with pure transitions (`setTemperature`, `setTopP`, `applyModelSelection`, `toggleMarkdown`, …). `toFinalState()` produces the exact snapshot written to the session file; `resetForNewSession()` backs `/new`.
- **Command registry (`src/commands/chat/index.js`)** — the 27 slash commands live in a data-driven map of `/name → async (ctx) => outcome`; `CHAT_COMMANDS` is derived from the registry keys so the suggestion list and the loop can never drift. Handlers never call `process.exit` — they return `{ exit }` / `{ reset }` signals that the loop translates into exit codes, which keeps every handler unit-testable (`test/chat-commands.test.js`).
- **`runChatSession(ctx, deps)` (`src/chat.js`)** — the chat loop is dependency-injected: `deps = { readInput, renderer, stdout, exit, saveSession, savePrefs, onSignal, newSessionId }`, each defaulting to the real implementation, so production behavior is unchanged while the whole loop is drivable with fakes (`test/chat-loop.test.js`). Signal handling (idle/streaming SIGINT, `beforeExit`, `uncaughtException`) is registered through `onSignal` (`src/signals.js`); per-turn orchestration — stream rendering, abort, interrupt salvage, usage tracking — lives in `src/turn-runner.js` on a shared `sessionState` object.
- **`src/flags.js`** — CLI flag parsing helpers (`resolveTemperatureFlag`, `resolveTopPFlag`, `resolveWebResultsFlag`, `resolveWebSearchFlag`, `resolveReasoningFlag`, `resolveBudget`) shared by the chat loop, one-shot mode, and chat-start.

`src/reasoning.js` holds the model-capability helpers: `resolveEffortDefault` (forced flag → auto-reasoning → saved pref → model default, `'none'` normalized to `null`), `isWebSearchSupported` (provider-wide or per-model capability) and `endpointSupportsReasoning` (endpoint-level `supportedParameters`/`supportsReasoningEffort` probe).

## Provider contract

Adding a new provider requires implementing the following exports:

```js
export const meta = { name, apiKeyEnv, hasEndpoints }
export async function fetchModels(apiKey) → [{id, name, provider, contextLength, description, reasoning, pricing, capabilities}]
export async function fetchEndpoints(apiKey, modelId, allModels?) → [{name, providerName, tag, status, uptime30m, pricing, ...}]
export async function chatCompletion({apiKey, model, messages, onToken, provider, reasoningEffort, supportsReasoning, sessionId, temperature, topP, webSearch, webResults, signal}) → {content, reasoning, usage}
export function normalizePricing(rawPricing) → {prompt, completion}
export function handleHttpError(status, body) → throws ApiError
```

- `pricing` is `{ prompt, completion }` USD per token (or `null`) — use `normalizePricing` and the helpers in `src/ui/format.js` for display
- `chatCompletion` receives `signal` (AbortController) for SIGINT cancellation, `sessionId` for provider-side routing/caching (OpenRouter forwards it as `session_id` on unpinned requests; Venice maps it to `prompt_cache_key`), `temperature` and `topP` (both optional; when `undefined` the request omits `temperature` / `top_p` entirely so the provider applies its own default — send a number to override). `webSearch` is a mode string (`'off' | 'auto' | 'always'`); `webResults` is the OpenRouter result count — providers may ignore options they do not support (see the contract doc in `src/providers/index.js`). It also receives `onSources(sources)` and returns `sources: [{ title, url }]` (empty when web search is off or the provider returned no citations)
- HTTP calls should go through `fetchWithRetry` from `src/http.js`; errors must be thrown as `ApiError`, never `process.exit`

See `src/providers/openrouter.js` and `src/providers/venice.js` for reference implementations.

## Releasing

Every release is a bare-version tag (no `v` prefix) on `main`; the tag is the release trigger.

1. Land the change on `main` (branch → gates → merge) with `package.json` `version` bumped and the lockfile in sync (`npm install --package-lock-only`).
2. Run the gate locally — `npm test`, `npm run lint`, `npx --yes knip` — and check the CI matrix (macOS/Linux/Windows × Node 22/24).
3. Commit the bump with the changelog message, then `git tag 5.4.1`, `git push origin main`, `git push origin 5.4.1`.
4. `.github/workflows/publish.yml` takes it from there: lint → test → audit → a manifest-canonicality check → tag/version assertion → skip-if-already-published → `npm publish --access public --provenance --ignore-scripts` over OIDC, from a GitHub-hosted runner on Node 24 (`--ignore-scripts` skips the `prepublishOnly` suite the job already ran).

A successful publish is not yet an installable version: npm scans every new version at publish time (usually a few minutes, longer at peak, and a version can be held for manual review or blocked), so `npm view` can 404 for a while after the command succeeds. `dist-tag` works during that window; `deprecate` and `unpublish` do not.

Notes:

- The package is **`@vioni/communicator`**, public via `publishConfig.access`. A version can never be published twice; the workflow reports and skips when the tag's version already exists, so re-running a release is safe.
- The **first publish of a new package name cannot use OIDC** — npm requires the package to exist before a trusted publisher can be attached (npm/cli#8544). Bootstrap it locally with `npm publish --access public` (a 2FA prompt; `prepublishOnly` runs the suite first). The bootstrap publishes the version in `package.json` at that commit — currently **5.4.0**, whose git tag predates the npm metadata — so the workflow-driven releases begin with the *next* version bump (5.4.1 or a minor). Then attach the publisher on the package's npm settings page: GitHub Actions, user `genoma`, repository `Communicator`, workflow filename `publish.yml`, environment blank, and **tick `npm publish`** — configurations created after 2026-09-03 default to staged publishing only, which silently fails a direct publish.
- The manifest must be canonical **before** the tag: npm rewrites `package.json` at publish time and only warns, and it once removed a `./`-prefixed `bin` path entirely, which ships a package with no command. The workflow's `npm pkg fix` + `git diff --exit-code` step fails the release rather than publishing a corrected manifest; that same check is worth running by hand after editing `bin`, `repository` or `publishConfig`.
- The workflow's `repository.url` and the trusted-publisher repository must match case-sensitively; npm does not verify the configuration when it is saved, and the failure only surfaces at publish time as `ENEEDAUTH` or a 404.
- No npm token exists in the repo or in CI. If a publish ever fails with a provenance error, the reported workaround is an explicit `--provenance` flag (already passed) or a newer npm; the workflow pins Node 24 because it bundles npm 11.19, above the OIDC (11.5.1) and `npm trust` (11.15.0) floors and above the npm 10 that Node 22 ships.

## Documentation maintenance

`test/docs-consistency.test.js` mechanically verifies that the user-facing docs (`README.md`, `docs/`) stay in line with the code: CLI flags and slash commands match their registries, env vars / data paths / Node version / key defaults are mentioned, example flags exist, every markdown link resolves (repo-relative links, plus absolute links back into this repository — anchors included, so the README's npm-page links cannot rot), and the install instructions name the published package. It runs as part of `npm test` — keep it green whenever a flag, command, default, path, or doc page changes.

The check cannot verify behavioral prose. When touching related code, re-verify these documented behaviors (last verified as of v3.30.0):

- CTX indicator: hidden below 5% occupancy, yellow at ≥80%, red at ≥95%, peak never decreases (`src/tracker.js`).
- Budget: warning row at ≥80% used, turns refused at ≥100% (`src/tracker.js`, `src/commands/chat/index.js`).
- Smooth streaming: default on in TTY sessions, ~40 chars per 20 ms tick, presets slow/normal/fast = 500/2000/8000 chars/s, piped output never paced (`src/constants.js`).
- Config, session and sidecar files are written atomically (temp + rename) and crash-safe: a killed process never leaves a truncated JSON file behind (`src/fs-utils.js`).
- E2EE streams fail closed: an unencrypted chunk in an `--e2ee` session aborts the stream instead of rendering (`src/sse-parser.js`).
- One-shot mode: piped stdin capped at 10 MB; exit codes 0 / 1 / 130 (`src/cli-utils.js`, `src/cli-main.js`, `src/turn-runner.js`).
- Attachment limits: images 20 MB, pdf/office/text 25 MB (raw file size), inline text 256 KB warning; attached png/jpg/jpeg/webp images are downscaled to a 2048 px long edge with EXIF orientation baked and metadata stripped when sharp is available, and avif/tiff/heic/heif are converted to jpeg/png (heic/heif through the macOS `sips` converter, rejected elsewhere); office formats are Venice-only.
- Clipboard probe order: macOS `pbcopy`, Windows `clip`, Linux `wl-copy` → `xclip` → `xsel`, with a 10 s timeout per tool. Clipboard image reads (`/paste`) probe macOS `osascript` («class PNGf», then the «class TIFF» fallback), Windows PowerShell 5.1 `Get-Clipboard -Format Image`, Linux `wl-paste --type image/png` → `xclip -selection clipboard -t image/png -o`, with the same per-tool timeout; `COMMUNICATOR_CLIPBOARD_TEST=1` opts `test/clipboard-real.test.js` into the real round trip, which clobbers the pasteboard (CI sets it on the macOS leg only) (`src/clipboard.js`).
- Reasoning effort: `EFFORT_LABELS` mapping; `none` disables reasoning; Venice uses `reasoning_effort`, OpenRouter its native format.
- Web search: modes `off`/`auto`/`always` (`on` maps to `auto`); OpenRouter `auto` = server tool with a total result cap, `always` = legacy plugin; Venice maps to `enable_web_search`; the chat banner shows a `[web: <mode>]` badge.
- ZDR: OpenRouter-only, filters pickers to ZDR-capable endpoints, runtime error kept as a safety net, not persisted.
- Venice watermark (image-session `/watermark off` hides it → `hideWatermark: true`) and safe-mode are global preferences.
- Session file format: `providerName`/`providerType`/`usage`/`sources` fields, `ref://attachments/` blobs, the `.index.json` sidecar rebuild, title from the first user message truncated to 50 chars.
- Command autocomplete: hints appear on `/`, Tab fills the first match, Shift+Tab the last, Enter always submits. A dictionary completion hint (macOS only) is accepted with Tab only when no `/`-command list is open; Ctrl+. lists spelling replacements, and autocorrect (off by default) fixes a misspelled word when the character that closes it is typed.
