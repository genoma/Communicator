// Paint kernel: the editor owns a shadow grid (the exact rows it last wrote)
// and repaints only the difference between the shadow and the target grid.
// All writes are batched into one write with the cursor hidden. Cursor-relative
// math is replaced by grid-relative moves, so a repaint is correct whenever the
// terminal shows the shadow — recoveries from reflow (resize) rerun the whole
// grid through the rebuild/absolute paths instead.
import { stringWidth } from './chars.js'

function batchText(out, body) {
  return out.write('\x1b[?25l' + body + '\x1b[?25h')
}

/** Index of the first row where the grids differ, or -1 when identical */
export function firstDiffRow(shadowRows, targetRows) {
  const n = Math.min(shadowRows.length, targetRows.length)
  for (let i = 0; i < n; i++) {
    if (shadowRows[i] !== targetRows[i]) return i
  }
  return shadowRows.length === targetRows.length ? -1 : n
}

/**
 * Row-by-row serialization (trailing erase per row). A row that fills the
 * terminal exactly must NOT be followed by erase-to-EOL: the terminal parks the
 * cursor on the last cell after writing it (right-margin wrap-pending), and
 * erase-to-EOL includes the cursor cell — a trailing erase would eat the row's
 * last letter.
 */
export function rowBody(rows, width) {
  let body = ''
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    body += row
    if (stringWidth(row) < width) body += '\x1b[K'
    if (i < rows.length - 1) body += '\r\n'
  }
  return body
}

/** Position the cursor given the physical cursor is after the last grid row */
function rewindCursor(body, grid) {
  const rowsAfter = grid.rows.length - 1 - grid.cursor.r
  if (rowsAfter > 0) body += `\x1b[${rowsAfter}A`
  body += `\x1b[${grid.cursor.c + 1}G`
  return body
}

/**
 * Initial/rebuild paint: writes the grid sequentially from the current cursor
 * position (no rewind — nothing is known about the screen above). With a
 * `hook` the screen is wiped first, the hook rebuilds the transcript, and the
 * block is drawn after it (synchronized output).
 */
export function paintSequential(out, grid, hook) {
  const sync = Boolean(hook)
  if (sync) {
    out.write('\x1b[?2026h')
    out.write('\x1b[2J')
    out.write('\x1b[3J')
    out.write('\x1b[H')
    hook()
  }
  batchText(out, rewindCursor('\x1b[J\r' + rowBody(grid.rows, grid.width), grid))
  if (sync) out.write('\x1b[?2026l')
}

/**
 * Forward (bottom-anchored) repaint: clears everything below the current
 * cursor line, then writes the full grid forward, letting the terminal scroll
 * stale content above into the scrollback. Used when the grid is taller than
 * the viewport or after a silent bulk paste whose screen state is unknown.
 */
export function paintForward(out, grid) {
  batchText(out, rewindCursor('\x1b[J\r' + rowBody(grid.rows, grid.width), grid))
}

/**
 * In-place diff repaint: rewinds to the first changed row and rewrites it
 * downward. The screen must show the shadow grid exactly.
 */
export function paintDiff(out, shadow, grid) {
  const firstDiff = firstDiffRow(shadow.rows, grid.rows)
  if (firstDiff === -1) {
    const dr = grid.cursor.r - shadow.cursor.r
    let body = ''
    if (dr < 0) body += `\x1b[${-dr}A`
    else if (dr > 0) body += `\x1b[${dr}B`
    body += `\x1b[${grid.cursor.c + 1}G`
    batchText(out, body)
    return
  }
  let body = ''
  const dr = shadow.cursor.r - firstDiff
  if (dr < 0) body += `\x1b[${-dr}B`
  else if (dr > 0) body += `\x1b[${dr}A`
  body += '\r'
  // Erase-from-cursor first: it must never run after the last painted row,
  // or it erases the last cell of a row that fills the terminal exactly.
  if (grid.rows.length < shadow.rows.length) body += '\x1b[J'
  body += rowBody(grid.rows.slice(firstDiff), grid.width)
  // A shrink that removed every row from the diff down (the tail was
  // deleted) writes nothing, so the cursor still sits on the old shadow
  // row, past the new grid's last row: climb back so the rewind math
  // (physical cursor = last grid row) holds. helpFooter keeps a footer row
  // and masks this — a regression test pins the footerless case.
  if (grid.rows.length <= firstDiff) {
    const up = firstDiff - (grid.rows.length - 1)
    if (up > 0) body += `\x1b[${up}A`
  }
  batchText(out, rewindCursor(body, grid))
}

/**
 * Absolute repaint after a reflow: the block top is at the reported viewport
 * row, so every row and the cursor are positioned absolutely.
 */
export function paintAbsolute(out, grid, blockTopRow) {
  let body = `\x1b[${blockTopRow + 1};1H\x1b[J`
  body += rowBody(grid.rows, grid.width)
  body += `\x1b[${blockTopRow + grid.cursor.r + 1};${grid.cursor.c + 1}H`
  batchText(out, body)
}

/**
 * In-place full rewrite of the block from its top row (paste/submit repaint,
 * Ctrl+L, DSR fallback): rewinds to the block top and rewrites every row even
 * when the grids are identical, so screen junk in the block area is removed.
 */
export function paintRefresh(out, grid, rewindRow = grid.cursor.r) {
  let body = ''
  if (rewindRow > 0) body += `\x1b[${rewindRow}A`
  body += '\r\x1b[J'
  body += rowBody(grid.rows, grid.width)
  batchText(out, rewindCursor(body, grid))
}

/**
 * Submit-render rewrite (unbatched):
 * rewinds to the block top and rewrites every row in the submitted style.
 */
export function paintSubmit(out, grid) {
  let body = ''
  if (grid.cursor.r > 0) body += `\x1b[${grid.cursor.r}A`
  body += '\r\x1b[J'
  body += rowBody(grid.rows, grid.width)
  out.write(rewindCursor(body, grid))
}

/** Erase the whole editor block in place (cancel / EOF) */
export function paintErase(out, grid) {
  let body = ''
  if (grid.cursor.r > 0) body += `\x1b[${grid.cursor.r}A`
  body += '\r\x1b[J'
  batchText(out, body)
}
