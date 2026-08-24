# Communicator — Implementation Notes

> Committed, single detailed implementation doc (English). Update policy and the store roles live in `AGENTS.md` §Documentation & memory. This file is the single source of truth for implementation facts.

## Architecture

- `index.js` — CLI entry, commander flag parsing, delegates to `runCli` in `src/cli-main.js`.
- `src/cli-main.js` — `runCli` error handling: `ApiError` → `Error: …`; `CliError` → message + `exitCode`; `ExitPromptError` → `Aborted.` exit 0; others rethrown; full stack under `COMMUNICATOR_DEBUG=1`. Dispatches list/export/delete/one-shot/chat-start and standalone config setters. Command modules are lazily imported at dispatch points. The config-setter gate excludes `--resume` so session flags with `--resume` reach resume instead of persisting defaults. Numeric session flags are validated up front. Non-TTY chat-path check stays in `main()`.
- `src/cli-validation.js` — pure flag-combination validation (`validateCliFlags`) returning all violations; flag-group predicates (`hasAttachments`, `isInteractiveFlag`, `isExitMode`, `isSessionOnly`, `isConfigSetter`). `--delete-all-sessions` has dedicated rules/messages and remains legal with piped stdin. Provider gates: `--e2ee` requires Venice, `--zdr` requires OpenRouter. Pure config setters include `--aspect-ratio`, `--image-format`, `--no-watermark`, `--no-safe-mode`.
- `src/chat.js` — `runChatSession(ctx, deps)` dependency-injected chat loop (deps: `readInput`, `renderer`, `stdout`, `exit`, `saveSession`, `savePrefs`, `onSignal`, `newSessionId`; `startChat()` is the thin wrapper). Owns banner, read/command loop, save-on-exit, SIGINT/`beforeExit`/`uncaughtException`. Exit codes: idle SIGINT → 130, streaming abort → partial save + 130, uncaught → 1. Commands split on first newline; remaining lines become the user message. Picker `ExitPromptError` prints `Aborted.` and returns to prompt; other handler throws print `commandErrorLine` and continue. Empty sessions remove their placeholder claim. Pref saves use `syncPreferenceUpdates` so exit writes cannot clobber mid-session changes. TTY resize passes `onResizeRepaint` to `readInput`: the shared `renderAboveEditor` re-renders banner + `renderHistory(messages)`, then the editor redraws its block; resize is debounced and synchronized (see Command autocomplete).
- `src/input.js` — `readInput({ commands, onResizeRepaint })` wraps the vendored editor; `onResizeRepaint` is forwarded as the editor's resize hook (preferred over the DSR fallback).
- `src/status-line.js` — single home for session snapshot lines: `buildStatusBadges`, `buildStatusLine`, `connectedBanner`, `wrapStatusLine`, plus image twin `buildImageStatusLine`. On TTY, prefixes/badge brackets dimmed; pipes get plain canonical lines.
- `src/turn-runner.js` — `createTurnRunner` + `createSessionState`: per-turn orchestration (stream render, loader, abort, partial salvage, usage/budget tracking). Runner and SIGINT handler share `sessionState`; `/new` resets tracker/budgetWarned. Resolves model-produced artifacts post-stream.
- `src/artifacts.js` — shared artifact handling: `extractMarkdownImageUrls`, `produceParts` (parallel downloads), `resolveArtifacts` (single shared gate), `buildPartsContent`, `printArtifacts`, `printArtifactsSummary`, `printPostStreamMetrics`.
- `src/commands/chat/index.js` — slash command registry (19 commands, no `/exit` alias), `CHAT_COMMANDS`, `budgetGuard`, `showStatus`. Handlers return `{ exit }` / `{ reset }` / `{ resetBudgetWarning }` signals; never `process.exit`. Picker deps injectable for tests.
- `src/chat-state.js` — `ChatState`: 30-field session state plus pure transitions; `toFinalState(providerType)` returns the exact 22-field session snapshot (omits `pendingAttachments`, `modelReasoning`, `markdown`, `smoothStreaming`, `smoothSpeed`, `compactThinking`); `reasoningMandatory` rides through for OpenRouter/Venice.
- `src/attachments.js` — classification, loading, capability gates, content/part helpers, `partUrl`/`partLabel`, `formatBytes`.
- `src/session-setup.js` — shared session setup: `resolveSessionFlags`, `attachGateOptions`, `buildSessionContext`, `persistSession` (save + merged prefs).
- `src/rpg.js` — RPG mode provisioning/assembly (see RPG mode).
- `src/flags.js` — flag resolvers and webs/search/reasoning/smooth/budget validation; `prompts.js` keeps pickers only.
- `src/reasoning.js` — `resolveEffortDefault`, `isWebSearchSupported`.
- `src/commands/one-shot.js` — non-interactive one-shot.
- `src/commands/export-cmd.js`, `delete-cmd.js`, `delete-all-cmd.js` — CLI handlers.
- `src/clipboard.js` — probe `pbcopy`/`clip`/`wl-copy`/`xclip`/`xsel`; testable platform override.
- `src/ui/` — style, format, io, stream, markdown, md-it.
- `src/config.js` — API key lookup, preferences persistence, `savePrefsBestEffort` (never throws), `applyPreferenceUpdates`/`syncPreferenceUpdates` (single merge helpers), `getImageDefaults`/`mergeImageDefaults`, corrupt-prefs quarantine.
- `src/model-selection.js` — interactive/non-interactive selection; `capabilityFlags`; image selection helpers.
- `src/providers/` — OpenRouter/Venice chatCompletion contract, image APIs, scrape.
- `src/http.js` — `fetchWithTimeout`/`fetchWithRetry` (2 retries; 30s), SSRF-pinned transport (`resolveSafeUrl`, `pinnedFetch`, `fetchWithRedirects`, `readBodyWithDeadline`).
- `src/errors.js` — `ApiError`, `TimeoutError`, `CliError`, `formatError`.
- `src/sse-parser.js` — SSE parsing, reasoning/content transitions, usage, parts, idle timeout, skipped-chunk counter, E2EE decrypt hook, prompt-cache handling.
- `src/tracker.js` — usage/cost accumulator, budget helpers, CTX/budget line helpers, scrape cost.
- `src/session-sidecar.js`, `src/sessions.js`, `src/attachment-store.js` — session storage/index/blob layer (see Session persistence).
- `src/sessions.js` — session save/load/list, sidecar, ids/generation, title; `buildSessionPayload` (single source for the 24-field save shape), `deleteSession`/`deleteAllSessions`, interactive resolve helpers.
- `src/session-picker.js` — `selectSession`/`selectSessions`.

