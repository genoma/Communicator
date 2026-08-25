import MarkdownIt from 'markdown-it'
import { styleText } from 'node:util'
import { THIN_SEP, CITATION_GROUP } from '../constants.js'
import { bold, dim, italic } from './style.js'
import { hyperlink, sanitizeAnsi } from './hyperlink.js'
import { wrapWords } from './wrap.js'
import stringWidth from 'string-width'

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false })

// Setext headings would reclassify already-emitted lines when the underline
// line arrives; LLM output uses '#' headings, so disable them to keep the
// per-line streaming stable.
md.block.ruler.disable('lheading')

const SGR = {
  italic: ['\x1b[3m', '\x1b[23m'],
  bold: ['\x1b[1m', '\x1b[22m'],
  strike: ['\x1b[9m', '\x1b[29m'],
}

const LIST_MARKER = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/
// Sticky so the rule can match at state.pos without slicing the remaining
// source per caret (the slice was O(n) per ^ character).
const CITATION = new RegExp(`\\^${CITATION_GROUP}\\^`, 'y')

md.inline.ruler.after('backticks', 'citation', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x5e) return false
  CITATION.lastIndex = state.pos
  const m = CITATION.exec(state.src)
  if (!m) return false
  if (!silent) {
    const token = state.push('citation', '', 0)
    token.content = m[1]
    token.markup = m[0]
  }
  state.pos += m[0].length
  return true
})

const INLINE_RULES = {
  text: (t) => sanitizeAnsi(t.content),
  code_inline: (t) => styleText('cyan', sanitizeAnsi(t.content)),
  em_open: () => SGR.italic[0],
  em_close: () => SGR.italic[1],
  strong_open: () => SGR.bold[0],
  strong_close: () => SGR.bold[1],
  s_open: () => SGR.strike[0],
  s_close: () => SGR.strike[1],
  image: (t) => dim(sanitizeAnsi(t.content)),
  softbreak: () => '\n',
  hardbreak: () => '\n',
  html_inline: (t) => sanitizeAnsi(t.content),
  entity: (t) => sanitizeAnsi(t.content),
  citation: (t, env) => {
    const sources = env.sources
    if (!sources || sources.length === 0) return t.markup
    return t.content.split(',').map((n) => {
      const source = sources[Number(n) - 1]
      const marker = `[${n}]`
      return italic(source && source.url ? hyperlink(source.url, marker) || marker : marker)
    }).join(' ')
  },
}

function renderInlineTokens(tokens, env) {
  let out = ''
  const links = []
  for (const t of tokens) {
    if (t.type === 'link_open') {
      links.push({ href: t.attrGet('href'), at: out.length })
      continue
    }
    if (t.type === 'link_close') {
      const { href, at } = links.pop()
      const label = out.slice(at)
      out = out.slice(0, at) + italic(href ? hyperlink(href, label) || label : label)
      continue
    }
    const rule = INLINE_RULES[t.type]
    if (rule) out += rule(t, env)
  }
  return out
}

function renderInlineText(text, env) {
  const tokens = []
  md.inline.parse(text, md, env, tokens)
  return renderInlineTokens(tokens, env)
}

export function classifyContexts(tokens, lineCount) {
  const ctxs = new Array(lineCount).fill(null)
  let quote = 0
  const fill = (t, type) => {
    if (!t.map) return
    const [a, b] = t.map
    for (let i = a; i < b && i < lineCount; i++) {
      ctxs[i] = { type, quote: quote > 0 }
    }
  }
  for (const t of tokens) {
    switch (t.type) {
      case 'blockquote_open': fill(t, 'quote'); quote++; break
      case 'blockquote_close': quote--; break
      case 'bullet_list_open':
      case 'ordered_list_open': fill(t, 'list'); break
      case 'bullet_list_close':
      case 'ordered_list_close': break
      case 'list_item_open': fill(t, 'list_item'); break
      case 'fence': fill(t, 'fence'); break
      case 'code_block': fill(t, 'code'); break
      case 'hr': fill(t, 'hr'); break
      case 'heading_open': fill(t, 'heading'); break
      case 'paragraph_open': fill(t, 'paragraph'); break
      case 'table_open': fill(t, 'table'); break
      case 'html_block': fill(t, 'paragraph'); break
    }
  }
  return ctxs
}

