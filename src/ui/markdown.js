import { classifyContexts, md, pendingTables, renderTableTokens, renderText, styleLine, tableRegionEnd } from './md-it.js'
import stringWidth from 'string-width'

const PARTIAL_FLUSH_MS = 200

export function createMarkdownRenderer({ getSources = null, stdout = process.stdout, partialFlushMs = PARTIAL_FLUSH_MS } = {}) {
  const lines = []
  const emittedWidths = []
  let emitted = 0
  let buffer = ''
  let displayed = ''
  let displayedStyled = ''
  let displayedWidth = 0
  let timer = null
  let tableOpen = false
  let lastTable = null

  const env = () => ({ sources: getSources ? getSources() : [] })

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

  const redrawPartial = () => {
    if (tableOpen) return
    const e = env()
    const text = lines.length > 0 ? `${lines.join('\n')}\n${buffer}` : buffer
    const tokens = md.parse(text, e)
    const ctxs = classifyContexts(tokens, lines.length + 1)
    const ctx = ctxs[lines.length]
    const styled = ctx ? styleLine(buffer, ctx, e) : styleLine(buffer, { type: 'paragraph' }, e)
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
    if (ctx == null && lines[i] !== '') {
      emittedWidths[i] = 0
      return
    }
    const styled = ctx ? styleLine(lines[i], ctx, e) : lines[i]
    stdout.write(`${styled}\n`)
    emittedWidths[i] = stringWidth(styled)
  }

  const emitTable = (start, end, tokens, e) => {
    const tableStr = renderTableTokens(tokens, e, start)
    if (emitted > start) {
      rewindToLineStart(emittedWidths[start] ?? 0)
      stdout.write('\x1b[J')
    }
    stdout.write(`${tableStr}\n`)
  }

  const processBatch = () => {
    if (emitted >= lines.length) return
    const e = env()
    const tokens = md.parse(lines.join('\n'), e)
    const ctxs = classifyContexts(tokens, lines.length)
    const tables = pendingTables(tokens, emitted)
    tableOpen = false
    let i = emitted
    for (const start of tables) {
      while (i < start) {
        emitLine(i, ctxs[i], e)
        emitted = i + 1
        i++
      }
      const end = tableRegionEnd(ctxs, start, lines.length)
      if (end === lines.length - 1) {
        tableOpen = true
        lastTable = { tokens, start, end }
        clearDisplayed()
        return
      }
      emitTable(start, end, tokens, e)
      emitted = end + 1
      i = emitted
    }
    while (i < lines.length) {
      emitLine(i, ctxs[i], e)
      emitted = i + 1
      i++
    }
  }

  const finalizePartial = () => {
    const e = env()
    const text = lines.length > 0 ? `${lines.join('\n')}\n${buffer}` : buffer
    const tokens = md.parse(text, e)
    const ctxs = classifyContexts(tokens, lines.length + 1)
    const ctx = ctxs[lines.length]
    const styled = ctx ? styleLine(buffer, ctx, e) : buffer
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
        }, partialFlushMs)
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
        if (tableOpen && lastTable) {
          emitTable(lastTable.start, lastTable.end, lastTable.tokens, env())
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
      tableOpen = false
      lastTable = null
    },
  }
}

export { renderText }
