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
  const segments = []
  let current = ''
  let cw = 0
  // The last space in the current segment (code-unit index + width before it)
  // is the fold point; folding drops that space.
  let foldAt = -1
  let foldW = 0
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0))
    if (ch === ' ') {
      // Spaces never overflow: they are committed (a trailing one stays
      // invisible at the row end) and the next word folds before this one.
      foldAt = current.length
      foldW = cw
      current += ch
      cw += w
      continue
    }
    if (cw + w > limit) {
      if (foldAt > 0) {
        segments.push(current.slice(0, foldAt))
        current = current.slice(foldAt + 1) + ch
        cw = cw - foldW - 1 + w
      } else {
        segments.push(current)
        current = ch
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
  }
  segments.push(current)
  if (segments.length > 1 && segments.at(-1) === '') segments.pop()
  return segments
}

/**
 * Logical display offset of each segment in its source line. Word folding
 * drops exactly one space at the fold point, so consecutive segments are
 * separated by a 1-column gap in logical coordinates (hard cuts have none).
 */
function segmentStarts(line, segments) {
  const starts = []
  let pos = 0
  for (const segment of segments) {
    const at = line.indexOf(segment, pos)
    starts.push(at)
    pos = at + segment.length
  }
  return starts
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
  const wrappedCounts = []
  for (const line of lines) {
    const segments = wrapSegments(line, limit)
    wrappedCounts.push(segments.length)
    for (const segment of segments) {
      rows.push(linePrefix + applyStyle(segment, inputStyle))
    }
  }
  let cursorRow = 0
  let cursorCol = 0
  let inputOffset = headerRows.length
  for (let li = 0; li < lines.length; li++) {
    const segments = wrapSegments(lines[li], limit)
    if (li === row) {
      const dcol = stringWidth(lines[li].slice(0, col))
      const starts = segmentStarts(lines[li], segments)
      // Map the logical column onto the visual rows: cursor positions in a
      // dropped fold space sit at the end of the preceding segment's row.
      let idx = segments.length - 1
      let vcol = 0
      for (let si = 0; si < segments.length; si++) {
        const w = stringWidth(segments[si])
        if (dcol < starts[si]) {
          idx = si - 1
          vcol = stringWidth(segments[si - 1])
          break
        }
        if (dcol < starts[si] + w) {
          idx = si
          vcol = dcol - starts[si]
          break
        }
      }
      if (idx === segments.length - 1 && dcol >= starts[idx] + stringWidth(segments[idx])) {
        vcol = dcol - starts[idx]
      }
      cursorRow = inputOffset + idx
      cursorCol = linePrefixWidth + vcol
    }
    inputOffset += wrappedCounts[li]
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
