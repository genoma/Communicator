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

function styleLine(line, state, sources) {
  if (/^\s*```/.test(line)) {
    state.inCodeBlock = !state.inCodeBlock
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
  return (line) => styleLine(line, state, getSources ? getSources() : [])
}

const PARTIAL_FLUSH_MS = 200

export function createMarkdownRenderer({ getSources = null, stdout = process.stdout, partialFlushMs = PARTIAL_FLUSH_MS } = {}) {
  const styler = createLineStyler(getSources)
  let buffer = ''
  let displayed = ''
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
  const rewindToPartialStart = () => {
    const rows = lineRows(stringWidth(displayed))
    if (rows > 1) stdout.write(`\x1b[${rows - 1}A`)
    stdout.write('\r')
  }

  const redrawPartial = () => {
    if (displayed) {
      rewindToPartialStart()
      stdout.write('\x1b[J')
    }
    stdout.write(styler(buffer))
    displayed = buffer
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
    }
  }

  return {
    write(token) {
      buffer += token
      flushCompleteLines()
      if (!buffer) {
        clearTimer()
        displayed = ''
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
        stdout.write(styler(buffer))
      }
      buffer = ''
      displayed = ''
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
