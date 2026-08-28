import { classifyContexts, md, pendingTables, renderTableTokens, renderText, styleLine, tableRegionEnd } from './md-it.js'
import { wrapWords } from './wrap.js'
import stringWidth from 'string-width'

const PARTIAL_FLUSH_MS = 200

// Blocks that must keep their exact layout: code and horizontal rules are
// never re-flowed, the terminal's own soft-wrap handles the rare overflow.
const NO_WRAP_TYPES = new Set(['fence', 'code', 'hr'])

// Lines after which block classification is self-contained: paragraphs,
// lists, blockquotes and tables resolve at the previous blank line, and ATX
// headings and thematic breaks start fresh blocks. Code fences are handled
// separately (a close resets the block; an open must stay inside the window).
const BOUNDARY_RE = /^\s*$|^ {0,3}#{1,6}(?:\s|$)|^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})/

// Tail re-parse cap: a pathological stream with no blank line/heading break
// for thousands of lines (one giant paragraph/list) must not re-parse the
// whole text per line. Classification beyond the window is line-local, so
// the cap is invisible; fences/tables suppress it (they need full context).
const TAIL_WINDOW = 64

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function createMarkdownRenderer({ getSources = null, stdout = process.stdout, partialFlushMs = PARTIAL_FLUSH_MS } = {}) {
  const lines = []
  const emittedRows = []
  let emitted = 0
  let parseFrom = 0
  let buffer = ''
  let displayed = ''
  let displayedStyled = ''
  let displayedRows = 0
  let timer = null
  let tableOpen = false
  let lastTable = null
  // Incremental scan state for advanceParseFrom: every line is examined
  // exactly once, so the boundary/fence window advances in O(1) amortized
  // instead of re-scanning the whole document per line.
  let scanIdx = 0
  let scanFenceLines = 0
  let scanLastFenceLine = -1
  let scanLastOpenIndex = -1
  let scanBoundaryFrom = 0
  // Absolute line index of the opener of the fence the tail ends inside.
  // While set, subsequent lines are emitted as fence content without
  // re-parsing (dropped on a line that could close the fence).
  let openFence = -1
  // Persistent parse env so link reference definitions accumulate across
  // tail parses instead of being lost when the head of the text is skipped.
  const parseEnv = { sources: [] }

  const env = () => {
    parseEnv.sources = getSources ? getSources() : []
    return parseEnv
  }

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const terminalCols = () => (typeof stdout.columns === 'number' ? stdout.columns : null)

  // Display rows occupied by a line of the given width, counting the deferred-wrap
  // case where exactly cols*k chars end on the last column of row k-1.
  const lineRows = (width) => {
    const cols = terminalCols()
    if (!cols || width <= 0) return 1
    return width % cols === 0 ? width / cols : Math.floor(width / cols) + 1
  }

  // The cursor sits at the end of the displayed partial; rewind it to its start.
  const rewindToPartialStart = () => {
    if (displayedRows > 1) stdout.write(`\x1b[${displayedRows - 1}A`)
    stdout.write('\r')
  }

  // The cursor sits one row below the displayed line (its trailing newline was
  // emitted); rewind it to the line start.
  const rewindToLineStart = (rows) => {
    stdout.write(`\x1b[${rows}A\r`)
  }

  // Wrapping policy: prose blocks fold at word boundaries, fixed-layout blocks
  // (fences, code, hr) are emitted raw so their lines keep their shape. Without
  // a terminal width (pipes) nothing wraps and output stays byte-identical.
  const colsFor = (ctx) => {
    const cols = terminalCols()
    if (cols == null || (ctx != null && NO_WRAP_TYPES.has(ctx.type))) return null
    return cols
  }

  // Styled line → wrapped output: the segments joined by newlines and their
  // display rows (each segment's rows via the deferred-width math, so lines
  // that exactly fill a row or an over-wide atom are still counted right).
  const wrapStyled = (styled, ctx) => {
    const segments = wrapWords(styled, colsFor(ctx))
    return {
      text: segments.join('\n'),
      rows: segments.reduce((n, segment) => n + lineRows(stringWidth(segment)), 0),
    }
  }

  // Re-parsing the whole accumulated text on every line is O(n²) in the
  // answer length. Instead the window starts after the last line that resets
  // the block structure; the tail is re-parsed per line, keeping the common
  // multi-paragraph stream linear. The window never advances past un-emitted
  // lines (deferred table rows) or past a fence whose content is unresolved.
  const advanceParseFrom = () => {
    for (let i = scanIdx; i < lines.length; i++) {
      const line = lines[i]
      if (FENCE_RE.test(line)) {
        scanFenceLines++
        if (scanFenceLines % 2 === 1) scanLastOpenIndex = i
        scanLastFenceLine = i
        continue
      }
      if (BOUNDARY_RE.test(line)) scanBoundaryFrom = i + 1
    }
    scanIdx = lines.length
    // Fence content must be re-parsed together with its opening fence: while
    // the last fence is still open — or its closing line has not been emitted
    // yet — the window never advances past the opening fence.
    let from = scanBoundaryFrom
    if ((scanFenceLines % 2 === 1 || scanLastFenceLine >= emitted) && scanLastOpenIndex !== -1) {
      from = Math.min(from, scanLastOpenIndex)
    }
    parseFrom = Math.min(from, emitted)
  }

  // The buffer's classification depends on the completed lines before it, so
  // the tail (since the last boundary) is re-parsed on each partial restyle.
  // Inside an open fence the classification is constant, so no parse runs.
  const partialContext = () => {
    if (openFence !== -1 && !FENCE_RE.test(buffer)) {
      return { e: env(), ctx: { type: 'fence', quote: false } }
    }
    advanceParseFrom()
    // Same tail-window cap as processBatch: on a boundary-less stream a
    // partial restyle must not re-parse the whole accumulated text per tick.
    // (lines is empty on the very first partial line, hence the guard.)
    if (lines.length > 0 && openFence === -1 && scanLastOpenIndex === -1 && !lines[lines.length - 1].trimStart().startsWith('|')) {
      parseFrom = Math.min(Math.max(parseFrom, lines.length - TAIL_WINDOW), emitted)
    }
    const e = env()
    const tail = lines.slice(parseFrom)
    const text = buffer ? `${tail.join('\n')}${tail.length > 0 ? '\n' : ''}${buffer}` : tail.join('\n')
    const tokens = md.parse(text, e)
    return { e, ctx: classifyContexts(tokens, tail.length + (buffer ? 1 : 0))[tail.length] }
  }

  const redrawPartial = () => {
    if (tableOpen) return
    const { e, ctx } = partialContext()
    const styled = styleLine(buffer, ctx ?? { type: 'paragraph' }, e)
    const wrapped = wrapStyled(styled, ctx)
    if (displayed) {
      rewindToPartialStart()
      stdout.write('\x1b[J')
    }
    stdout.write(wrapped.text)
    displayed = buffer
    displayedStyled = wrapped.text
    displayedRows = wrapped.rows
  }

  const clearDisplayed = () => {
    if (displayed) {
      rewindToPartialStart()
      stdout.write('\x1b[J')
    }
    displayed = ''
    displayedStyled = ''
    displayedRows = 0
  }

  const emitLine = (i, ctx, e) => {
    clearDisplayed()
    if (ctx == null) {
      // Lines markdown-it leaves unmapped: whitespace-only lines still delimit
      // paragraphs (emit them raw), while link reference definitions
      // ([ref]: url) are consumed by markdown-it and must stay invisible.
      if (lines[i].trim() === '') stdout.write(`${lines[i]}\n`)
      emittedRows[i] = 1
      return
    }
    const wrapped = wrapStyled(styleLine(lines[i], ctx, e), ctx)
    stdout.write(`${wrapped.text}\n`)
    emittedRows[i] = wrapped.rows
  }

  // `start`/`end` are absolute line indices (rewind math); `relStart` is the
  // table's start within the parsed token window (renderTableTokens matches
  // token maps, which are relative to the window).
  const emitTable = (start, end, tokens, e, relStart = start) => {
    const tableStr = renderTableTokens(tokens, e, relStart)
    if (emitted > start) {
      rewindToLineStart(emittedRows[start] ?? 1)
      stdout.write('\x1b[J')
    }
    stdout.write(`${tableStr}\n`)
  }

  const processBatch = () => {
    if (emitted >= lines.length) return
    advanceParseFrom()
    // A held table re-emits its already-emitted header line, so the window
    // must still contain the table start while it is open.
    if (tableOpen && lastTable) parseFrom = Math.min(parseFrom, lastTable.start)

    // Open-fence fast path: while the tail ends inside a fence, every new
    // line is fence content — emit directly. A line that could close the
    // fence falls through so markdown-it resolves it.
    if (openFence !== -1) {
      if (!FENCE_RE.test(lines[lines.length - 1])) {
        const e = env()
        const ctx = { type: 'fence', quote: false }
        while (emitted < lines.length) {
          emitLine(emitted, ctx, e)
          emitted++
        }
        return
      }
      openFence = -1
    }

    // Cap the tail window for boundary-less stretches (giant paragraph/list).
    // Suppressed while a fence has ever been open (fence content must parse
    // with its opener) and on table-looking rows (an open table must parse
    // whole).
    if (openFence === -1 && scanLastOpenIndex === -1 && !lines[lines.length - 1].trimStart().startsWith('|')) {
      parseFrom = Math.min(Math.max(parseFrom, lines.length - TAIL_WINDOW), emitted)
    }

    const e = env()
    const tail = lines.slice(parseFrom)
    const tokens = md.parse(tail.join('\n'), e)

    // The tail's last block may be a fence. A fence whose block ends at the
    // tail length is either OPEN (content still streaming — enter the fast
    // path) or just CLOSED on the final line (closer matches its markup).
    // The closer on the last line also ends the token map at the tail
    // length, so the two are told apart by that match (a lone opener line
    // matching its own markup stays "open"). A verified close advances the
    // scan boundary past the block, so subsequent parses start after it.
    const lastToken = tokens[tokens.length - 1]
    if (lastToken?.type === 'fence' && lastToken.map?.[1] === tail.length) {
      const closerRe = new RegExp(`^ {0,3}${escapeRegExp(lastToken.markup)}+[ ]*$`)
      const closed = lastToken.map[1] - lastToken.map[0] >= 2 && closerRe.test(tail[tail.length - 1])
      if (!closed) {
        openFence = parseFrom + lastToken.map[0]
        const ctx = { type: 'fence', quote: false }
        while (emitted < lines.length) {
          emitLine(emitted, ctx, e)
          emitted++
        }
        return
      }
      // markdown-it verified the close: resync the scan heuristic (marker-
      // looking lines inside the fence throw its parity off) and advance the
      // boundary past the block.
      scanFenceLines = 0
      scanLastOpenIndex = -1
      scanLastFenceLine = -1
      scanBoundaryFrom = Math.max(scanBoundaryFrom, parseFrom + lastToken.map[1])
    }

    const ctxs = classifyContexts(tokens, tail.length)
    const tables = pendingTables(tokens, emitted - parseFrom)
    tableOpen = false
    let i = emitted
    for (const start of tables) {
      while (i < parseFrom + start) {
        emitLine(i, ctxs[i - parseFrom], e)
        emitted = i + 1
        i++
      }
      const end = tableRegionEnd(ctxs, start, tail.length)
      if (end === tail.length - 1) {
        tableOpen = true
        lastTable = { tokens, start: parseFrom + start, end: parseFrom + end, relStart: start }
        clearDisplayed()
        return
      }
      emitTable(parseFrom + start, parseFrom + end, tokens, e, start)
      emitted = parseFrom + end + 1
      i = emitted
    }
    while (i < lines.length) {
      emitLine(i, ctxs[i - parseFrom], e)
      emitted = i + 1
      i++
    }
  }

  const finalizePartial = () => {
    const { e, ctx } = partialContext()
    const styled = styleLine(buffer, ctx ?? { type: 'paragraph' }, e)
    const wrapped = wrapStyled(styled, ctx)
    if (displayed !== buffer || wrapped.text !== displayedStyled) {
      clearDisplayed()
      stdout.write(wrapped.text)
      displayed = buffer
      displayedStyled = wrapped.text
      displayedRows = wrapped.rows
    }
  }

  return {
    write(token) {
      buffer += token
      // Newlines can only occur in the appended token (the drained buffer
      // holds none), so one split handles all completed lines in O(chunk).
      const newlineIdx = buffer.indexOf('\n', buffer.length - token.length)
      if (newlineIdx !== -1) {
        const parts = buffer.split('\n')
        buffer = parts.pop()
        lines.push(...parts)
      }
      if (lines.length > emitted) processBatch()
      if (!buffer) {
        clearTimer()
        displayed = ''
        displayedStyled = ''
        displayedRows = 0
      } else if (!displayed) {
        redrawPartial()
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null
          redrawPartial()
        }, partialFlushMs).unref()
      }
    },
    flush() {
      clearTimer()
      if (tableOpen && lastTable) {
        if (buffer) {
          lines.push(buffer)
          buffer = ''
          clearDisplayed()
          processBatch()
        }
        // processBatch may have completed the table above; only re-emit it here
        // when it is still open (its final row was the last line of the text).
        if (tableOpen && lastTable) {
          emitTable(lastTable.start, lastTable.end, lastTable.tokens, env(), lastTable.relStart)
        }
      } else if (buffer) {
        finalizePartial()
      }
      buffer = ''
      displayed = ''
      displayedStyled = ''
      displayedRows = 0
      lines.length = 0
      emitted = 0
      emittedRows.length = 0
      parseFrom = 0
      tableOpen = false
      lastTable = null
      scanIdx = 0
      scanFenceLines = 0
      scanLastFenceLine = -1
      scanLastOpenIndex = -1
      scanBoundaryFrom = 0
      openFence = -1
    },
  }
}

export { renderText }