export function pendingTables(tokens, from) {
  const starts = []
  for (const t of tokens) {
    if (t.type === 'table_open' && t.map && t.map[1] > from) starts.push(t.map[0])
  }
  return starts
}

export function tableRegionEnd(ctxs, start, lineCount) {
  if (start < 0) return -1
  let end = start
  for (let i = start + 1; i < lineCount; i++) {
    if (ctxs[i]?.type === 'table') end = i
    else break
  }
  return end
}

export function styleLine(raw, ctx, env) {
  if (ctx == null) return raw
  const safe = sanitizeAnsi(raw)
  switch (ctx.type) {
    case 'fence':
    case 'code':
      return dim(safe)
    case 'hr':
      return dim(THIN_SEP)
    case 'heading':
      return bold(safe)
    case 'quote':
      return dim(safe)
    default: {
      const m = safe.match(LIST_MARKER)
      const styled = m ? m[1] + renderInlineText(m[2], env) : renderInlineText(safe, env)
      return ctx.quote ? dim(styled) : styled
    }
  }
}

export function renderTableTokens(tokens, env, start) {
  const i = tokens.findIndex((t) => t.type === 'table_open' && t.map?.[0] === start)
  if (i === -1) return ''
  const rows = []
  let cells = null
  let header = false
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]
    if (t.type === 'table_close') break
    if (t.type === 'thead_open') header = true
    else if (t.type === 'tbody_open') header = false
    else if (t.type === 'tr_open') cells = []
    else if (t.type === 'tr_close') {
      if (cells) rows.push({ cells, header })
      cells = null
    } else if ((t.type === 'th_open' || t.type === 'td_open') && cells) {
      const inline = tokens[j + 1]
      cells.push(inline && inline.type === 'inline' ? renderInlineTokens(inline.children, env) : '')
    }
  }
  const colCount = Math.max(0, ...rows.map((r) => r.cells.length))
  const widths = new Array(colCount).fill(0)
  for (const r of rows) {
    for (let c = 0; c < colCount; c++) {
      if (r.cells[c]) widths[c] = Math.max(widths[c], stringWidth(r.cells[c]))
    }
  }
  const padCell = (text, width) => text + ' '.repeat(Math.max(0, width - stringWidth(text)))
  const rowString = (cells, isHeader) => {
    const padded = []
    for (let c = 0; c < colCount; c++) {
      const cell = isHeader ? bold(cells[c] ?? '') : cells[c] ?? ''
      padded.push(c < colCount - 1 ? padCell(cell, widths[c]) : cell)
    }
    return padded.join('  ')
  }
  const out = []
  rows.forEach((r, idx) => {
    if (idx === 0) out.push(rowString(r.cells, true))
    else out.push(rowString(r.cells, false))
  })
  if (out.length > 0) out.splice(1, 0, widths.map((w) => dim('-'.repeat(Math.max(3, w)))).join('  '))
  return out.join('\n')
}

// Same wrap policy as the streaming renderer: prose blocks fold at word
// boundaries; code, fences and separators keep their exact layout. Without a
// terminal width nothing wraps (pipes keep byte-identical output).
const wrapForCtx = (styled, ctx, cols) => {
  if (!(cols > 0) || ctx == null || ctx.type === 'fence' || ctx.type === 'code' || ctx.type === 'hr') return styled
  return wrapWords(styled, cols).join('\n')
}

export function renderText(text, sources = [], cols = null) {
  const raw = String(text ?? '')
  if (raw === '') return ''
  const lines = raw.split('\n')
  const env = { sources }
  const tokens = md.parse(raw, env)
  const ctxs = classifyContexts(tokens, lines.length)
  const out = []
  let i = 0
  while (i < lines.length) {
    const ctx = ctxs[i]
    if (ctx && ctx.type === 'table') {
      const end = tableRegionEnd(ctxs, i, lines.length)
      out.push(renderTableTokens(tokens, env, i))
      i = end + 1
      continue
    }
    if (ctx == null && lines[i].trim() !== '') {
      i++
      continue
    }
    out.push(wrapForCtx(styleLine(lines[i], ctx, env), ctx, cols))
    i++
  }
  return out.join('\n')
}
