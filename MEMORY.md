# Communicator — Implementation Notes

> Committed, single detailed implementation doc (English). Update policy and the store roles live in `AGENTS.md` §Documentation & memory. This file is the single source of truth for implementation facts.

## Architecture

- `index.js` — CLI entry, commander flag parsing, delegates to `runCli` in `src/cli-main.js`.
- `src/cli-main.js` — `runCli` error handling: `ApiError` → `Error: …`; `CliError` → message + `exitCode`; `ExitPromptError` → `Aborted.` exit 0; others rethrown; full stack under `COMMUNICATOR_DEBUG=1`. Dispatches list/export/delete/one-shot/chat-start and standalone config setters. Command modules are lazily imported at dispatch points. The config-setter gate excludes `--resume` so session flags with `--resume` reach resume instead of persisting defaults. Numeric session flags are validated up front. Non-TTY chat-path check stays in `main()`.
- `src/cli-validation.js` — pure flag-combination validation (`validateCliFlags`) returning all violations; flag-group predicates (`hasAttachments`, `isInteractiveFlag`, `isExitMode`, `isSessionOnly`, `isConfigSetter`). `--delete-all-sessions` has dedicated rules/messages and remains legal with piped stdin. Provider gates: `--e2ee` requires Venice, `--zdr` requires OpenRouter. Pure config setters include `--aspect-ratio`, `--image-format`, `--no-watermark`, `--no-safe-mode`.
- `src/chat.js` — `runChatSession(ctx, deps)` dependency-injected chat loop (deps: `readInput`, `renderer`, `stdout`, `exit`, `saveSession`, `savePrefs`, `onSignal`, `newSessionId`; `startChat()` is the thin wrapper). Owns banner, read/command loop, save-on-exit, SIGINT/`beforeExit`/`uncaughtException`. Exit codes: idle SIGINT → 130, streaming abort → partial save + 130, uncaught → 1. Commands split on first newline; remaining lines become the user message. Command detection trims the input, but the message body (and the trailing lines of a command) keep the raw submitted whitespace — intentional indentation survives; the trailing lines start AFTER the command line in the raw input, so leading blank lines before a command are never re-sent as a message. Picker `ExitPromptError` prints `Aborted.` and returns to prompt; other handler throws print `commandErrorLine` and continue. Empty sessions remove their placeholder claim. Pref saves use `syncPreferenceUpdates` so exit writes cannot clobber mid-session changes. TTY resize passes `onResizeRepaint` to `readInput`: the shared `renderAboveEditor` rebuilds the full app-owned frame — banner, the captured `Previous session:` summary (`resumeSummary`), the chat-loop separators (one before the transcript, one before the editor when the transcript or a footer is present), `renderHistory(messages)` and the last turn-metrics footer — then the editor redraws its block; resize is debounced and synchronized (see Command autocomplete). The launch frame uses the same order (banner, summary, separator, transcript; the loop's own separator is the closing one), so the first `❯ You` gets the same single blank row above it and a resize never changes the layout. The footer is reproduced from `sessionState.lastTurnMetrics` (set by `src/turn-runner.js` after every turn with usage: frozen `{ usage, pricing, contextLength, budgetNote }`, cleared by `/new` via the `{ reset }` outcome, initialized `null` in `createSessionState`), re-printed with `tracker.printTurn` so the Tokens/Cost block is byte-identical to the live one. `chatCtx.onResizeRepaint` exposes the same hook to editor-opening command handlers. `/retry` and `/edit` rebuild the screen on TTY via `redrawForRetry` (in `src/commands/chat/index.js`): wipe (`\x1b[2J\x1b[3J\x1b[H`) then the same `onResizeRepaint` hook called with `{ turnFooter: false }` — the popped/replaced answer's metrics must not sit between the transcript and the replacement stream, which prints its own footer, and the frame's closing separator is skipped with it (nothing is allowed between the transcript and the stream; only the leading separator stays); the transcript is rebuilt flush-ended (`renderHistory` `tailBlank: false`) so the rerun's own leading `\n\n` leaves exactly one blank row above the streamed marker, never a doubled gap. After the rerun a second wipe happens only when the turn appended no replacement: `runTurn` resolves `true` iff an assistant message was appended (success with content), `false` on failure/empty — a successful retry keeps the live-streamed answer and its turn-metrics footer (`printTurn` Tokens/Cost block) on screen. History replay keeps the live look of a reasoning-less turn: the runner stores the resolved loader checkpoint label on the assistant message as `waitLine` (tty only: `Waiting for response`, or `Searching the web` when web search is forced `always`; never on reasoning turns, which own the row via the thinking marker/compact meter checkpoint), and `renderHistory` (src/ui/stream.js) replays it as the `✓ <label>` line directly above the answer — so a resize rebuild or a resumed session shows the same checkpoint the live stream did.
- `src/input.js` — `readInput({ commands, onResizeRepaint, initialValue })` wraps `src/editor/index.js` (`readEditor`); `initialValue` pre-fills the editor buffer (used by `/edit`) and is forwarded as the editor OPTION while `readEditor`'s first argument stays the header prompt (empty for the chat prompt); `onResizeRepaint` is forwarded as the editor's resize hook (preferred over the DSR fallback).
- `src/editor/` — the frame-diffing editor: explicit grid + shadow-frame diff painting. `model.js` is a pure state machine (buffer/cursor/edits/undo/redo/history/suggest-session, no I/O); `layout.js` wraps logical lines into an explicit display-width grid — the terminal's soft-wrap never engages inside the block, so no cursor soft-wrap math exists (the vendored editor's whole desync bug class). Wrapping is word-aware: `wrapSegments` folds at the last space before the width (the fold space is dropped), and only a word longer than the full segment width is hard-cut (at the exact width); a space that would cross the width is itself the fold point — dropped and reset, so a grid row NEVER exceeds the terminal width (an over-wide row would soft-wrap and desync the grid↔screen 1:1 mapping, leaving ghost duplicates); the grid's cursor mapping works entirely in display space (segment starts in code units only decide WHICH segment the cursor is in; display offsets are cumulative segment widths, so wide chars never match a code-unit offset; a dropped fold space is invisible and is subtracted once the cursor has crossed it), so positions in a dropped fold space park at the end of the preceding row and the cursor never drifts across a fold; `paint.js` diffs the shadow grid against the target and rewrites only changed rows (in-place `paintDiff`, bottom-anchored `paintForward` for tall/paste/unknown states, `paintAbsolute` for the DSR path, `paintSequential` initial + resize-with-hook rebuild, `paintRefresh` Ctrl+L/DSR fallback); `keys.js` is the input consumer (paste markers, chunk-split reassembly, DSR routing; algorithm inherited from the removed vendored package; a held escape tail directly followed by a paste start marker is stripped — the marker cannot be the tail's continuation — and a lone ESC is dispatched as a key); `footer.js`/`history.js`/`style.js`/`chars.js` are ports of the vendored helper modules (own kitty-detection cache: a negative result expires when the editor session closes, so a slow first detection cannot hide Shift/Ctrl/Cmd+Enter from the footer for the whole process). Every model edit triggers one repaint; paste commits repaint forward when the cursor is on row 0 or the block is taller than the viewport, top-anchored full rewrite (`paintRefresh` from the shadow's cursor row) otherwise; submit renders unbatched (`paintSubmit`, vendored parity). The footer renders the active suggestion session when one is open (8-match window centred on the selection, `›`/dim markers, `… N more` trailer) and falls back to the help footer; Escape dismisses the session and keeps it closed until the next content edit (`dismissUntilEdit` — the restored prefix would otherwise re-open the session on the next repaint), while Tab/Shift+Tab cycle only while a session is open. Submit renders the block WITHOUT the footer/status rows (`noFooter` grid): the vendored submit-render erased the area below the prompt, so a stale suggestion list (or help footer) must never linger above the command/picker output that prints after submit. Ctrl+D is deliberately unbound (it would exit the chat) and is not advertised in the help footer; real stdin EOF (pty close/pipe end) tears the editor down like an EOF cancel — raw mode, bracketed paste and the kitty protocol are all disabled, listeners/timers are cleared, and the read resolves `{ kind: 'eof' }`. Undo groups: consecutive character insertions form one undo step; every cursor move / word jump / line-navigation / kill / history recall breaks the group, and the undo snapshot holds the cursor position of the group start. Word jumps step by whole code points (never into a surrogate pair). A paste past `maxLines` stops and reports `Maximum N lines` (the overflow is not merged into the last line). Unsupported vendored options (validate/transform/highlight/inlinePrompt) throw loudly — no in-repo callers use them. Right-margin rule: a row that fills the terminal exactly is never followed by an erase-to-EOL/ED — the terminal parks the cursor on the last cell after the final character (pending wrap), and erase-to-EOL includes that cell, so it would delete the row's last letter; `rowBody` skips the trailing erase for rows whose display width equals the grid width, and all block-tail erases (`\x1b[J`) run at the head (before the rows are drawn) in `paintSequential`/`paintDiff`/`paintAbsolute` (`paintRefresh`/`paintSubmit`/`paintForward` already erase first). Pinned by the margin tests in `test/editor-grid.test.js` against the xterm-authentic test terminal (pending-wrap + right-margin cursor parking + clamping). Regression coverage: `test/editor-grid.test.js` (screen-level, in-memory ANSI terminal with exact cursor/erase parsing) and `test/editor-parity.test.js` (byte-level behaviour contract carried over from the vendored editor).
- `src/status-line.js` — single home for session snapshot lines: `buildStatusBadges`, `buildStatusLine`, `connectedBanner`, `wrapStatusLine`, plus image twin `buildImageStatusLine`. On TTY, prefixes/badge brackets dimmed; pipes get plain canonical lines.
- `src/turn-runner.js` — `createTurnRunner` + `createSessionState`: per-turn orchestration (stream render, loader, abort, partial salvage, usage/budget tracking). Runner and SIGINT handler share `sessionState`; `/new` resets tracker/budgetWarned. Resolves model-produced artifacts post-stream. Stamps the resolved loader label onto reasoning-less completed messages as `waitLine` (tty only) — the `renderHistory` replay contract, see the `src/chat.js` entry.
- `src/artifacts.js` — shared artifact handling: `extractMarkdownImageUrls`, `produceParts` (parallel downloads), `resolveArtifacts` (single shared gate), `buildPartsContent`, `printArtifacts`, `printArtifactsSummary`, `printPostStreamMetrics`.
- `src/commands/chat/index.js` — slash command registry (20 commands, no `/exit` alias), `CHAT_COMMANDS`, `budgetGuard`, `showStatus`. Handlers return `{ exit }` / `{ reset }` / `{ resetBudgetWarning }` signals; never `process.exit`. Picker deps injectable for tests.
- `src/chat-state.js` — `ChatState`: 30-field session state plus pure transitions; `toFinalState(providerType)` returns the exact 23-field session snapshot (omits `pendingAttachments`, `modelReasoning`, `markdown`, `smoothStreaming`, `smoothSpeed`, `compactThinking`); `reasoningMandatory` rides through for OpenRouter/Venice.
- `src/attachments.js` — classification, loading, capability gates, content/part helpers, `partUrl`/`partLabel`, `formatBytes`.
- `src/session-setup.js` — shared session setup: `resolveSessionFlags`, `attachGateOptions`, `buildSessionContext`, `persistSession` (save + merged prefs).
- `src/rpg.js` — RPG mode provisioning/assembly (see RPG mode).
- `src/flags.js` — flag resolvers and webs/search/reasoning/smooth/budget validation; `prompts.js` keeps pickers only.
- `src/reasoning.js` — `resolveEffortDefault`, `isWebSearchSupported`.
- `src/commands/one-shot.js` — non-interactive one-shot.
- `src/commands/export-cmd.js`, `delete-cmd.js`, `delete-all-cmd.js` — CLI handlers.
- `src/clipboard.js` — probe `pbcopy`/`clip`/`wl-copy`/`xclip`/`xsel`; testable platform override.
- `src/ui/` — style, format, io, stream, markdown, md-it, wrap.
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
- `sanitizeAnsi` (`src/ui/hyperlink.js`) strips CSI/OSC/charset-select/stray ESC, bare C0 controls except LF/tab (BEL, CR, ...), DEL and the C1 range (U+0080–U+009F, which terminals interpret as 8-bit CSI/OSC); CRLF collapses to LF. Applied to streamed content/reasoning, history replay, sources, attachment labels, and — via `formatError`/`commandErrorLine` — to all error-message output (provider/model-derived SSE error text and HTTP bodies reached the terminal unsanitized before).
- Reasoning tokens never restyled; non-TTY emits no ANSI.
- Export writes raw markdown outside the ANSI renderer.
- Word-aware folding: on TTY the renderer folds styled lines at word boundaries at `stdout.columns` via `src/ui/wrap.js` (`wrapWords`) instead of relying on the terminal's mid-word soft-wrap. Escape runs are never split; OSC 8 hyperlinks fold only as whole atoms; words longer than the width are hard-cut at the exact width. Policy: prose (`paragraph`/`quote`/`list`/`list_item`/`heading`) wraps; `fence`/`code`/`hr` lines and tables stay raw (terminal soft-wraps the rare overflow). The rewind bookkeeping counts the renderer's own inserted folds (per-line emitted rows + partial rows) with the exact-fill rule (`width % cols === 0`), so redraws stay exact; a strip/segment exceeding the width (trailing spaces, over-wide link atoms) is row-counted by the same formula, never re-folded. Without a terminal width (pipes) nothing wraps and output stays byte-identical to pre-wrapping. `renderText` takes an optional 3rd `cols` arg (used by `renderHistory` replay); the fold point drops the space before the wrapped word, earlier spaces of a multi-space run are kept.
- The same word-aware folding covers the streamed reasoning body (`writeSegment('reasoning')`), the plain (non-markdown) content path and history replay of both: `createWordWrap` (`src/ui/wrap.js`) emits pieces as they arrive while holding the current word until its fit is known — lines fold at spaces and over-long words stream in exact-width chunks; the width may be passed as a getter and is re-resolved per write, so a mid-stream resize folds at the new width; every text piece goes through the given style (`dim` for reasoning) while fold/newline bytes stay raw. Without a usable width it passes text through unchanged (byte-identical pipes). A space that would push a row past the width is itself the fold point in `wrapWords` too (dropped, next word starts the next row) — a row never exceeds the terminal width, so `renderHistory` replay cannot soft-wrap and desync above the editor. Instance lifecycle: `end_reasoning` and `render.flush()` flush the wraps; the compact-thinking path is untouched (meter owns the line).

## Smooth streaming semantics

- Pacing in `src/ui/stream.js`: mutable `smoothCharsPerTick`/`smoothTickMs` on renderer; speed changes apply next tick.
- Pref `smoothSpeed` stores canonical cps: slow 500, normal 2000, fast 8000; default normal.
- `/smooth on|off|<speed>` updates state + renderer + prefs; invalid values error and leave state unchanged.
- `toFinalState` does not include smooth speed; config setters and `/smooth` persist it.
- Piped output never paces.

## Compact thinking semantics

- Purpose: replace the streamed reasoning body on TTY with a live `Thinking · <count> · <seconds>` spinner meter; default off (full text, byte-identical to pre-feature output).
- Meter = `createThinkingMeter` in `src/ui/loader.js` (own grace/tick; `update(chars)` bumped per reasoning chunk and painted on the next tick together with the elapsed seconds — the clock is the injectable `now` option, default `performance.now()`; `stop({done:true})` always writes `✓ Thinking · <count> · <seconds>` even inside the grace window so the checkpoint is deterministic). `stop({done:true})` also resets the shown flag so a following turn's `start()` restarts the grace window and tick timer (the `/retry` path reuses the same meter instance — without the reset the second turn drew a frozen `Thinking · 0` and never repainted). Seconds via `formatElapsedSeconds` (src/ui/format.js): one decimal under 10s (`0.8s`, `5.7s`), rounded seconds (`42s`), minutes with padded seconds (`1m05s`, `2m`).
- Duration persistence: `parseSSEStream` (src/sse-parser.js) times the thinking phase (start_reasoning → end_reasoning, including EOF mid-thinking) and returns `reasoningMs` (null when no reasoning); both providers thread it through `apiResult`, and turn-runner/one-shot store it as `reasoningMs` on the assistant message so the session file keeps it for replay.
- Renderer contract (`src/ui/stream.js`, `createStreamRenderer({..., compactThinking})`): compact reasoning bypasses the smooth queue and writes nothing; `start_reasoning` starts the meter, `reasoning` counts sanitized chars, `end_reasoning` stops with the checkpoint + `\n❯ Answer\n\n`. `flush()`/`flush({sync:true})` stop the meter (interrupt/error paths never leave a dangling line). Mutable `render.compactThinking` (like `render.smooth`/`render.markdown`); toggles apply between turns. An injectable `now` clock reaches the meter through `createStreamRenderer` (tests only; production default unchanged).
- History replay (`renderHistory`, option `compactThinking`) prints `✓ Thinking · <count> · <seconds>\n\n❯ Answer\n\n` from the stored reasoning length and `reasoningMs`; legacy messages without `reasoningMs` (pre-duration sessions) replay count-only. Full reasoning text stays in the session file and exports.
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
- `listSessions` orders most-recently-used first: `updatedAt` desc, falling back to `createdAt`, then the creation-time id (left for legacy sessions). `formatSessionItem` shows the same last-activity timestamp, so the picker and `--list-sessions` display when a session was last used, not when it was created.
- `updatedAt` is activity-stamped, never resume-stamped: `ChatState` (and the image REPL) carry the stored value and refresh it only when new content is added (`appendUser` / an image generation). Resuming and quitting without sending anything leaves `updatedAt` unchanged, so the session stays where it was; the payload falls back to `now` only when no stored value exists.
- Session ids `YYYY-MM-DDTHH-MM-SS`; prefix matching works.
- Title from first user message, truncated to 50 chars (a longer message yields the first 50 chars + `...`).
- `appendUser` stamps `updatedAt` (new turn); `/retry`/`/edit`/`/scrape` go through it too, so all message-sending paths bump. `toFinalState` carries `updatedAt`.
- `loadSession` error contract: missing/corrupt files raise `CliError`; other read errors rethrown.


## Edit last message semantics

- `/edit` re-opens the last user turn (the most recent `role: 'user'` message) in the editor, pre-filled with its message text (`messageText` — the first text part, so attachment payloads of any kind are never shown); Ctrl+C cancels with no changes, an empty/whitespace result is rejected with `Edit cancelled: the message cannot be empty.` and never deletes the turn; `Nothing to edit yet.` when no user message exists.
- Submit replaces the message text part in place — every other part of that message is kept (`rewriteUserContent`: image/file blobs and text-attachment payloads stay untouched, in their original positions); everything after the edited message is dropped (the stale assistant answer), the session is saved immediately (`saveSession`, so the edit survives a failed rerun), the transcript is redrawn with `redrawForRetry` (wipe + the `onResizeRepaint` hook — banner + history), and the turn is re-run through the same `rerunTurn` shape and budget guard as `/retry` (the second wipe only when the rerun appended nothing).
- Failed-turn interaction: when a retryable error popped the most recent user turn into `state.retryTurn`, `/edit` edits that stashed content instead of the older answered one, clears the stash, and appends + runs the edited turn.
- The edit editor is opened through `ctx.readInput` (exposed on `chatCtx` in `src/chat.js`) without suggestions, so an edited message starting with `/` is never parsed as a command; the resize hook is threaded through `ctx.onResizeRepaint` (same `renderAboveEditor` the main prompt passes), so resizing mid-edit re-renders the transcript instead of falling back to the DSR-only repaint.

## Error handling contract

- Providers throw `ApiError`: 401 invalid key (not retryable), 429/5xx/network retried, timeouts retried.
- Transient chat errors pop the user message so it is not re-sent; permanent errors keep it. The popped turn is stashed as `state.retryTurn` (content only — attachments are embedded in it), so `/retry` replays exactly that failed turn with its attachments; a new user prompt clears the stash. Network/timeout retries in `fetchWithRetry` are idempotent-method only (a POST whose response never arrived may have been processed server-side — retrying would double the generation and the bill); response-class retries (429/5xx) still apply to any method.
- Session/prefs saves are non-fatal; single warning per save path.
- `ExitPromptError` from pickers must propagate to the cli-main “Aborted.” handler.
- `writeFileAtomic` used for config/session/sidecar; private modes 0600/0700.

## System prompt semantics

- `loadSystemPrompt(customPath)` (`src/config.js`) reads + trims the file; empty/whitespace-only content returns null (falls back to `DEFAULT_SYSTEM_PROMPT`).
- Explicit `--system-prompt <path>`: any read failure is a fatal `CliError` (ENOENT → `Error: system prompt file not found: <path>`, other errors → `Error: could not read system prompt file <path>: <msg>`) — never a silent fallback, so typos fail loudly before the pickers/one-shot dispatch (cli-main).
- Default `~/.communicator-system-prompt.md`: missing is the normal optional case (returns null silently); other read errors warn and return null.
- The file is read once at startup; changes require restarting the chat. Venice always sends `include_venice_system_prompt: false`.

## Display consistency contract

Cross-path invariants pinned by `test/ui-consistency.test.js`. Every change must update all call sites and this section.

- **Session banner**: `\nConnected to <segments joined '  '>\n[<hints joined '  |  '>\n]`; TTY dims keys/brackets; wraps greedily, badges atomic. Banner and `/status` use same `buildStatusLine` segments. Image banner uses `buildImageStatusLine`.
- **Turn markers**: every marker (`❯ Thinking`, `❯ Answer`, `❯ You`, and in RPG mode `❯ <char>`/`❯ <user>`) gets exactly one blank line above and one below the label: `❯ Thinking\n\n<reasoning>\n\n❯ Answer\n\n`. Live and history replay identical. Compact mode replaces the body with the meter checkpoint `✓ Thinking · <count> · <seconds>\n\n❯ Answer\n\n` (count = ANSI-stripped reasoning chars via `formatCompactCount`; seconds = stored `reasoningMs` via `formatElapsedSeconds`, omitted for legacy messages without it); live and history replay identical. Continuation redraws (`/retry`, `/edit`, and the resize/launch frame ending in a rerun) pass `renderHistory({ tailBlank: false })` so the transcript ends flush on the last message row: the rerun's leading `\n\n` (turn start) then leaves exactly one blank row above the next streamed marker — the same one a live submitted line gets, never a doubled gap from the transcript's own trailing blank. `tailBlank` defaults to `true` (footer/separator locations keep the blank below the transcript).
- **Live turn start** (`createTurnRunner`): on TTY the turn writes `\n\n` before the loader, so the loader/marker row is one blank row below the submitted user line — markers never glue to the user line. `start_reasoning` bare-stops the loader (`\r\x1b[K`) in FULL mode too (not just compact): the `❯ Thinking` label / meter checkpoint owns the loader's line, so the spinner text never collides with the label and `✓ Waiting for response` never appears in a reasoning transcript (reasoning tokens never stop the loader again; `content` still resolves the waiting line when no reasoning intervened).
- The `start_reasoning` marker token from the SSE parser is a bare `'\n'`; the renderer ignores marker token text (live and history replay share the exact one-blank layout).
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
- The thinking→content transition is ONLY a non-empty content payload (`content: ''` / `content: []` are not): reasoning streams commonly carry an empty content field on every delta, and closing the block there would re-open it on the next reasoning delta — a start/end cycle per delta, which compact mode renders as a checkpoint line per reasoning chunk. A mixed delta with real `reasoning`/`reasoning_content` AND real `content` emits both (block closes, content streams).

## Command autocomplete

- Editor keymap and input semantics (the behaviour parity contract implemented by `src/editor/`, originally spelled out by the now-removed `@toiroakr/read-multiline` 0.4.1): Enter submits; Ctrl+J/Shift+Enter newline; Ctrl+C cancels the prompt; Ctrl+D deliberately unbound (EOF in shells vs forward-delete in emacs-style apps, and it would exit the chat); Ctrl+Delete clears the whole buffer in one undoable step (kitty CSI-u `\x1b[3;5u` and xterm `\x1b[3;5~`; a no-op on an already-empty buffer; added as a small maintenance-shaped convenience outside the editor parity contract, advertised as `Ctrl+Delete: clear` in the help footer); kitty CSI-u sequences mapped for Enter/Ctrl+C/Ctrl+Z/Ctrl+P/Ctrl+N/Ctrl+A/Ctrl+E/Tab/arrows (bracketed-paste markers `\x1b[200~`/`\x1b[201~`, DSR replies `\x1b[r;cR` reassembled through an escape buffer — 50 ms lone-Escape flush; 1.5 s paste watchdog force-ends a paste whose end marker never arrives). Unicode line/paragraph separators (`U+0085`, `U+2028`, `U+2029`) normalize to newlines in typed and pasted text; paste payloads drop other C0 control bytes; CRLF normalizes in pastes. Suggestions appear for single-line `/`-prefixed non-exact prefixes; Tab/Shift+Tab cycle; Escape dismisses (restoring the typed prefix). History: draft saved on arrow-up recall, cursor at line start for history entries, draft restored at end with cursor after.
- Suggestions appear for single-line `/`-prefixed non-exact prefixes; Tab/Shift+Tab cycle; Escape dismisses; kitty protocol key bindings supported.
- Command list derived from `CHAT_COMMANDS`; pure `matchCommands` in `src/suggest.js`.

## Known quirks

- Editor raw mode intercepts Ctrl+C at prompt; during streaming Ctrl+C is real SIGINT.
- Piped stdin reads to EOF as one message; piped flows exit explicitly.

## Project strategy

- **Feature freeze** (Aug 2026, after 3.38.2 through 3.40.x): no experimental features; the word-aware wrapping + frame-diffing editor work (3.39.0) was the last feature push. Only bug fixes with regression tests; refactors stay maintenance-shaped (no new flags/options).
- The frame-diffing editor (`src/editor/`) is the live implementation (merged Aug 2026): the abandoned buffer-diff design direction from Aug 2026 was revisited and broadened — explicit-grid rendering replaces the old editor's cursor-relative soft-wrap math, and the terminal-emulator test harness (`test/editor-grid.test.js`) pins the desync bug class at screen level. The vendored `read-multiline` copy was removed with the swap; its behaviour lives on as parity facts above.
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
