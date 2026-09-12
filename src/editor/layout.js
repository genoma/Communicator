// Grid computation: renders the editor block as an explicit visual grid (rows
// of styled text + cursor position). Wrapping is done here with display-width
// awareness, so the block's rows are exactly the physical terminal rows — the
// terminal's own soft-wrap never engages inside the block.
import { clusterWidth, segmentGraphemes, stringWidth } from './chars.js'
import { applyStyle } from './style.js'
import { clipToWidth } from './footer.js'

/** Widen-safe available width for one input row */
function usableWidth(termWidth, prefixWidth) {
  return Math.max(1, termWidth - prefixWidth)
}

// Misspelled-prose decoration (macOS spelling assistance): red curly underline.
// Escape-vt only — it renders no column of its own, so `stringWidth` and every
// width oracle keep measuring exactly the text.
const TYPO_UNDERLINE = '\x1b[4:3m\x1b[58:2::255:95:95m'
const TYPO_UNDERLINE_OFF = '\x1b[4:0m\x1b[59m'

/**
 * Wrap the `[start, end)` code-unit ranges of the SOURCE line that fall inside
 * this wrapped row slice. Ranges are clipped to the slice, so decoration is
 * applied to the produced row — never to the text before wrapping.
 */
function decorateTypos(segment, segmentStart, ranges) {
  if (!ranges || ranges.length === 0) return segment
  const segmentEnd = segmentStart + segment.length
  // Ranges arrive sorted and disjoint from the provider; the defensive copy
  // keeps an out-of-order caller from leaving text it should decorate plain.
  const ordered = [...ranges].sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = segmentStart
  for (const [start, end] of ordered) {
    if (end <= segmentStart || start >= segmentEnd) continue
    const to = Math.min(end, segmentEnd)
    if (to <= cursor) continue
    // Ranges arrive sorted and disjoint, but an overlap must never re-emit text
    // already rendered: that would duplicate characters and desync the grid.
    const from = Math.max(start, segmentStart, cursor)
    if (from > cursor) out += segment.slice(cursor - segmentStart, from - segmentStart)
    out += TYPO_UNDERLINE + segment.slice(from - segmentStart, to - segmentStart) + TYPO_UNDERLINE_OFF
    cursor = to
  }
  if (cursor === segmentStart) return segment
  if (cursor < segmentEnd) out += segment.slice(cursor - segmentStart)
  return out
}

/**
 * Per-line typo ranges for this paint. The provider answers `undefined` while a
 * check is pending (the row paints plain until it lands) and schedules the
 * check it still needs, so asking once per line is also the request. A buffer
 * larger than the provider cache is bounded to the caret line: with more
 * checkable lines than the cache can hold, every landed result evicts a line
 * another paint is still asking about, so the cycle would never settle.
 */
function requestTypoRanges(spelling, lines, caretLine) {
  let bufferLength = 0
  for (const line of lines) bufferLength += line.length + 1
  const maxCheckedLines = Number.isInteger(spelling.maxCheckedLines) ? spelling.maxCheckedLines : lines.length
  if (lines.length > maxCheckedLines) {
    return lines.map((line, index) => (index === caretLine ? spelling.getTypoRanges(line, bufferLength) : undefined))
  }
  return lines.map((line) => spelling.getTypoRanges(line, bufferLength))
}

/**
 * Split a plain logical line into wrapped segments that each fit `limit`
 * display columns. Segments fold at word boundaries: the word that would not
 * fit starts the next segment, so only a single word longer than the full
 * segment width is ever broken (at the width, never mid-word otherwise). Wide
 * characters never split across segments.
 */
export function wrapSegments(text, limit) {
  return wrapSegmentsDetailed(text, limit).segments
}

/**
 * Like `wrapSegments`, but also returns for each segment its exact code-unit
 * start in the source line and the code-unit index of every fold-dropped
 * space. These offsets are recorded while wrapping (never re-derived with
 * indexOf, whose first-match search mislocates a segment whose text also
 * appears at the drop site, e.g. a space run around a fold at limit 1).
 */
