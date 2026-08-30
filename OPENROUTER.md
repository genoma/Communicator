# OpenRouter: search "burst mode" delivery

"Burst mode" is **not an OpenRouter feature** or a documented API flag. It is the
shorthand this repo uses for the delivery behavior of `/chat/completions` when
web search is enabled: instead of streaming incrementally, OpenRouter can flush
whole blocks in a single SSE burst, and the search itself can run *after* the
model has already started answering.

## When it occurs

- `--web-search auto` (`on` = `auto`) — `tools: [{ type: 'openrouter:web_search',
  parameters: { max_results, max_total_results } }]`. The model decides when to
  search; OpenRouter executes the search server-side inside the same stream.
- `--web-search always` — `plugins: [{ id: 'web', max_results }]`. The search
  runs on every request before/while the model answers.

Behavior is endpoint-dependent and undocumented — it may change or not occur at
all. **Treat every web-search stream as potentially bursty, never assume
incremental delivery** for search-enabled requests.

## Observable behavior

1. **Whole reasoning block as one burst**: `start_reasoning`, every reasoning
   delta, and `end_reasoning` land in a single SSE event/tick, usually followed
   immediately by the content in one chunk. The delta span is ~0 ms, so a
   naive clock between first and last reasoning delta reports "instant" — while
   the user actually waited seconds with no visible output.
2. **Search after the answer starts**: the model begins its response, then the
   search happens (silent gap with no SSE), then sources plus the rest of the
   content arrive in a second burst — `onSources` can fire late relative to the
   text that references them.
3. **Mixed deltas**: content and reasoning can appear in the *same* SSE delta
   (the transition chunk), and a content chunk may duplicate the final message.

## What naive assumptions break

- **Seconds (thinking clock)**: measuring the thinking phase from the first to
  the last reasoning delta yields ~0 ms → the meter checkpoint renders
  `✓ Thinking · 1.2k · 0s`, and persisted `reasoningMs ≈ 0` replays as `· 0s`
  for a response the user waited many seconds on.
- **Character counter (compact meter)**: the whole reasoning block arrives at
  once, so the counter jumps in one update; without token pacing the terminal
  visibly "pops" the entire answer.
- **Waiting indicator**: with no incremental deltas, the row sits on the plain
  spinner (`Waiting for response`) for the entire real wait — user sees
  no feedback for seconds.

## How the client handles it (contracts)

- **Clock anchored at request dispatch**: both providers capture
  `performance.now()` right before the fetch and pass `requestStartedAt` to
  `parseSSEStream`; `reasoningMs` is measured from there (fallback: first
  reasoning delta, byte-identical to pre-anchor behavior). Never re-anchor at
  the first delta.
- **Turn clock**: `render.turnStartedAt` set at turn start (turn-runner and
  one-shot). In compact mode the meter starts via `render.startTurn(waitLabel)`
  — a waiting phase painting a live clock (`Waiting for response · 2.3s`), and
  `start_reasoning` flips it to the counting phase *without losing the anchor*.
  In full mode the loader starts with the same wait label; `start_reasoning`
  bare-stops it (`\r\x1b[K`) so `❯ Thinking` owns the line.
- **Wait label**: `Searching the web` only for `always` mode; `auto` uses the
  generic `Waiting for response` (the model decides, so the label cannot
  promise a search).
- **Checkpoint rules**: `stop({ done: true })` (loader) / `resolveWaitingLine()`
  (renderer) resolve the waiting row to `✓ <waitLabel>` only when the spinner
  was visible, and the runner adds exactly one blank row before the answer on
  that result. A meter duration that renders as `0s` (< 50 ms of user-wait) is
  suppressed — the checkpoint stays count-only `✓ Thinking · N`, **never**
  `· 0s`; `renderHistory` replay applies the same rule.
- **SSE parsing** (`src/sse-parser.js`): end-of-stream mid-thinking still closes
  the thinking block; content and reasoning in the same delta are both emitted
  (no early return); empty `content: ''` never closes the block (would re-open
  per delta); keep-alive `data:` empty events are not counted as skipped
  chunks; `STREAM_IDLE_TIMEOUT_MS` (60 s) guards the silent search gap.
- **Visual smoothing**: smooth-streaming pacing (default on TTY) buffers tokens
  and renders at a steady rate, absorbing the first post-search burst; piped
  output is never paced.
- **Search caps**: `MAX_WEB_SEARCH_RESULTS` = 20, default 10;
  `max_results` caps a single call and `max_total_results` caps the cumulative
  total, so the model cannot exceed the requested count by searching repeatedly.

## Regression symptoms (checklist)

- `✓ Thinking · N · 0s` in compact mode → the clock anchor regressed
  (`turnStartedAt` / `requestStartedAt`).
- Replay shows `· 0s` → stored `reasoningMs` is wrong, or the `< 50 ms`
  suppression was dropped.
- Row frozen on the spinner after seconds of real wait → `startTurn` /
  `beginWait` path regressed.
- Stray blank row before the answer → the `stop({ done: true })` visibility
  contract regressed.

## Tests

- `test/sse-parser.test.js` — "anchors the thinking clock at request start so a
  one-burst block reports real wait".
- `test/stream.test.js` — "compact renderer reports honest seconds from the
  turn clock on a one-burst reasoning block".
- `test/loader.test.js` / `test/turn-runner.test.js` — meter waiting phase,
  sub-50 ms count-only suppression, wait-label checkpoints and blank rows.

## Sources of truth

- `MEMORY.md` — compact-thinking meter, waiting phase, and turn-marker spacing
  contracts (the one detailed home for the UI-side rules; this file is the
  provider-behavior counterpart focused on *why* those rules exist).
