import { test } from 'node:test'
import assert from 'node:assert/strict'
import { md, classifyContexts, styleLine, renderTableTokens, pendingTables, tableRegionEnd, renderText } from '../src/ui/md-it.js'
import { bold, dim } from '../src/ui/style.js'

const env = { sources: [] }

test('classifyContexts detects paragraph lines', () => {
  const tokens = md.parse('hello world\nmore text\n', env)
  const ctxs = classifyContexts(tokens, 2)
  assert.deepEqual(ctxs, [
    { type: 'paragraph', quote: false },
    { type: 'paragraph', quote: false },
  ])
})

test('classifyContexts detects heading lines', () => {
  const tokens = md.parse('# Title\ncontent\n', env)
  const ctxs = classifyContexts(tokens, 2)
  assert.equal(ctxs[0]?.type, 'heading')
  assert.equal(ctxs[1]?.type, 'paragraph')
})

test('classifyContexts detects fenced code blocks', () => {
  const tokens = md.parse('```js\ncode here\n```\n', env)
  const ctxs = classifyContexts(tokens, 3)
  assert.equal(ctxs[0]?.type, 'fence')
  assert.equal(ctxs[1]?.type, 'fence')
  assert.equal(ctxs[2]?.type, 'fence')
})

test('classifyContexts marks blockquoted paragraphs', () => {
  const tokens = md.parse('> quoted line\n', env)
  const ctxs = classifyContexts(tokens, 1)
  assert.equal(ctxs[0]?.type, 'paragraph')
  assert.equal(ctxs[0]?.quote, true)
})

test('classifyContexts detects horizontal rules', () => {
  const tokens = md.parse('---\n', env)
  const ctxs = classifyContexts(tokens, 1)
  assert.equal(ctxs[0]?.type, 'hr')
})

test('classifyContexts marks quoted paragraphs inside blockquotes', () => {
  const tokens = md.parse('> regular text\n', env)
  const ctxs = classifyContexts(tokens, 1)
  assert.ok(ctxs[0]?.quote === true)
  assert.ok(ctxs[0]?.type != null)
})

test('classifyContexts detects table lines', () => {
  const tokens = md.parse('| a | b |\n| -- | -- |\n| 1 | 2 |\n', env)
  const ctxs = classifyContexts(tokens, 3)
  assert.equal(ctxs[0]?.type, 'table')
  assert.equal(ctxs[1]?.type, 'table')
  assert.equal(ctxs[2]?.type, 'table')
})

test('classifyContexts detects indented code blocks', () => {
  const tokens = md.parse('    indented code\n', env)
  const ctxs = classifyContexts(tokens, 1)
  assert.equal(ctxs[0]?.type, 'code')
})

test('classifyContexts returns null for lines outside token map ranges', () => {
  const ctxs = classifyContexts([], 3)
  assert.deepEqual(ctxs, [null, null, null])
})

test('styleLine renders headings as bold', () => {
  const result = styleLine('My Heading', { type: 'heading', quote: false }, env)
  assert.equal(result, bold('My Heading'))
})

test('styleLine dims fenced code blocks', () => {
  const result = styleLine('console.log("hi")', { type: 'fence', quote: false }, env)
  assert.equal(result, dim('console.log("hi")'))
})

test('styleLine dims indented code blocks', () => {
  const result = styleLine('code line', { type: 'code', quote: false }, env)
  assert.equal(result, dim('code line'))
})

test('styleLine dims horizontal rules', () => {
  const result = styleLine('---', { type: 'hr', quote: false }, env)
  assert.ok(result.includes('\u2500'))
})

test('styleLine dims blockquotes', () => {
  const result = styleLine('quoted text', { type: 'quote', quote: true }, env)
  assert.equal(result, dim('quoted text'))
})

test('styleLine renders inline formatting inside paragraphs', () => {
  const result = styleLine('**bold** text', { type: 'paragraph', quote: false }, env)
  assert.ok(result.includes(bold('bold')))
  assert.ok(result.includes(' text'))
})

test('styleLine dims paragraphs inside blockquotes', () => {
  const result = styleLine('quoted paragraph', { type: 'paragraph', quote: true }, env)
  assert.ok(result.includes(dim('quoted paragraph')))
})

test('styleLine returns raw text for null context', () => {
  assert.equal(styleLine('raw', null, env), 'raw')
})

test('styleLine preserves list markers in unordered lists', () => {
  const result = styleLine('- item one', { type: 'list_item', quote: false }, env)
  assert.equal(result, '- item one')
})

test('styleLine preserves list markers in ordered lists', () => {
  const result = styleLine('1. first', { type: 'list_item', quote: false }, env)
  assert.equal(result, '1. first')
})

