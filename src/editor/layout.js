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
 * display columns. Wide characters never split across segments; a wide char
 * that would not fit starts the next segment.
 */
export function wrapSegments(text, limit) {
  const segments = []
  let current = ''
  let cw = 0
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0))
    if (cw + w > limit) {
      segments.push(current)
      current = ch
      cw = w
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
      let idx = segments.length - 1
      let covered = 0
      for (let si = 0; si < segments.length; si++) {
        const w = stringWidth(segments[si])
        if (dcol < covered + w) {
          idx = si
          break
        }
        covered += w
      }
      let before = 0
      for (let si = 0; si < idx; si++) before += stringWidth(segments[si])
      cursorRow = inputOffset + idx
      cursorCol = linePrefixWidth + (dcol - before)
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
  return { rows, cursor: { r: cursorRow, c: cursorCol } }
}
