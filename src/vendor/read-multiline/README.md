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
  erasing it). The paste-end repaint is an exception: `consume` records the
  pre-paste cursor row (`prePasteCursorRow`) because the bulk insert moves no
  terminal cursor, and `repaintBelow` rewinds exactly that far and redraws the
  whole block in place when it fits. Without the rewind, the stale lines above
  the paste point stay on screen and the new buffer is drawn below them,
  visually duplicating every line (the ghost-line bug).
- `editing.js` — `insertPaste` sets `pendingPasteRepaint` when the paste
  changed the buffer without per-character writes; the paste-end `clearScreen`
  consumes it. `refreshSuggestions` is skipped while pasting so no footer write
  can move the physical cursor before the paste-end repaint anchors on it.
- `index.js` — submit/cancel/EOF skip the in-place `renderStateChange`/`clearEditorArea`
  redraws when the block does not fit (or the terminal is stale) and just drop
  status/footer state.

## Resize reflow

iTerm2, Ghostty, xterm etc. reflow the whole screen on resize: soft-wrapped
lines are re-laid-out around the new width and the physical cursor follows the
reflow, so the screen position of the block — and of anything above it — is
unknown to the editor. Any model-row rewind then lands on the wrong rows and
leaves the old block behind, duplicating it (the same logical-vs-physical
desync as the paste ghost); the duplication is worse across a resize drag,
where each step re-anchors on stale content and stale copies accumulate above
the anchor.

Preferred fix (used by the app): the caller passes an `onResizeRepaint` hook.

- `rendering.js` `repaintAfterResizeRepaint` wipes the screen (`\x1b[2J\x1b[3J\x1b[H`
  — also clearing scrollback, so no stale frame can survive a reflow storm),
  runs the hook, and the editor then draws its block at the current cursor —
  session-start placement, so a reflow can never desync it.
- `index.js` — the resize handler prefers the hook when provided; it must be
  given anytime the editor's output sits on top of other screen content (chat
  transcript, banners) that only the app can rebuild.
- `input.js`/`chat.js` — the app hook re-renders `renderHistory(messages)`
  plus the banner after the editor wiped the screen.

Fallback (no hook): the handler queries the cursor position (`\x1b[6n` DSR) and
`repaintFromReportedRow` anchors the redraw on the reported row with absolute
cursor positioning. `input.js` intercepts the DSR reply (`\x1b[r;cR`) instead
of feeding it to the keymap. If no reply arrives within 400 ms, the fallback
drops to the generic bottom-anchored redraw. All three only redraw the editor
block, so they cannot repair content above the block after a reflow — hence
the hook is the correct path for the chat app.

Known limitation (no internal windowing): moving the cursor far into a taller-than-
viewport editor desyncs the on-screen position; typing at the tail of a long message
is fully supported.

## Input reassembly

Terminals deliver bracketed-paste markers and escape sequences as a byte stream:
Ghostty and kitty may split `\x1b[200~`/`\x1b[201~` or any CSI sequence at an
arbitrary chunk boundary. `input.js` previously only buffered a lone `\x1b`, so a
split marker was dropped as an unknown escape and the matching fragment was
inserted as visible text — worse, a split end marker left the editor stuck in
paste mode with every key swallowed.

- `consume`/`consumeKeys`/`consumePaste` parse incrementally and return the
  trailing incomplete sequence to hold back until the next chunk completes it.
- CSI sequences are scanned by their grammar (params 0x30–0x3F, intermediates
  0x20–0x2F, final byte 0x40–0x7E); a control byte inside a CSI ends the escape
  there so the byte is reprocessed (e.g. ESC then Enter).
- A lone `\x1b` or incomplete tail is flushed after 50 ms — a real Escape press
  still reaches the keymap, and split sequences from the same burst are merged
  inside the 50 ms window.
- While pasting, only the end marker is significant (a nested paste start marker
  is literal content), and a trailing prefix of the end marker is held back.
- Watchdog: if no paste data arrives for 1.5 s, the paste is force-ended and the
  editor repaints, so a genuinely lost end marker can never leave the editor
  swallowing keys.

Diff with upstream:

```
diff -r node_modules/@toiroakr/read-multiline/dist src/vendor/read-multiline
```
