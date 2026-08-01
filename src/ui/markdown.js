import { styleText } from 'node:util'
import { THIN_SEP } from '../constants.js'
import { bold, dim } from './style.js'
import { hyperlink } from './hyperlink.js'

function citationMarkers(text, sources) {
  return text.replace(/\^(\d+(?:,\d+)*)\^/g, (_, indices) => (
    indices.split(',').map((n) => {
      const source = sources[Number(n) - 1]
      return source ? hyperlink(source.url, `[${n}]`) || `[${n}]` : `[${n}]`
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
        .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_, t, url) => hyperlink(url, t) || styleText('cyan', t))
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

export function createMarkdownRenderer({ getSources = null } = {}) {
  const styler = createLineStyler(getSources)
  let buffer = ''

  return {
    write(token) {
      buffer += token
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) return
        process.stdout.write(`${styler(buffer.slice(0, nl))}\n`)
        buffer = buffer.slice(nl + 1)
      }
    },
    flush() {
      if (buffer) {
        process.stdout.write(styler(buffer))
        buffer = ''
      }
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
