import { classifyContexts, md, pendingTables, renderTableTokens, renderText, styleLine, tableRegionEnd } from './md-it.js'
import stringWidth from 'string-width'

const PARTIAL_FLUSH_MS = 200

// Lines after which block classification is self-contained: paragraphs,
// lists, blockquotes and tables resolve at the previous blank line, and ATX
// headings and thematic breaks start fresh blocks. Code fences are handled
// separately (a close resets the block; an open must stay inside the window).
const BOUNDARY_RE = /^\s*$|^ {0,3}#{1,6}(?:\s|$)|^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})/

export function createMarkdownRenderer({ getSources = null, stdout = process.stdout, partialFlushMs = PARTIAL_FLUSH_MS } = {}) {
  const lines = []
  const emittedWidths = []
  let emitted = 0
  let parseFrom = 0
  let buffer = ''
  let displayed = ''
  let displayedStyled = ''
  let displayedWidth = 0
  let timer = null
  let tableOpen = false
  let lastTable = null
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

  // The cursor sits at the end of the displayed partial line; rewind it to the start.
  const rewindToPartialStart = () => {
    const rows = lineRows(displayedWidth)
    if (rows > 1) stdout.write(`\x1b[${rows - 1}A`)
    stdout.write('\r')
  }

  // The cursor sits one row below the displayed line (its trailing newline was
  // emitted); rewind it to the line start.
  const rewindToLineStart = (width) => {
    stdout.write(`\x1b[${lineRows(width)}A\r`)
  }

  // Re-parsing the whole accumulated text on every line is O(n²) in the
  // answer length. Instead the window starts after the last line that resets
  // the block structure; the tail is re-parsed per line, keeping the common
  // multi-paragraph stream linear. The window never advances past un-emitted
  // lines (deferred table rows) or past a fence whose content is unresolved.
  const advanceParseFrom = () => {
    let from = 0
    let fenceLines = 0
    let lastFenceLine = -1
    let lastOpenIndex = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (FENCE_RE.test(line)) {
        fenceLines++
        if (fenceLines % 2 === 1) lastOpenIndex = i
        lastFenceLine = i
        continue
      }
      if (BOUNDARY_RE.test(line)) from = i + 1
    }
    // Fence content must be re-parsed together with its opening fence: while
    // the last fence is still open — or its closing line has not been emitted
    // yet — the window never advances past the opening fence.
    if ((fenceLines % 2 === 1 || lastFenceLine >= emitted) && lastOpenIndex !== -1) {
      from = Math.min(from, lastOpenIndex)
    }
    parseFrom = Math.min(from, emitted)
  }

  // The buffer's classification depends on the completed lines before it, so
  // the tail (since the last boundary) is re-parsed on each partial restyle.
  const partialContext = () => {
    advanceParseFrom()
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
    if (displayed) {
      rewindToPartialStart()
      stdout.write('\x1b[J')
    }
    stdout.write(styled)
    displayed = buffer
    displayedStyled = styled
    displayedWidth = stringWidth(styled)
  }

  const clearDisplayed = () => {
    if (displayed) {
      rewindToPartialStart()
      stdout.write('\x1b[J')
    }
    displayed = ''
    displayedStyled = ''
    displayedWidth = 0
  }

  const emitLine = (i, ctx, e) => {
    clearDisplayed()
    if (ctx == null) {
      // Lines markdown-it leaves unmapped: whitespace-only lines still delimit
      // paragraphs (emit them raw), while link reference definitions
      // ([ref]: url) are consumed by markdown-it and must stay invisible.
      if (lines[i].trim() === '') stdout.write(`${lines[i]}\n`)
      emittedWidths[i] = 0
      return
    }
    const styled = styleLine(lines[i], ctx, e)
    stdout.write(`${styled}\n`)
    emittedWidths[i] = stringWidth(styled)
  }

  // `start`/`end` are absolute line indices (rewind math); `relStart` is the
  // table's start within the parsed token window (renderTableTokens matches
  // token maps, which are relative to the window).
  const emitTable = (start, end, tokens, e, relStart = start) => {
    const tableStr = renderTableTokens(tokens, e, relStart)
    if (emitted > start) {
      rewindToLineStart(emittedWidths[start] ?? 0)
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
    const e = env()
    const tail = lines.slice(parseFrom)
    const tokens = md.parse(tail.join('\n'), e)
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
    if (displayed !== buffer || styled !== displayedStyled) {
      clearDisplayed()
      stdout.write(styled)
      displayed = buffer
      displayedStyled = styled
      displayedWidth = stringWidth(styled)
    }
  }

  return {
    write(token) {
      buffer += token
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
      if (lines.length > emitted) processBatch()
      if (!buffer) {
        clearTimer()
        displayed = ''
        displayedStyled = ''
        displayedWidth = 0
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
      displayedWidth = 0
      lines.length = 0
      emitted = 0
      emittedWidths.length = 0
      parseFrom = 0
      tableOpen = false
      lastTable = null
    },
  }
}

export { renderText }