function wrapSegmentsDetailed(text, limit) {
  const segments = []
  const starts = []
  const drops = []
  let current = ''
  let cw = 0
  // The last space in the current segment (code-unit offset within it + width
  // before it) is the fold point; folding drops that space.
  let foldAt = -1
  let foldW = 0
  // Code-unit index of `current`'s first character in `text`.
  let curStart = 0
  const pushSegment = (start, end) => {
    segments.push(text.slice(start, end))
    starts.push(start)
  }
  // Iterate grapheme clusters, exactly like chars.js's own visual measures:
  // a ZWJ family/flag/keycap is ONE 2-cell glyph and must never be split
  // across segments (per-code-point folding hard-cut families into fragments
  // and folded rows 9 columns early).
  let rowBase = false
  for (const { index, segment } of segmentGraphemes(text)) {
    const { width: w, base: nextBase } = clusterWidth(segment, rowBase)
    if (segment === ' ') {
      if (cw + w > limit) {
        // The row is already full: the space is the fold point — it would be
        // invisible at the row end, so drop it and let the next word start a
        // fresh row (a grid row must never exceed the terminal width).
        pushSegment(curStart, index)
        drops.push(index)
        current = ''
        curStart = index + 1
        cw = 0
        foldAt = -1
        foldW = 0
        rowBase = false
        continue
      }
      // Spaces never overflow: they are committed (a trailing one stays
      // invisible at the row end) and the next word folds before this one.
      foldAt = current.length
      foldW = cw
      current += segment
      cw += w
      rowBase = nextBase
      continue
    }
    if (cw + w > limit) {
      if (foldAt > 0) {
        // The fold space is the character directly before the residual.
        pushSegment(curStart, curStart + foldAt)
        drops.push(curStart + foldAt)
        const residualStart = curStart + foldAt + 1
        // current === text.slice(curStart, index), so the residual (post-fold)
        // equals text.slice(residualStart, index) + segment.
        current = text.slice(residualStart, index) + segment
        curStart = residualStart
        cw = cw - foldW - 1 + w
      } else {
        // Hard cut always lands on a cluster boundary. Never push an empty
        // segment — a leading cluster wider than the limit (a 2-cell emoji at
        // limit 1) would otherwise become a ghost blank grid row.
        if (current !== '') pushSegment(curStart, index)
        current = segment
        curStart = index
        cw = w
      }
      // Recompute the fold point of the residual segment. The residual
      // starts right after a dropped fold space, so its base is false (a
      // space sets no base), never the pre-fold rowBase.
      foldAt = -1
      foldW = 0
      let w2 = 0
      let i2 = 0
      let residualBase = false
      for (const { segment: rc } of segmentGraphemes(current)) {
        if (rc === ' ') {
          foldAt = i2
          foldW = w2
        }
        const rw = clusterWidth(rc, residualBase)
        w2 += rw.width
        residualBase = rw.base
        i2 += rc.length
      }
      // The residual segment's own base (it starts after the dropped space).
      rowBase = residualBase
    } else {
      current += segment
      cw += w
      rowBase = nextBase
    }
  }
  if (current !== '' || segments.length === 0) pushSegment(curStart, text.length)
  if (segments.length > 1 && segments.at(-1) === '') {
    segments.pop()
    starts.pop()
  }
  return { segments, starts, drops }
}

/**
 * Display column of each segment's first character in the flattened view.
 * A fold drops exactly one space, so consecutive segments are consecutive in
 * display space; the dropped space itself occupies one LOGICAL column (the
 * cursor parks on it at the end of the previous row) but no display column.
 */
function segmentDisplayStarts(segments) {
  const dispStarts = []
  let disp = 0
  for (const segment of segments) {
    dispStarts.push(disp)
    disp += stringWidth(segment)
  }
  return dispStarts
}

/**
 * Compute the visual grid for the editor block.
 *
 * Input: header rows (styled, pre-split), the styled line prefix (+ its raw
 * display width), the plain logical input lines, the logical cursor, an
 * optional status row, and the styled footer rows.
 *
 * Output: `rows` (block rows in paint order, without trailing erase codes) and
 * `cursor` (0-based visual row + 0-based display column).
 */