## Text vs Image command separation

- Text chat owns text/vision commands: `/attach`, `/reasoning`, `/web-search`, etc. No image-specific commands.
- Image REPL owns `/resolution`, `/quality`, `/format`, `/aspect`, `/variants`, `/seed`, `/watermark` (Venice only), each gated by `model.constraints`; `/help`, `/status`, `/model`, `/quit` always available.
- `/model` can hand off between image and text sessions; image command visibility disappears accordingly.

## Temperature semantics

- Precedence: `--temperature` > `prefs.temperature[modelId]` > unset. Unset omits the param so the provider default applies; no client default.
- `default` maps to `null` sentinel, clears the persisted key, and omits the param.
- Valid range 0–2; invalid values throw/exit 1.
- Providers set `body.temperature` only when defined.
- `/temp` sets state + pref; bare shows current; `/model` switch resets to new model pref/unset.
- `persistSessionEnd` must spread `...prefs` before merging (do not regress prefs wipe).

## Top-p semantics

- Precedence: `--top-p` > `prefs.topP[modelId]` > unset. Unset omits param.
- Valid 0–1; `default` clears persisted key.
- Status line always shows `[top-p: …]`/`[temp: …]` with `default` when unset.
- Legacy files without topP resume as unset.

## Web search semantics

- Pref `webSearch` per model: `off`/`auto`/`always`; `true`/`on` normalize to `auto`.
- Precedence: flag > pref > off; `--web-results` implies `auto`.
- OpenRouter: `auto` uses server tool with `max_results` + `max_total_results`; `always` uses legacy `plugins: [{ id: 'web', max_results }]`; `off` sends neither. Default N = 10, cap 20 (OpenRouter allows max_results 1–25, 1–20 on the Perplexity engine; 20 also matches Venice's standalone search limit).
- Venice: `venice_parameters.enable_web_search` (`auto`/`on`/`off`) + `enable_web_citations`; no result-count knob.
- Sources are persisted on assistant messages when non-empty and replayed/exported; cite markers `^n^`.
- Gating via `webSearchGate` in the command layer: `webSearchSupported` from provider meta or model capabilities; unsupported only blocks `auto`/`always`; resume does not re-gate.
- `/web-results` is session-scoped; `/model` refreshes from pref and forces off if unsupported.

## Web scraping semantics (Venice)

- Venice-only `POST /api/v1/augment/scrape`, flat `$0.01`, page capped at 200k chars.
- Entry points: `--scrape <url>` and `/scrape <url>`; both inject a user context turn `Scraped from <url>:\n\n<content>`.
- Session-scoped counter `ChatState.scrapes` persists through resume and feeds the tracker exactly once at startup.
- Interactive `/scrape` also bumps `state.scrapes` and adds `SCRAPE_COST_USD`.
- Conflicts: E2EE, list/export/delete/resume, image; not a config-setter flag.

## Budget semantics

- `budgetStatus(cost, budget)` → `{ pct, remaining }`; warning at ≥80% once; refusal pre-turn when `cost >= budget`.
- Per-session, stored/restored, cleared by `/new`.
- `/budget <usd>` sets/resets warning; bare shows status.
- One-shot does not pre-check budget.

## Zero data retention (ZDR)

- `--zdr` is OpenRouter-only; filters pickers to ZDR-capable endpoints; runtime error remains as safety net.
- ZDR index is cached 5 min; `/model` re-gates endpoint selection in ZDR sessions.
- Venice exposes per-model privacy from `model_spec.privacy`; no OpenRouter per-model privacy field.

## End-to-end encryption (E2EE, Venice)

- Venice-only. Client crypto in `src/e2ee.js`: ECDH secp256k1 + HKDF-SHA256 + AES-256-GCM; hex wire format (ephemeral pubkey ‖ nonce ‖ ciphertext+tag).
- Session setup fetches/verifies TEE attestation; failure aborts (never falls back to plaintext).
- `ChatState` stores `e2ee` persisted marker + in-memory `e2eeContext`; only the boolean is serialized.
- Threading: flag → validation → session setup → selectors → chat/one-shot → provider.
- Model selection filters to `supportsE2EE`; image models not shown under e2ee.
- Venice `chatCompletion` encrypts user/system messages; adds TEE headers; disables web search/prompt cache.
- `parseSSEStream` decrypt hook; E2EE fails closed on unencrypted chunks. Interrupted-stream salvage also decrypts.
- Trust model is server-reported attestation; client does not independently verify quotes.
- REPL hides/refuses attachments and web search; `/model` re-fetches attestation before switching.
- Resume strictness: cannot resume an e2ee session without `--e2ee` or vice versa.

## Markdown rendering

- markdown-it based, `html: false`, `linkify: true`; setext headings disabled.
- Line-buffered renderer with incremental re-parse after block boundaries; tables buffered until close.
- Streaming perf: incremental tail parse, fence-aware scanning, 64-line tail window, O(n) token splitting.
- Flush per turn; `/markdown` toggles at runtime.
- ANSI hyperlinks via sanitized `hyperlink` (http(s) only), citations `^n^` only when sources exist.
- Reasoning tokens never restyled; non-TTY emits no ANSI.
- Export writes raw markdown outside the ANSI renderer.

## Smooth streaming semantics

- Pacing in `src/ui/stream.js`: mutable `smoothCharsPerTick`/`smoothTickMs` on renderer; speed changes apply next tick.
- Pref `smoothSpeed` stores canonical cps: slow 500, normal 2000, fast 8000; default normal.
- `/smooth on|off|<speed>` updates state + renderer + prefs; invalid values error and leave state unchanged.
- `toFinalState` does not include smooth speed; config setters and `/smooth` persist it.
- Piped output never paces.

## Compact thinking semantics

- Purpose: replace the streamed reasoning body on TTY with a live `Thinking · <count>` spinner meter; default off (full text, byte-identical to pre-feature output).
- Meter = `createThinkingMeter` in `src/ui/loader.js` (own grace/tick; `update(chars)` bumped per reasoning chunk, painted on the next tick; `stop({done:true})` always writes `✓ Thinking · <count>` even inside the grace window so the checkpoint is deterministic). `stop({done:true})` also resets the shown flag so a following turn's `start()` restarts the grace window and tick timer (the `/retry` path reuses the same meter instance — without the reset the second turn drew a frozen `Thinking · 0` and never repainted).
- Renderer contract (`src/ui/stream.js`, `createStreamRenderer({..., compactThinking})`): compact reasoning bypasses the smooth queue and writes nothing; `start_reasoning` starts the meter, `reasoning` counts sanitized chars, `end_reasoning` stops with the checkpoint + `\n❯ Answer\n\n`. `flush()`/`flush({sync:true})` stop the meter (interrupt/error paths never leave a dangling line). Mutable `render.compactThinking` (like `render.smooth`/`render.markdown`); toggles apply between turns.
- History replay (`renderHistory`, option `compactThinking`) prints `✓ Thinking · <count>\n\n❯ Answer\n\n` from the stored reasoning length; full reasoning text stays in the session file and exports.
- Turn-runner handoff: in compact TTY turns, `start_reasoning` stops the waiting loader without its checkmark (meter owns the line), `reasoning` tokens no longer stop it, `content` still `stop({done:true})`.
- Enabling: flag `--compact-thinking` (bare use saves the pref via config-set, like `--no-smooth-streaming`), pref `compactThinking`, `/compact-thinking on|off` (updates state + `render.compactThinking` + pref; bare shows status).
- Precedence: `opts.compactThinking === true || prefs.compactThinking === true` (`resolveSessionFlags`); `applyPreferenceUpdates` accepts the key.
- TTY-only; `chat.js` and one-shot pass `compactThinking: <resolved> && tty`. Badge `[compact-thinking]` (status line) only when on. Piped stdout unaffected. Not persisted in `toFinalState`.

## Attachments & vision semantics

- Wire format: OpenAI-style parts (`image_url`, `file`, `text`), identical for both providers.
- Capability flags from model selection; `undefined` = unknown = allow; command layer gates.
- Interactive `/attach` queues files; bare lists; `/attachments clear`; next message flushes queue; `/new` clears.
- One-shot `--attach` requires prompt/piped stdin; conflicts with list/export/delete/bare config.
- Size limits: images 20 MB, pdf/office/text-file 25 MB, inline text warning at 256 KB (enforced on encoded size).
- Content helpers `contentText`, `messageText`, `contentAttachments` used for titles, copy, history, export.

## Session persistence

- Save at `/quit`, `/new`, `/model`, SIGINT (partial), `beforeExit`/`uncaughtException` best-effort.
- RPG history is separate dir-local `history.json`.
- Attachment blobs stored under `~/.communicator/sessions/attachments/<sessionId>/<sha256>.<ext>` with `ref://` sentinels; externalize before JSON; hydrate on load; delete removes blob dir.
- Sidecar `.index.json` maps session metadata; rebuilt if missing/stale; system-only sessions filtered.
- Session ids `YYYY-MM-DDTHH-MM-SS`; prefix matching works.
- Title from first user message, truncated to 50 chars.
- `loadSession` error contract: missing/corrupt files raise `CliError`; other read errors rethrown.


## Error handling contract

- Providers throw `ApiError`: 401 invalid key (not retryable), 429/5xx/network retried, timeouts retried.
- Transient chat errors pop the user message so it is not re-sent; permanent errors keep it.
- Session/prefs saves are non-fatal; single warning per save path.
- `ExitPromptError` from pickers must propagate to the cli-main “Aborted.” handler.
- `writeFileAtomic` used for config/session/sidecar; private modes 0600/0700.

## Display consistency contract

Cross-path invariants pinned by `test/ui-consistency.test.js`. Every change must update all call sites and this section.

- **Session banner**: `\nConnected to <segments joined '  '>\n[<hints joined '  |  '>\n]`; TTY dims keys/brackets; wraps greedily, badges atomic. Banner and `/status` use same `buildStatusLine` segments. Image banner uses `buildImageStatusLine`.
- **Turn markers**: `❯ Thinking\n<reasoning>\n\n❯ Answer\n\n`; live and history replay identical. Compact mode replaces the body with the meter checkpoint `✓ Thinking · <count>\n\n❯ Answer\n\n` (count = ANSI-stripped reasoning chars via `formatCompactCount`); live and history replay identical.
- **Attachment/artifact lines**: shared `attachmentLine(word, label, { meta, note, link })`; call sites differ only by label/note.
- **Sources**: `printSources` leading newline, dim `[i]` + OSC 8 link; citations same `[n]`.
- **Malformed-chunk notice**: dim, TTY-only.
- **Per-turn metrics**: `UsageTracker.printTurn` (sep + Tokens/Cache/Cost + CTX/budget). Resume uses `tracker.summary()`.
- **Money tiers**: `formatCost` for session/turn (three display forms), `formatUsd` image-only, scrape `$0.01`.
- **Budget phrasing**: `budgetStatusLine` vs `budgetLine` not interchangeable.
- **Piped one-shot**: stdout only answer; stderr for artifacts/notices; banner/sources/metrics suppressed.
- **Channels**: errors/warnings/notes via console methods; image blur warning to stderr.

## Reasoning effort semantics

- `undefined` = auto/default; `null` = disabled (`none`). OpenRouter sends `reasoning: { effort: "none" }`; mandatory-reasoning models omit the field entirely; Venice sends `reasoning_effort: "none"`.
- Interactive order model → provider → effort with back; `--reasoning-effort` skips picker; `/reasoning` no back.
- Model data normalized to `{ supported, supportsEffort, supported_efforts, default_effort, mandatory, default_enabled }`; absent `supported_efforts` → auto-only.
- Model caches TTL 5 min; ZDR index only consulted when active.

## Providers / SSE parsing

- Reasoning fields: `delta.reasoning_content` (OpenAI-style) or `delta.reasoning` (DeepSeek-family).
- SSE parser handles multi-line data, malformed chunks, idle timeout, partial tokens, usage, non-text parts, E2EE decrypt.

## Command autocomplete

- Vendored `@toiroakr/read-multiline` (v0.4.1) in `src/vendor/read-multiline/`: `index.js` (prompt lifecycle, raw mode, kitty/bracketed-paste enable, submit/cancel — Ctrl+C cancels the prompt; Ctrl+D deliberately unbound: EOF in shells vs forward-delete in emacs-style apps, and it would exit the chat), `input.js` (keymap + incremental input reassembly: escape sequences and bracketed-paste markers split at arbitrary chunk boundaries are buffered until complete — 50 ms lone-Escape flush; 1.5 s paste watchdog force-ends a paste whose end marker never arrives), `editing.js` (edits/undo/redo/paste/suggestion session), `navigation.js`, `rendering.js` (viewport guard, paste rewind, resize paths with synchronized output), `footer.js` (kitty detection + help footer), `history.js`, `style.js`, `chars.js`. Patches: suggest option, tall-editor submit/cancel guard, bulk bracketed paste, Unicode line/paragraph separator normalization (paste and character input), chunk-split input reassembly + paste watchdog, paste-ghost rewind, resize rebuild (`onResizeRepaint` hook / DSR fallback, 80 ms debounce, synchronized output).
- Suggestions appear for single-line `/`-prefixed non-exact prefixes; Tab/Shift+Tab cycle; Escape dismisses; kitty protocol key bindings supported.
- Command list derived from `CHAT_COMMANDS`; pure `matchCommands` in `src/suggest.js`.

## Known quirks

- Editor raw mode intercepts Ctrl+C at prompt; during streaming Ctrl+C is real SIGINT.
- Piped stdin reads to EOF as one message; piped flows exit explicitly.

## Project strategy

- **Feature freeze** (Aug 2026, after 3.38.2): no new features. Only bug fixes with regression tests; refactors stay maintenance-shaped (no new flags/options).
- The vendored editor (Command autocomplete) is the live implementation. The in-repo buffer-diff editor rewrite (`src/editor/`, branch `feat/buffer-diff-editor-wip`) was abandoned in Aug 2026: branch deleted, design not merged. If the desync bug class resurfaces, revisit the buffer-diff approach rather than patching further.
- No feature branch exists for RPG mode: it is fully merged into `main` (commits in history, `feat/rpg-mode-wip` deleted).
- Not scheduled: rewriting the chat/stream renderer itself in Rust or another language.

## Historical audit notes (condensed)

- Current hardening that must not regress: SSRF-pinned downloads with per-hop validation; `ref://` and session-id validation; ANSI output sanitization; exported markdown scheme neutralization; private file modes; web-results cap; SSE error events; atomic writes; bounded stream bodies; E2EE fail-closed; SIGTERM like SIGINT; empty session claim cleanup; `/retry` does not replay stale prompts; multi-line SSE data; quoted paths; non-fatal prefs saves; clipboard EPIPE; pure config setters on piped stdin; variants gated by `maxN`; lazy chat-start import; image/model fetch caching; coverage/perf consolidations (incremental markdown, SSE arrays, import cycle fixes, duplicate constant cleanup).

## Tests, CI and platform notes

- `npm test` = `node --test --experimental-test-module-mocks`; engines `>=22.3`; keep `namedExports` for Node 22; migrate to `exports` only when bumping.
- ESLint flat config: no semicolons, single quotes, deliberate ANSI regex file-disables, `_`-prefixed allowed.
- Tests needing temp home use `mock.module('node:os')`, dynamic import, never static import before mock; never swallow child stdout.
- CI: macOS/Ubuntu/Windows Node 22, `npm ci`, lint, test, audit.
- `test/docs-consistency.test.js` enforces user-facing docs/flags/commands consistency; MEMORY.md field-count strings are also checked locally.
