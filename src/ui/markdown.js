import { styleText } from 'node:util'
import { THIN_SEP } from '../constants.js'
import { bold, dim, italic } from './style.js'
import { hyperlink } from './hyperlink.js'
import { stringWidth } from '../vendor/read-multiline/chars.js'

function citationMarkers(text, sources) {
  return text.replace(/\^(\d+(?:,\d+)*)\^/g, (_, indices) => (
    indices.split(',').map((n) => {
      const source = sources[Number(n) - 1]
      const marker = `[${n}]`
      return italic(source ? hyperlink(source.url, marker) || marker : marker)
    }).join(' ')
  ))
}

function inlineStyles(text, sources) {
  return text
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return styleText('cyan', part.slice(1, -1))
      let styled = part
        .replace(/\*\*([^*]+)\*\*/g, (_, m) => bold(m))
        .replace(/\*([^*]+)\*/g, (_, m) => styleText('italic', m))
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => dim(alt))
        .replace(/(?<!\x1b)\[([^\]]+)\]\(([^)]*)\)/g, (_, t, url) => italic(hyperlink(url, t) || t))
      if (sources.length > 0) {
        styled = citationMarkers(styled, sources)
      }
      return styled
    })
    .join('')
}

function styleLine(line, state, sources, partial = false) {
  if (/^\s*```/.test(line)) {
    // Partial lines must not toggle the fence state: the same partial buffer is
    // re-styled on every redraw, and toggling would flip inCodeBlock repeatedly.
    if (!partial) state.inCodeBlock = !state.inCodeBlock
    return dim(line)
  }
  if (state.inCodeBlock) return dim(line)
  if (/^\s*#{1,6}\s+/.test(line)) return bold(line)
  if (/^\s*[-*_]{3,}\s*$/.test(line)) return dim(THIN_SEP)
  const list = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/)
  if (list) return list[1] + inlineStyles(list[2], sources)
  if (/^\s*>/.test(line)) return dim(line)
  return inlineStyles(line, sources)
}

function createLineStyler(getSources) {
  const state = { inCodeBlock: false }
  return (line, { partial = false } = {}) => styleLine(line, state, getSources ? getSources() : [], partial)
}

const PARTIAL_FLUSH_MS = 200

export function createMarkdownRenderer({ getSources = null, stdout = process.stdout, partialFlushMs = PARTIAL_FLUSH_MS } = {}) {
  const styler = createLineStyler(getSources)
  let buffer = ''
  let displayed = ''
  let displayedWidth = 0
  let timer = null

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
  // displayedWidth is the visual width of the styled output on screen (markup is
  // consumed by styling, so the raw buffer width must not be used here).
  const rewindToPartialStart = () => {
    const rows = lineRows(displayedWidth)
    if (rows > 1) stdout.write(`\x1b[${rows - 1}A`)
    stdout.write('\r')
  }

  const redrawPartial = () => {
    if (displayed) {
      rewindToPartialStart()
      stdout.write('\x1b[J')
    }
    const styled = styler(buffer, { partial: true })
    stdout.write(styled)
    displayed = buffer
    displayedWidth = stringWidth(styled)
  }

  const flushCompleteLines = () => {
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl === -1) break
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (displayed) {
        // The completed line is already on screen as a partial; replace it with its
        // final styling (markup may have changed while the line was incomplete).
        rewindToPartialStart()
        stdout.write('\x1b[J')
      }
      stdout.write(`${styler(line)}\n`)
      displayed = ''
      displayedWidth = 0
    }
  }

  return {
    write(token) {
      buffer += token
      flushCompleteLines()
      if (!buffer) {
        clearTimer()
        displayed = ''
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
      if (buffer && displayed !== buffer) {
        if (displayed) {
          rewindToPartialStart()
          stdout.write('\x1b[J')
        }
        stdout.write(styler(buffer, { partial: true }))
      }
      buffer = ''
      displayed = ''
      displayedWidth = 0
    },
  }
}

export function renderText(text, sources = []) {
  const styler = createLineStyler(() => sources)
  return String(text ?? '')
    .split('\n')
    .map((line) => styler(line))
    .join('\n')
}