export function computeGrid(ctx) {
  const {
    width,
    headerRows,
    linePrefix,
    linePrefixWidth,
    lines,
    row,
    col,
    statusText,
    statusColor,
    theme,
    footerRows,
    inputStyle,
    submittedMarker,
    spelling,
  } = ctx
  // Submitted-marker form (chat replays the user line as `❯ You\n\n<text>`):
  // the block becomes [blank, marker, blank, body rows at FULL width (no line
  // prefix, matching renderHistory's wrapPlain(cols))] with the cursor parked
  // at the end of the last body row, so the turn runner's `\n` + TTY `\n`
  // yields exactly the replay form `\n❯ You\n\n<text>\n\n`. Live and history
  // replay must be byte-identical (Display consistency contract).
  if (submittedMarker) {
    const bodyRows = []
    for (const line of lines) {
      for (const segment of wrapSegmentsDetailed(line, width).segments) {
        bodyRows.push(segment)
      }
    }
    // The marker row must never exceed the terminal width (the grid↔screen 1:1
    // invariant — an over-wide cell would soft-wrap and desync). The marker is
    // styled ANSI text (e.g. a long RPG user name on a narrow terminal), so
    // clip escape-safely.
    const markerRow = stringWidth(submittedMarker) > width ? clipToWidth(submittedMarker, width) : submittedMarker
    const rows = ['', markerRow, '', ...bodyRows]
    return {
      rows,
      cursor: { r: rows.length - 1, c: stringWidth(bodyRows.at(-1) ?? '') },
      width,
    }
  }
  const rows = [...headerRows]
  const limit = usableWidth(width, linePrefixWidth)
  // Wrap each logical line once; the cursor-row math reuses the same result
  // (segments, code-unit starts and fold-dropped offsets) instead of
  // re-wrapping every line a second time per keystroke.
  const wrappedLines = lines.map((line) => wrapSegmentsDetailed(line, limit))
  // Decorations live only in the pending body rows: the submitted-marker form
  // above paints the replay form (`❯ You\n\n<text>`), which carries none.
  const typoRanges = spelling ? requestTypoRanges(spelling, lines, row) : null
  for (let li = 0; li < lines.length; li++) {
    const { segments, starts } = wrappedLines[li]
    const ranges = typoRanges ? typoRanges[li] : null
    for (let si = 0; si < segments.length; si++) {
      rows.push(linePrefix + applyStyle(decorateTypos(segments[si], starts[si], ranges), inputStyle))
    }
  }
  let cursorRow = 0
  let cursorCol = 0
  let inputOffset = headerRows.length
  for (let li = 0; li < lines.length; li++) {
    const { segments, starts, drops } = wrappedLines[li]
    if (li === row) {
      const dispStarts = segmentDisplayStarts(segments)
      // Map the logical column onto the visual rows, entirely in display
      // space (code-unit offsets only decide WHICH segment the cursor is
      // in; wide chars never match a code-unit offset). A dropped fold
      // space is invisible: subtract it from the display column only once
      // the cursor has crossed it, so a cursor ON the fold space parks at
      // the end of the preceding row.
      let folded = 0
      for (const d of drops) {
        if (d < col) folded += 1
      }
      const dcol = stringWidth(lines[li].slice(0, col)) - folded
      let idx = 0
      for (let si = segments.length - 1; si >= 0; si--) {
        if (starts[si] <= col) {
          idx = si
          break
        }
      }
      cursorRow = inputOffset + idx
      cursorCol = linePrefixWidth + (dcol - dispStarts[idx])
    }
    inputOffset += segments.length
  }
  if (statusText) {
    const errorStyle = statusColor === 'red' ? theme?.error : undefined
    const themeStyle = errorStyle
    let statusRow
    if (themeStyle) {
      statusRow = applyStyle(statusText, themeStyle)
    } else if (statusColor === 'red') {
      statusRow = `\x1b[31m${statusText}\x1b[0m`
    } else {
      statusRow = statusText
    }
    rows.push(statusRow)
  }
  if (footerRows && footerRows.length > 0) {
    for (const line of footerRows) rows.push(line)
  }
  return { rows, cursor: { r: cursorRow, c: cursorCol }, width }
}
