// assertions intentionally match ANSI-rendered output
/* eslint-disable no-control-regex, no-regex-spaces */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMarkdownRenderer, renderText } from '../src/ui/markdown.js'
import { createStreamRenderer } from '../src/ui/stream.js'
import { THIN_SEP } from '../src/constants.js'

const ANSI = /\x1b\[[0-9;]*m/g
const OSC8 = /\x1b\]8;;[^\x1b]*\x1b\\|\x1b\]8;;\x1b\\/g
const plain = (s) => s.replace(ANSI, '').replace(OSC8, '')

function enableAnsi(t) {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  process.stdout.getColorDepth = () => 8
  t.after(() => {
    delete process.stdout.getColorDepth
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  })
}

function captureStdout(t) {
  enableAnsi(t)
  const chunks = []
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  t.after(() => {
    process.stdout.write = realWrite
  })
  return () => chunks.join('')
}

test('renderText styles inline elements and drops link urls', (t) => {
  enableAnsi(t)
  const out = renderText('**bold** and *italic* and `code` and [link](https://x.com) and ![alt](img.png)')
  const plain = out.replace(ANSI, '').replace(OSC8, '')
  assert.equal(plain, 'bold and italic and code and link and alt')
  assert.match(out, /\x1b\[1mbold\x1b\[22m/)
  assert.match(out, /\x1b\[3mitalic\x1b\[23m/)
  assert.match(out, /\x1b\[36mcode\x1b\[39m/)
  assert.match(out, /\x1b\[3m\x1b\]8;;https:\/\/x\.com\x1b\\link\x1b\]8;;\x1b\\\x1b\[23m/)
  assert.match(out, /\x1b\[2malt\x1b\[22m/)
})

test('renderText drops link reference definition lines', () => {
  const out = renderText('[ref]: https://example.com\n\n**bold** after')
  const plain = out.replace(ANSI, '').replace(OSC8, '')
  assert.equal(plain, '\nbold after')
})

test('renderText resolves venice citation markers against sources', (t) => {
  enableAnsi(t)
  const sources = [
    { title: 'One', url: 'https://one.example' },
    { title: 'Two', url: 'https://two.example' },
  ]
  const out = renderText('See ^1^ and ^2^ and ^1,2^ together', sources)
  assert.match(out, /\x1b\[3m\x1b\]8;;https:\/\/one\.example\x1b\\\[1\]\x1b\]8;;\x1b\\\x1b\[23m/)
  assert.match(out, /\x1b\[3m\x1b\]8;;https:\/\/two\.example\x1b\\\[2\]\x1b\]8;;\x1b\\\x1b\[23m/)
  assert.match(out, /\x1b\]8;;https:\/\/two\.example\x1b\\\[2\]\x1b\]8;;\x1b\\\x1b\[23m /)
  assert.equal(out.replace(ANSI, '').replace(OSC8, ''), 'See [1] and [2] and [1] [2] together')
})

test('renderText keeps styled link labels from leaking escape remnants', (t) => {
  enableAnsi(t)
  const out = renderText('[*ital*](https://x.com)')
  const plain = out.replace(ANSI, '').replace(OSC8, '')
  assert.equal(plain, 'ital')
  assert.match(out, /\x1b\[3m\x1b\]8;;https:\/\/x\.com\x1b\\ital\x1b\]8;;\x1b\\\x1b\[23m/)
})

test('renderText does not leak SGR remnants into link labels after bold', (t) => {
  enableAnsi(t)
  const out = renderText('- **AirPods 4 with ANC ($179)** – middle [cnet.com](https://cnet.example/x)')
  const plain = out.replace(ANSI, '').replace(OSC8, '')
  assert.equal(plain, '- AirPods 4 with ANC ($179) – middle cnet.com')
  assert.match(out, /\x1b\[1mAirPods 4 with ANC \(\$179\)\x1b\[22m/)
  assert.match(out, /\x1b\[3m\x1b\]8;;https:\/\/cnet\.example\/x\x1b\\cnet\.com\x1b\]8;;\x1b\\\x1b\[23m/)
  assert.doesNotMatch(out, /\x1b\]8;;https:\/\/cnet\.example\/x\x1b\\1m/)
  assert.doesNotMatch(out, /\x1b\]8;;[^\x1b]*\[cnet/)
})

test('renderText renders out-of-range markers plain and leaves markers alone without sources', (t) => {
  enableAnsi(t)
  const outOfRange = renderText('cite ^9^', [{ title: 'One', url: 'https://one.example' }])
  assert.equal(outOfRange.replace(ANSI, '').replace(OSC8, ''), 'cite [9]')
  const noSources = renderText('x^2^ stays literal')
  assert.equal(noSources, 'x^2^ stays literal')
})

test('renderText keeps citation markers inside code spans literal', (t) => {
  enableAnsi(t)
  const sources = [{ title: 'One', url: 'https://one.example' }]
  const out = renderText('`^1^` and ^1^', sources)
  assert.equal(out.replace(ANSI, '').replace(OSC8, ''), '^1^ and [1]')
})

test('renderText styles headers, lists, blockquotes and hr', (t) => {
  enableAnsi(t)
  const out = renderText('# Header\n\n- item **one**\n1. item two\n\n> quote\n\n---')
  const plain = out.replace(ANSI, '')
  assert.equal(plain, `# Header\n\n- item one\n1. item two\n\n> quote\n\n${THIN_SEP}`)
  assert.match(out, /\x1b\[1m# Header\x1b\[22m/)
  assert.match(out, /- item \x1b\[1mone\x1b\[22m/)
  assert.match(out, /\x1b\[2m> quote\x1b\[22m/)
  assert.ok(out.includes(`\x1b[2m${THIN_SEP}\x1b[22m`))
})

test('renderText dims fenced code blocks without inline styling', (t) => {
  enableAnsi(t)
  const out = renderText('```js\nconst x = 1 // **not bold**\n```\n\nafter **bold**')
  const plain = out.replace(ANSI, '')
  assert.equal(plain, '```js\nconst x = 1 // **not bold**\n```\n\nafter bold')
  assert.match(out, /\x1b\[2mconst x = 1 \/\/ \*\*not bold\*\*\x1b\[22m/)
  assert.doesNotMatch(out, /\x1b\[1mnot bold\x1b\[22m/)
})

test('renderText leaves plain text unchanged', () => {
  const text = 'just some plain text\nwith two lines and no markup'
  assert.equal(renderText(text), text)
})

test('streaming renderer shows the partial line immediately and restyles it on completion', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('**bold')
  assert.equal(plain(output()), '**bold')

  renderer.write(' text**\n')
  assert.equal(plain(output()), '**bold\r\x1b[Jbold text\n')
  assert.match(output(), /\x1b\[1mbold text\x1b\[22m/)

  renderer.write('tail **st')
  renderer.flush()
  assert.equal(plain(output()), '**bold\r\x1b[Jbold text\ntail **st')
})

test('streaming renderer refreshes the partial line in place while it grows', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('hello')
  assert.equal(plain(output()), 'hello')

  renderer.write(' world')
  assert.equal(plain(output()), 'hello')

  t.mock.timers.tick(200)
  assert.equal(plain(output()), 'hello\r\x1b[Jhello world')

  renderer.flush()
  assert.equal(plain(output()), 'hello\r\x1b[Jhello world')
})

test('streaming renderer keeps code block state across writes', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('```\ncode **x**')
  assert.equal(plain(output()), '```\ncode **x**')

  renderer.write('\n```\nrest **y**')
  renderer.flush()
  assert.equal(plain(output()), '```\ncode **x**\r\x1b[Jcode **x**\n```\nrest y')
  assert.match(output(), /\x1b\[2mcode \*\*x\*\*\x1b\[22m/)
})

test('streaming renderer processes multiple lines in one write', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('line1\nline2\n')
  assert.equal(output().replace(ANSI, ''), 'line1\nline2\n')
})

test('streaming renderer keeps whitespace-only lines as paragraph separators', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('alpha\n   \nbeta\n')
  renderer.flush()
  assert.equal(plain(output()), 'alpha\n   \nbeta\n')
})

test('streaming renderer still drops reference definition lines', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('[ref]: https://x.com\n   \ntext\n')
  renderer.flush()
  assert.equal(plain(output()), '   \ntext\n')
})

test('renderText keeps whitespace-only lines as paragraph separators', () => {
  assert.equal(renderText('alpha\n   \nbeta'), 'alpha\n   \nbeta')
  assert.equal(renderText('alpha\n\t\nbeta'), 'alpha\n\t\nbeta')
})

test('streaming renderer keeps fence state across partial redraws of the opener', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  // The fence opener arrives without its newline and is redrawn while partial;
  // repeated partial restyles must not toggle inCodeBlock (that would leave the
  // code-block state inverted for the lines after the block).
  renderer.write('```')
  renderer.write('js')
  t.mock.timers.tick(200)
  renderer.write('\nconst x = 1\n')
  renderer.write('```\n')
  renderer.write('after **bold**')
  renderer.flush()

  const out = output()
  assert.equal(plain(out), '```\r\x1b[J```js\r\x1b[J```js\nconst x = 1\n```\nafter bold')
  assert.match(out, /\x1b\[1mbold\x1b\[22m/)
  assert.doesNotMatch(out, /\*\*bold\*\*/)
})

test('streaming renderer rewinds by the styled width, not the raw markup width', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  enableAnsi(t)
  const chunks = []
  const stdout = { columns: 20, write: (chunk) => chunks.push(String(chunk)) }
  const renderer = createMarkdownRenderer({ stdout })

  // Raw partial is 23 wide (2 rows at 20 cols) but the styled text is 19 wide
  // (1 row): the rewind must use the styled width or it overshoots a row and the
  // erase wipes the completed line above.
  renderer.write('aa **bold**')
  renderer.write(' bb cc dd ee')
  t.mock.timers.tick(200)
  assert.equal(plain(chunks.join('')), 'aa bold\r\x1b[Jaa bold bb cc dd ee')

  // The styled text still fits one row (raw is now 26): the rewind must stay put.
  renderer.write(' ff')
  t.mock.timers.tick(200)
  assert.equal(plain(chunks.join('')), 'aa bold\r\x1b[Jaa bold bb cc dd ee\r\x1b[Jaa bold bb cc dd ee ff')

  // Now the styled text crosses the boundary too: the rewind goes up one row.
  renderer.write(' gg')
  t.mock.timers.tick(200)
  assert.equal(plain(chunks.join('')), 'aa bold\r\x1b[Jaa bold bb cc dd ee\r\x1b[Jaa bold bb cc dd ee ff\x1b[1A\r\x1b[Jaa bold bb cc dd ee ff gg')
})

test('renderText renders aligned tables', (t) => {
  enableAnsi(t)
  const out = renderText('| a | bb |\n|---|---|\n| 1 | 2 |')
  assert.equal(out.replace(ANSI, '').replace(OSC8, ''), 'a  bb\n---  ---\n1  2')
  assert.match(out, /\x1b\[1ma\x1b\[22m  \x1b\[1mbb\x1b\[22m/)
  assert.match(out, /\x1b\[2m---\x1b\[22m  \x1b\[2m---\x1b\[22m/)
})

test('renderText renders strikethrough and bare URLs as links', (t) => {
  enableAnsi(t)
  const out = renderText('~~gone~~ https://x.com')
  assert.equal(out.replace(ANSI, '').replace(OSC8, ''), 'gone https://x.com')
  assert.match(out, /\x1b\[9mgone\x1b\[29m/)
  assert.match(out, /\x1b\[3m\x1b\]8;;https:\/\/x\.com\x1b\\https:\/\/x\.com\x1b\]8;;\x1b\\\x1b\[23m/)
})

test('renderText dims indented code blocks', (t) => {
  enableAnsi(t)
  const out = renderText('    const x = 1')
  assert.match(out, /\x1b\[2m    const x = 1\x1b\[22m/)
})

test('renderText leaves raw HTML tags as literal text', (t) => {
  enableAnsi(t)
  const out = renderText('a <b>tag</b> here')
  assert.equal(out.replace(ANSI, ''), 'a <b>tag</b> here')
})

test('renderText renders nested lists with their raw markers', (t) => {
  enableAnsi(t)
  const out = renderText('- a\n  - b')
  assert.equal(out.replace(ANSI, ''), '- a\n  - b')
})

test('renderText resolves citations inside table cells', (t) => {
  enableAnsi(t)
  const sources = [{ title: 'One', url: 'https://one.example' }]
  const out = renderText('a | b\n---|---\n^1^ | x', sources)
  assert.equal(out.replace(ANSI, '').replace(OSC8, ''), 'a    b\n---  ---\n[1]  x')
  assert.match(out, /\x1b\[3m\x1b\]8;;https:\/\/one\.example\x1b\\\[1\]\x1b\]8;;\x1b\\\x1b\[23m/)
})

test('renderText strips ANSI escapes inside table-cell inline code and image alt', (t) => {
  enableAnsi(t)
  const out = renderText('code | alt\n-----|-----\n`\x1b[2Jx` | ![a\x1b[5mb](https://x.com/i)')
  assert.doesNotMatch(out, /\x1b\[2J|\x1b\[3J|\x1b\[5m|\x1b\[0m/)
  assert.ok(out.replace(ANSI, '').replace(OSC8, '').includes('x'))
  assert.doesNotMatch(renderText('![a\x1b[5mb](https://x.com/i)'), /\x1b\[5m/)
})

test('renderText keeps setext underlines as plain text', (t) => {
  enableAnsi(t)
  const out = renderText('Title\n===')
  assert.equal(out.replace(ANSI, ''), 'Title\n===')
})

test('renderText has no trailing newline', () => {
  assert.equal(renderText('one\ntwo'), 'one\ntwo')
})

test('streaming renderer holds table lines and emits the aligned table when it closes', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('a | b\n')
  assert.equal(plain(output()), 'a | b\n')

  renderer.write('---|---\n')
  assert.equal(plain(output()), 'a | b\n')

  renderer.write('1 | 2\n')
  assert.equal(plain(output()), 'a | b\n')

  renderer.write('\n')
  const out = output()
  assert.equal(plain(out), 'a | b\n\x1b[1A\r\x1b[Ja  b\n---  ---\n1  2\n\n')
  assert.match(out, /\x1b\[1ma\x1b\[22m  \x1b\[1mb\x1b\[22m/)
  assert.match(out, /\x1b\[2m---\x1b\[22m  \x1b\[2m---\x1b\[22m/)
})

test('streaming renderer emits a held table at flush', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('a | b\n')
  renderer.write('---|---\n')
  renderer.write('1 | 2\n')
  renderer.flush()
  assert.equal(plain(output()), 'a | b\n\x1b[1A\r\x1b[Ja  b\n---  ---\n1  2\n')
})

test('streaming renderer leaves pipe lines without a separator as paragraphs', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('a | b\n')
  renderer.write('c | d\n')
  renderer.flush()
  assert.equal(plain(output()), 'a | b\nc | d\n')
})

test('streaming renderer hides the partial line while the table is open', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('a | b\n')
  renderer.write('---|---\n')
  renderer.write('1 | 2')
  assert.equal(plain(output()), 'a | b\n')
  renderer.write('\n')
  assert.equal(plain(output()), 'a | b\n')
  renderer.write('\n')
  assert.equal(plain(output()), 'a | b\n\x1b[1A\r\x1b[Ja  b\n---  ---\n1  2\n\n')
})

test('streaming renderer strips ANSI escapes inside emitted table cells', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('code | alt\n')
  renderer.write('-----|-----\n')
  renderer.write('`\x1b[2Jx` | ![\x1b[5ma](https://x.com/i)\n')
  renderer.write('\n')
  const out = output()
  assert.doesNotMatch(out, /\x1b\[2J|\x1b\[5m/)
  assert.ok(plain(out).includes('x'))
})

test('streaming renderer rewinds a wrapped table header by its display rows', () => {
  const chunks = []
  const stdout = { columns: 20, write: (chunk) => chunks.push(String(chunk)) }
  const renderer = createMarkdownRenderer({ stdout })

  renderer.write('aaaa bbbb cccc dddd | x\n')
  renderer.write('---- | ---\n')
  renderer.write('1 | 2\n')
  renderer.write('\n')
  const out = chunks.join('')
  assert.ok(out.includes('\x1b[2A\r\x1b[J'))
  assert.ok(plain(out).includes('2'))
})

test('streaming renderer resolves citation markers when sources arrive', (t) => {
  const output = captureStdout(t)
  let sources = []
  const renderer = createMarkdownRenderer({ getSources: () => sources })

  renderer.write('see ^1^\n')
  renderer.write('and ^1^\n')
  assert.equal(plain(output()), 'see ^1^\nand ^1^\n')

  sources = [{ title: 'One', url: 'https://one.example' }]
  renderer.write('more ^1^\n')
  const out = output()
  assert.equal(plain(out), 'see ^1^\nand ^1^\nmore [1]\n')
  assert.match(out, /\x1b\[3m\x1b\]8;;https:\/\/one\.example\x1b\\\[1\]\x1b\]8;;\x1b\\\x1b\[23m/)
})

test('streaming renderer restyles a completed heading with the final parse', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('# He')
  assert.equal(plain(output()), '# He')
  renderer.write('ad\n')
  assert.equal(plain(output()), '# He\r\x1b[J# Head\n')
  assert.match(output(), /\x1b\[1m# Head\x1b\[22m/)
})

test('streaming renderer drops reference definition lines', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('[ref]: https://x.com\n')
  renderer.write('text\n')
  renderer.flush()
  assert.equal(plain(output()), 'text\n')
})

test('streaming renderer resets between flushed responses', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('a | b\n')
  renderer.write('---|---\n')
  renderer.write('1 | 2\n')
  renderer.flush()
  const afterFirst = plain(output())
  assert.equal(afterFirst, 'a | b\n\x1b[1A\r\x1b[Ja  b\n---  ---\n1  2\n')

  renderer.write('second turn\n')
  renderer.flush()
  assert.equal(plain(output()), afterFirst + 'second turn\n')
})

test('streaming renderer emits lines between two tables in one batch', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('a para\n')
  renderer.write('a | b\n')
  renderer.write('---|---\n')
  renderer.write('1 | 2\n')
  renderer.write('\n')
  renderer.write('between\n')
  renderer.write('c | d\n')
  renderer.write('---|---\n')
  renderer.flush()

  assert.equal(
    plain(output()),
    'a para\na | b\n\x1b[1A\r\x1b[Ja  b\n---  ---\n1  2\n\nbetween\nc | d\n\x1b[1A\r\x1b[Jc  d\n---  ---\n'
  )
})

test('streaming renderer rewinds rows correctly for emoji that render two columns', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { columns: 80, write: (chunk) => chunks.push(String(chunk)) }
  const renderer = createMarkdownRenderer({ stdout })

  // 79 ASCII columns + one emoji: 80 columns per a non-emoji-aware width
  // table, 81 visually. A redraw at this exact boundary must rewind two rows
  // or the partial's first row survives the completion restyle.
  const line = 'a'.repeat(79) + '👋'
  renderer.write(line.slice(0, 60))
  renderer.write(line.slice(60))
  t.mock.timers.tick(200)
  renderer.write('\n')
  renderer.flush()
  const out = chunks.join('')
  assert.ok(out.includes('\x1b[1A\r\x1b[J'))
})

test('stream renderer routes content through the markdown renderer when enabled', () => {
  const chunks = []
  const stdout = { write: (chunk) => chunks.push(String(chunk)) }
  const render = createStreamRenderer({ stdout, markdown: true })
  render('a | b\n', 'content')
  render('---|---\n', 'content')
  render('1 | 2\n', 'content')
  render.flush()
  assert.ok(plain(chunks.join('')).includes('\x1b[1A\r\x1b[Ja  b\n---  ---\n1  2'))
})

test('incremental streaming matches the one-shot renderer on a long mixed document', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  // Mixed blocks that exercise every boundary kind: fences, lists, quotes,
  // tables, headings, ref-style links and a long unbroken paragraph. The
  // reference definition precedes its use so the incremental tail parses
  // resolve it at emit time (a later definition can never retro-style an
  // already-emitted line, in the one-shot renderer either).
  const doc = [
    '# Heading',
    '',
    '[target]: https://example.com',
    '',
    'Paragraph with **bold** and `code` and a [ref-style][target] link.',
    '',
    '```js',
    'const x = 1',
    'const y = 2',
    '```',
    '',
    '- first',
    '- second with *italic*',
    '- third',
    '',
    '> quoted line',
    '> another quoted line',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    'The quick brown fox jumps over the lazy dog. '.repeat(30).trim(),
    '',
    '---',
    '',
    'final line',
    '',
  ].join('\n')

  // Feed the document one complete line at a time so every block boundary
  // lands in its own batch (partial-line redraws have their own tests).
  for (const line of doc.split('\n')) {
    renderer.write(`${line}\n`)
  }
  renderer.flush()

  // A held table re-emits its header line with a rewind-and-clear; drop the
  // overwritten copy and the cursor motion, as the terminal would.
  const streamed = plain(output()).replace(/[^\n]*\n\x1b\[\d*A\r\x1b\[J/g, '')
  const oneShot = plain(renderText(doc))
  assert.equal(streamed, oneShot + '\n')
})

test('streaming renderer stays linear on a long boundary-less paragraph', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  // 200 lines with no blank line: the tail-window cap keeps re-parses bounded
  // while every line still streams as paragraph text.
  for (let i = 0; i < 200; i++) {
    renderer.write(`line ${i} of a giant paragraph\n`)
  }
  renderer.flush()
  const text = plain(output())
  assert.ok(text.includes('line 0 of a giant paragraph\n'))
  assert.ok(text.includes('line 199 of a giant paragraph\n'))
  assert.equal(text.split('\n').filter(Boolean).length, 200)
})

test('streaming renderer emits a large open fence without re-parsing per line', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  renderer.write('```\n')
  for (let i = 0; i < 300; i++) {
    renderer.write(`code line ${i}\n`)
  }
  renderer.write('```\n')
  renderer.write('after the fence\n')
  renderer.flush()
  const out = output()
  assert.match(out, /\x1b\[2mcode line 0\x1b\[22m/)
  assert.match(out, /\x1b\[2mcode line 299\x1b\[22m/)
  assert.match(out, /after the fence\n/)
})

test('streaming renderer keeps fence state when a shorter marker line does not close it', (t) => {
  const output = captureStdout(t)
  const renderer = createMarkdownRenderer()

  // `~~~` cannot close a ```` fence: the line is content, and the lines
  // after it stay dimmed until the real closer arrives.
  renderer.write('````\n')
  renderer.write('content one\n')
  renderer.write('~~~\n')
  renderer.write('content two\n')
  renderer.write('````\n')
  renderer.write('done\n')
  renderer.flush()
  const out = output()
  assert.match(out, /\x1b\[2mcontent one\x1b\[22m/)
  assert.match(out, /\x1b\[2m~~~\x1b\[22m/)
  assert.match(out, /\x1b\[2mcontent two\x1b\[22m/)
  assert.match(out, /done\n/)
})
