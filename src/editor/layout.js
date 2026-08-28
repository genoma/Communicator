// Grid computation: renders the editor block as an explicit visual grid (rows
// of styled text + cursor position). Wrapping is done here with display-width
// awareness, so the block's rows are exactly the physical terminal rows — the
// terminal's own soft-wrap never engages inside the block.
import { charWidth, stringWidth } from './chars.js'
import { applyStyle } from './style.js'

/** Widen-safe available width for one input row */
function usableWidth(termWidth, prefixWidth) {
  return Math.max(1, termWidth - prefixWidth)
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
  let i = 0
  const pushSegment = (start, end) => {
    segments.push(text.slice(start, end))
    starts.push(start)
  }
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0))
    if (ch === ' ') {
      if (cw + w > limit) {
        // The row is already full: the space is the fold point — it would be
        // invisible at the row end, so drop it and let the next word start a
        // fresh row (a grid row must never exceed the terminal width).
        pushSegment(curStart, i)
        drops.push(i)
        current = ''
        curStart = i + 1
        cw = 0
        foldAt = -1
        foldW = 0
        i += 1
        continue
      }
      // Spaces never overflow: they are committed (a trailing one stays
      // invisible at the row end) and the next word folds before this one.
      foldAt = current.length
      foldW = cw
      current += ch
      cw += w
      i += 1
      continue
    }
    if (cw + w > limit) {
      if (foldAt > 0) {
        // The fold space is the character directly before the residual.
        pushSegment(curStart, curStart + foldAt)
        drops.push(curStart + foldAt)
        const residualStart = curStart + foldAt + 1
        // current === text.slice(curStart, i), so the residual (post-fold)
        // equals text.slice(residualStart, i) + ch.
        current = text.slice(residualStart, i) + ch
        curStart = residualStart
        cw = cw - foldW - 1 + w
      } else {
        // Hard cut: the residual is full at the fold point. Never push an
        // empty segment — a leading wide char at limit 1 would otherwise
        // become a ghost blank grid row.
        if (current !== '') pushSegment(curStart, i)
        current = ch
        curStart = i
        cw = w
      }
      // Recompute the fold point of the residual segment.
      foldAt = -1
      foldW = 0
      let w2 = 0
      let i2 = 0
      for (const rc of current) {
        if (rc === ' ') {
          foldAt = i2
          foldW = w2
        }
        w2 += charWidth(rc.codePointAt(0))
        i2 += rc.length
      }
    } else {
      current += ch
      cw += w
    }
    i += ch.length
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
  } = ctx
  const rows = [...headerRows]
  const limit = usableWidth(width, linePrefixWidth)
  // Wrap each logical line once; the cursor-row math reuses the same result
  // (segments, code-unit starts and fold-dropped offsets) instead of
  // re-wrapping every line a second time per keystroke.
  const wrappedLines = lines.map((line) => wrapSegmentsDetailed(line, limit))
  for (const { segments } of wrappedLines) {
    for (const segment of segments) {
      rows.push(linePrefix + applyStyle(segment, inputStyle))
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
    const successStyle = statusColor === 'green' ? theme?.success : undefined
    const themeStyle = errorStyle ?? successStyle
    let statusRow
    if (themeStyle) {
      statusRow = applyStyle(statusText, themeStyle)
    } else if (statusColor === 'red' || statusColor === 'green') {
      statusRow = `\x1b[3${statusColor === 'red' ? '1' : '2'}m${statusText}\x1b[0m`
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