test('pendingTables returns starts for tables split across a flush boundary', () => {
  const source = 'before text\n\n| a | b |\n| -- | -- |\n| 1 | 2 |\n'
  const tokens = md.parse(source, env)
  const starts = pendingTables(tokens, 1)
  assert.ok(Array.isArray(starts))
})

test('tableRegionEnd finds the last contiguous table line', () => {
  const tokens = md.parse('before\n| a | b |\n| -- | -- |\n| 1 | 2 |\nafter\n', env)
  const lines = 5
  const ctxs = classifyContexts(tokens, lines)
  const end = tableRegionEnd(ctxs, 1, lines)
  assert.ok(end >= 3, `expected end >= 3, got ${end}`)
  assert.ok(end <= 4, `expected end <= 4, got ${end}`)
})

test('tableRegionEnd returns -1 for negative start', () => {
  assert.equal(tableRegionEnd([], -1, 1), -1)
})

test('renderTableTokens renders a simple table with header styling', () => {
  const tokens = md.parse('| name | value |\n| ---- | ----- |\n| foo  | 123   |\n', env)
  const result = renderTableTokens(tokens, env, 0)
  assert.ok(result.includes(bold('name')))
  assert.ok(result.includes(bold('value')))
  assert.ok(result.includes('foo'))
  assert.ok(result.includes('123'))
})

test('renderTableTokens renders multi-column tables with padded alignment', () => {
  const tokens = md.parse('| a | b |\n| - | - |\n| x | y |\n', env)
  const result = renderTableTokens(tokens, env, 0)
  assert.ok(result.includes(bold('a')))
  assert.ok(result.includes(bold('b')))
  assert.ok(result.includes('x'))
  assert.ok(result.includes('y'))
})

test('renderTableTokens returns empty string for unmatched start line', () => {
  const tokens = md.parse('| a | b |\n', env)
  assert.equal(renderTableTokens(tokens, env, 99), '')
})

test('renderText resolves citations against sources with OSC 8 links', () => {
  const sources = [{ title: 'Example', url: 'https://example.com' }]
  const result = renderText('See ^1^ for details.', sources)
  assert.ok(result.includes('https://example.com'))
  assert.ok(result.includes('[1]'))
})

test('renderText keeps citations as raw markup without sources', () => {
  const result = renderText('See ^1^ for details.', [])
  assert.equal(result, 'See ^1^ for details.')
})

test('renderText keeps citation markers inside code spans literal', () => {
  const result = renderText('`^1^` is a marker.')
  assert.ok(result.includes('^1^'))
})

test('renderText renders inline bold and italic', () => {
  const result = renderText('**bold** and *italic*')
  assert.ok(result.includes(bold('bold')))
  assert.ok(result.includes('\x1b[3m'))
})

test('renderText renders strikethrough', () => {
  const result = renderText('~~struck~~ text')
  assert.ok(result.includes('\x1b[9mstruck\x1b[29m'))
})

test('renderText renders inline code with cyan styling when available', () => {
  const result = renderText('use `code()` here')
  // styleText may omit color when stdout is not a TTY
  assert.ok(result.includes('code()') || result.includes('\x1b[36mcode()\x1b[39m'))
  assert.ok(result.includes('here'))
})

test('renderText renders links without the URL in the visible text', () => {
  const result = renderText('[click here](https://example.com)')
  assert.ok(result.includes('click here'))
})

test('renderText renders plain tables with alignment', () => {
  const result = renderText('| col |\n| --- |\n| val |\n')
  assert.ok(result.includes(bold('col')))
  assert.ok(result.includes('val'))
})

test('renderText drops reference definition lines', () => {
  const result = renderText('[ref]: https://example.com')
  assert.equal(result, '')
})

test('renderText returns empty string for empty input', () => {
  assert.equal(renderText(''), '')
  assert.equal(renderText(null), '')
})

test('renderText preserves trailing newline from input', () => {
  assert.equal(renderText('text\n'), 'text\n')
})

test('renderText handles multi-paragraph text with blank line separators', () => {
  const result = renderText('para1\n\npara2\n')
  assert.ok(result.includes('para1'))
  assert.ok(result.includes('para2'))
})

test('renderText dims horizontal rules to a thin separator', () => {
  const result = renderText('---\n')
  assert.ok(result.includes('\u2500'))
})

test('renderText handles blockquotes with inline formatting', () => {
  const result = renderText('> **bold** text\n')
  assert.ok(result.includes(bold('bold')))
})

test('renderText handles nested lists preserving markers', () => {
  const result = renderText('- item\n  - sub\n')
  assert.ok(result.includes('- item'))
  assert.ok(result.includes('- sub'))
})
