import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMarkdownRenderer, renderText } from '../src/ui/markdown.js'
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
