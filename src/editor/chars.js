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
  // Combining marks and format characters default to width 1; the context
  // rule in isZeroableMark/rowWidth/stringWidth narrows marks to 0 when they
  // attach to a base (a lone mark still counts 1 here, so this table can
  // never under-count on its own).
  return 1
}

// Non-spacing combining marks (Mn only) that are zero columns when attached:
// Mn follows a non-space base on the same row. Spacing marks (Mc) consume a
// cell by definition (Devanagari क + U+093E renders TWO cells) and enclosing
// marks (Me, e.g. the keycap U+20E3) do too, so they keep width 1. Variation
// selectors are excluded — a text-presentation base plus U+FE0F (⚠️, ❤️)
// renders TWO cells, so zeroing them would under-count. ZWJ is not Mn, so
// rowWidth (the fold oracle) still over-counts a family — mild, permitted;
// the visual seam (stringWidth/visualCol/colFromVisual) measures it as ONE
// 2-cell cluster via rendersAsDoubleWidthEmoji below.
const ZEROABLE_MARK = /\p{Mn}/u
const isVariationSelector = (cp) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)

function isZeroableMark(cp) {
  if (cp < 0x300 || isVariationSelector(cp)) return false
  return ZEROABLE_MARK.test(String.fromCodePoint(cp))
}

// Cluster-aware visual measures. charWidth/rowWidth stay per code point and
// drive the fold decisions in layout.js (an over-count there only wraps a row
// early — the mild, permitted direction). The cursor-placement and
// erase-to-EOL seam — stringWidth, visualCol, colFromVisual — instead measures
// per grapheme cluster, because the terminal renders a ZWJ family as ONE
// two-cell glyph: a per-code-point sum there parks the cursor several columns
// past the text (rewindCursor \x1b[<c+1>G) and can skip the exact-fill erase.
// All three share this one primitive so the visualCol<->colFromVisual inverse
// stays exact: cluster-aware stringWidth against a per-code-point colFromVisual
// collapses the cursor INTO a cluster (the round-trip desync pinned by tests).
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const EMOJI = /\p{Emoji}/u
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const KEYCAP = 0x20e3
const ZWJ = 0x200d
const ZWNJ = 0x200c
const TAG_END = 0xe007f
const TAG_START = 0xe0020
const VS15 = 0xfe0e
const VS16 = 0xfe0f

// Members that may appear inside a double-width emoji glyph: extended
// pictographs (\p{Emoji} covers Emoji_Presentation too), joiners, variation
// selectors, skin-tone tags, RECENT_EMOJI (the Unicode-17 additions the
// runtime property may not know — a family containing one must still measure
// 2, never the sum), and zero-width combining marks that compose over the
// glyph. Spacing (Mc) / enclosing (Me) marks are deliberately excluded —
// they consume their own cell, so such a cluster falls through to the safe
// per-code-point sum.
function isEmojiish(cp) {
  if (cp === ZWJ || cp === ZWNJ || cp === VS15 || cp === VS16) return true
  if (cp >= TAG_START && cp <= TAG_END) return true
  return EMOJI.test(String.fromCodePoint(cp)) || RECENT_EMOJI.has(cp) || ZEROABLE_MARK.test(String.fromCodePoint(cp))
}

// True when a cluster renders as ONE double-width emoji glyph: ZWJ families,
// regional-indicator flags, keycap sequences (base + keycap, with or without
// VS16) and emoji-plus-modifier chains. A ZWJ chain is also double-width when
// its members are text-presentation emoji (🕵️‍♂️ = U+1F575 U+FE0F U+200D
// U+2642 U+FE0F, where no member is Emoji_Presentation but the chain renders
// as one 2-cell glyph): as long as two Extended_Pictographic members are
// joined, the rule matches string-width's. Keycap without a base — a lone
// U+20E3 — is NOT: it occupies nothing on its own, so it falls through to the
// sum (width 1 keeps the row-start invariant).
function rendersAsDoubleWidthEmoji(cluster) {
  const cps = [...cluster].map((ch) => ch.codePointAt(0))
  // A keycap sequence is double-width even when its base is a plain digit
  // ('1' is not \p{Emoji}, so the all-members-emojiish rule would reject it).
  if (cps.indexOf(KEYCAP) > 0) return true
  let presentation = false
  let extended = 0
  let zwj = false
  for (const cp of cps) {
    const ch = String.fromCodePoint(cp)
    if (cp === ZWJ) zwj = true
    if (EXTENDED_PICTOGRAPHIC.test(ch)) extended += 1
    if (EMOJI_PRESENTATION.test(ch)) presentation = true
    else if (!isEmojiish(cp)) return false
  }
  if (zwj && extended >= 2) return true
  return presentation
}

// Width of one grapheme cluster with row context, plus the base state it
// leaves behind (see rowWidth). Emoji clusters are exactly 2 (base=true), so
// the sum never over-counts a family and the cursor column matches the glyph.
function clusterWidth(cluster, base) {
  if (rendersAsDoubleWidthEmoji(cluster)) return { width: 2, base: true }
  let width = 0
  let b = base
  for (const ch of cluster) {
    const { width: w, base: nextBase } = rowWidth(ch.codePointAt(0), { base: b })
    width += w
    b = nextBase
  }
  return { width, base: b }
}

// Width of one code point with row context: zeroable marks render as zero
// columns after a non-space base (or another mark) on the same row, and as
// one column when they start a row (a lone mark, or a base the hard cut left
// behind — a row-start mark never under-counts). A space is not a base: a
// mark after a space keeps width 1 (space + dotted-circle renders two cells
// in practice; err wide).
export function rowWidth(cp, { base = false } = {}) {
  let w = charWidth(cp)
  if (isZeroableMark(cp)) {
    w = base ? 0 : 1
  } else if (w > 0 && cp !== 0x20) {
    base = true
  } else if (cp === 0x20) {
    base = false
  }
  return { width: w, base }
}

/** Returns the terminal display width of a string (ANSI escape codes are ignored) */
export function stringWidth(str) {
  const s = str.includes('\x1b') ? stripVTControlCharacters(str) : str
  let width = 0
  let base = false
  for (const { segment } of graphemeSegmenter.segment(s)) {
    const { width: w, base: nextBase } = clusterWidth(segment, base)
    width += w
    base = nextBase
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
  let base = false
  for (const { index, segment } of graphemeSegmenter.segment(str)) {
    const { width: cw, base: nextBase } = clusterWidth(segment, base)
    if (vis + cw > visualCol) return index
    vis += cw
    base = nextBase
    i = index + segment.length
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
