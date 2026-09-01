// Display-width helpers, per the wcwidth conventions used by the editor.
import { stripVTControlCharacters } from 'node:util'

// The editor paints an explicit grid and relies on never emitting a row wider
// than the terminal. So the ONE invariant here is: never measure a character
// as NARROWER than the terminal renders it. An under-count overflows the row,
// the terminal soft-wraps it, and the grid<->screen 1:1 mapping desyncs into
// ghost duplicate rows — the bug class the frame-diffing editor exists to
// prevent. Over-counting folds a row early instead, which is far milder but
// not free (it can skip the exact-fill \x1b[K and drift the absolute cursor
// column), so the table aims to be exact and errs wide only when it must.
//
// East Asian Wide/Fullwidth ranges (UAX #11), sorted for binary search.
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2630, 0x2637], [0x268a, 0x268f],
  [0x2e80, 0x303e], [0x3041, 0x33bf], [0x33c0, 0x33ff], [0x3400, 0x4dbf],
  [0x4dc0, 0x4dff], [0x4e00, 0xa4cf], [0xa960, 0xa97c], [0xac00, 0xd7af],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff01, 0xff60],
  [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x16ff0, 0x16ff6], [0x17000, 0x18cd5],
  [0x18cff, 0x18cff], [0x18d00, 0x18d1e], [0x18d80, 0x18df2], [0x1aff0, 0x1affe],
  [0x1b000, 0x1b2fb], [0x1d300, 0x1d376], [0x1f200, 0x1f265],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

// Emoji that default to emoji presentation render as two cells. This tracks
// the runtime's Unicode data, unlike the table above — see the drift test in
// test/editor-grid.test.js, which fails if the table falls behind.
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u

// The lowest Emoji_Presentation code point, so ordinary punctuation and
// symbols above U+1100 skip the property test entirely.
const FIRST_EMOJI = 0x231a

// Emoji added to Unicode after the oldest runtime this package supports.
// Node 22 (engines: >=22.13.0) ships ICU 76 / Unicode 16.0, so its
// \p{Emoji_Presentation} does not match these Unicode 17 additions and the
// width would fall back to 1 — an under-count, i.e. the bug this table exists
// to prevent. Listed explicitly so the width does not depend on which Node is
// running (verified: zero under-counts on both 22.13.0 and 26.8.1).
//
// Deliberately NOT folded into WIDE_RANGES: that table also answers "is this
// a word character" for word-jump (see isWordChar), and an emoji is not a
// word. Extend this set when the drift test reports new code points.
const RECENT_EMOJI = new Set([0x1f6d8, 0x1fa8a, 0x1fa8e, 0x1fac8, 0x1facd, 0x1faea, 0x1faef])

// Nothing below U+1100 is ever wide, so ASCII and Latin skip every lookup.
const FIRST_WIDE = 0x1100

function isWide(code) {
  let lo = 0
  let hi = WIDE_RANGES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = WIDE_RANGES[mid]
    if (code < start) hi = mid - 1
    else if (code > end) lo = mid + 1
    else return true
  }
  return false
}

/** Returns the terminal display width of a character (full-width=2, half-width=1) */
export function charWidth(code) {
  if (code < 32) return 0
  // Negated so NaN/undefined also land here: the function stays total.
  if (!(code >= FIRST_WIDE)) return 1
  if (isWide(code)) return 2
  if (code < FIRST_EMOJI || code > 0x10ffff) return 1
  if (EMOJI_PRESENTATION.test(String.fromCodePoint(code))) return 2
  if (RECENT_EMOJI.has(code)) return 2
  // Combining marks and format characters deliberately keep width 1 rather
  // than 0. Zeroing them would be more accurate in context (decomposed "e" +
  // U+0301 really is one cell) but it under-counts a mark that stands alone,
  // and it would make a text-presentation base plus U+FE0F sum to 1 where
  // terminals render 2 (⚠️, ❤️, 1️⃣). Width 1 keeps both cases on the safe
  // side of the invariant; refining it is a separate change with its own
  // tests, not a rider on the emoji fix.
  return 1
}

/** Returns the terminal display width of a string (ANSI escape codes are ignored) */
export function stringWidth(str) {
  const s = str.includes('\x1b') ? stripVTControlCharacters(str) : str
  let width = 0
  for (const ch of s) {
    width += charWidth(ch.codePointAt(0))
  }
  return width
}

/** Returns the character at the given code unit index (surrogate pair aware) */
export function charAtIndex(str, index) {
  const code = str.charCodeAt(index)
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < str.length) {
    return str.slice(index, index + 2)
  }
  return str[index]
}

/** Returns the character just before the given code unit index (surrogate pair aware) */
export function charBeforeIndex(str, index) {
  const code = str.charCodeAt(index - 1)
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
    return str.slice(index - 2, index)
  }
  return str[index - 1]
}

/** Convert a visual column offset to the corresponding code-unit index in a string */
export function colFromVisual(str, visualCol) {
  let vis = 0
  let i = 0
  while (i < str.length) {
    const ch = charAtIndex(str, i)
    const cw = charWidth(ch.codePointAt(0))
    if (vis + cw > visualCol) break
    vis += cw
    i += ch.length
  }
  return i
}

/** Get the visual (display) width of a string up to a code-unit index */
export function visualCol(str, col) {
  return stringWidth(str.slice(0, col))
}

export function isWordChar(ch) {
  if (/\w/.test(ch)) return true
  // Ideographic scripts have no spaces, so a full-width character is a word on
  // its own. This asks the East Asian Width table directly rather than
  // `charWidth(...) === 2`: word-jump and undo grouping must not change just
  // because the width table learned that emoji are two cells wide.
  return isWide(ch.codePointAt(0))
}

/** Count total characters across all lines (join with newlines) */
export function contentLength(lines) {
  let len = 0
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) len++ // newline separator
    len += [...lines[i]].length
  }
  return len
}
