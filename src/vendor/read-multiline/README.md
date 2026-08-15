# read-multiline (vendored)

This directory is a vendored copy of [`@toiroakr/read-multiline`](https://github.com/toiroakr/read-multiline)
version **0.4.1** (MIT license, zero runtime dependencies).

- Copied from `node_modules/@toiroakr/read-multiline/dist/` (the package's `dist` build output).
- Files are kept byte-close to upstream except for the `suggest` patch (see below) so
  future upstream diffs are easy to apply.
- The npm dependency was removed from `package.json`; `src/input.js` imports
  `../vendor/read-multiline/index.js` instead.

## Patch: `suggest` option

The upstream library has no suggestion/autocomplete support. A minimal patch adds a
`suggest` option to `readMultiline` plus a session-based suggestion list:

- `index.js` — reads `suggest` from options and stores it on `state`; stores the initial
  styled footer as `state.baseFooterText`; initializes `state.suggestSession` to `null`.
- `input.js` — binds Tab/Shift+Tab and Up/Down arrows to navigate the suggestion list,
  and Escape to dismiss it, in both legacy and kitty-protocol (CSI u) encodings.
  - Tab: `\t` / `\x1b[9u` / `\x1b[9;1u`; Shift+Tab: `\x1b[Z` / `\x1b[9;2u` / `\x1b[1;2Z`
    (with the kitty keyboard protocol enabled, terminals report Tab as `CSI 9 u`
    instead of `\t`).
  - Up/Down (`\x1b[A` / `\x1b[B`) navigate the suggestion list while a session is
    active and fall back to history navigation otherwise.
  - Escape: `\x1b` / `\x1b[27u` / `\x1b[27;1u` restores the typed prefix.
- `editing.js` — calls `refreshSuggestions` at the end of `onContentChanged`; adds
  `suggestMove` (fills the line with the next/prev match within the session),
  `nextSuggestionMove`, `dismissSuggestions`, and keeps `cycleSuggestion` as an alias
  for Tab/Shift+Tab.
- `rendering.js` — adds `updateSuggestionSession` (tracks `{ prefix, matches, index }`
  so cycling never dead-ends on the filled match) and `restoreFooter`; `refreshSuggestions`
  renders the matches into the footer slot (reusing `setFooter`/`drawBelowEditor`), keeps
  the list visible while a session is active, highlights the selected entry, and scrolls
  the window around the selection.

## Local deltas (3.29.0 audit)

- `history.js` — prompt history is written with private modes (`0o600` file, `0o700`
  directory), matching the config/session file posture; the write is already atomic
  (temp + rename).
- `presets/` (clack, inquirer) and `types.js` removed, and `createPrompt` + the
  `presets` re-export stripped from `index.js` — the app only uses `readMultiline`.

## Viewport guard

All rewind-based redraws are gated by `editorBlockFits` (editor lines + status +
footer vs `output.rows`) and the `pendingPasteRepaint` flag. A terminal clamps
cursor-up at the top row, so rewinding an editor that is taller than the viewport
— or one whose buffer was just replaced by a silent bracketed paste — would
overwrite whatever was printed above the prompt (chat transcript, the RPG first
message):

- `rendering.js` — when the block does not fit or the terminal content is stale,
  `fullRedraw`/`restoreSnapshot` repaint bottom-anchored via `repaintBelow` (no
  rewind; the terminal scrolls the output above into the scrollback instead of
  erasing it). `insertPaste` sets `pendingPasteRepaint` when the paste changed the
  buffer without per-character writes; the paste-end `clearScreen` consumes it.
- `index.js` — submit/cancel/EOF skip the in-place `renderStateChange`/`clearEditorArea`
  redraws when the block does not fit (or the terminal is stale) and just drop
  status/footer state.

Known limitation (no internal windowing): moving the cursor far into a taller-than-
viewport editor desyncs the on-screen position; typing at the tail of a long message
is fully supported.

Diff with upstream:

```
diff -r node_modules/@toiroakr/read-multiline/dist src/vendor/read-multiline
```
