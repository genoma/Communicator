// Typo underlines in the prompt editor: the decoration is applied to the
// produced row slices, so it must never change a measured width, the grid or
// the cursor — and it must never paint a dead editor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { stripVTControlCharacters } from 'node:util'
import { readEditor } from '../src/editor/index.js'
import { computeGrid } from '../src/editor/layout.js'
import { stringWidth } from '../src/editor/chars.js'
import { createSpellingProvider } from '../src/spelling/provider.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const UNDERLINE = '\x1b[4:3m\x1b[58:2::255:95:95m'
const UNDERLINE_OFF = '\x1b[4:0m\x1b[59m'

// The oracle is deliberately independent of chars.js: node:util ignored colon
// subparameters before Node 24, so a decorated row only measures as plain when
// the editor strips that form itself.
// eslint-disable-next-line no-control-regex
const COLON_SGR = /\x1b\[[0-9;:]*:[0-9;:]*m/g
const visible = (row) => stripVTControlCharacters(row.replace(COLON_SGR, ''))

function gridFor(lines, extra = {}) {
  return computeGrid({
    width: 40,
    headerRows: [],
    linePrefix: '❯ ',
    linePrefixWidth: 2,
    lines,
    row: 0,
    col: 0,
    theme: undefined,
    footerRows: [],
    inputStyle: undefined,
    ...extra,
  })
}

function linesOf(spelling, ranges) {
  return { getTypoRanges: (line) => (line in ranges ? ranges[line] : undefined) }
}

function assertUnchangedLayout(plain, decorated) {
  assert.equal(decorated.width, plain.width)
  assert.deepEqual(decorated.cursor, plain.cursor)
  assert.equal(decorated.rows.length, plain.rows.length)
  for (let i = 0; i < plain.rows.length; i++) {
    assert.equal(stringWidth(decorated.rows[i]), stringWidth(plain.rows[i]), `row ${i} width`)
    assert.equal(visible(decorated.rows[i]), plain.rows[i], `row ${i} text`)
  }
}

test('decoration wraps the ranges without changing widths, rows or cursor', () => {
  const line = 'This is a mispelled sentence with wrold typos'
  const spelling = linesOf(null, { [line]: [[10, 19], [34, 39]] })
  const plain = gridFor([line])
  const decorated = gridFor([line], { spelling })

  assertUnchangedLayout(plain, decorated)
  assert.deepEqual(decorated.rows, [
    `❯ This is a ${UNDERLINE}mispelled${UNDERLINE_OFF} sentence with`,
    `❯ ${UNDERLINE}wrold${UNDERLINE_OFF} typos`,
  ])
})

test('the width oracle measures colon-form SGR as zero columns', () => {
  // The underline is the only colon-form SGR the editor emits, and the engines
  // floor (Node 22) does not strip it in node:util by itself.
  assert.equal(stringWidth(`${UNDERLINE}wrold${UNDERLINE_OFF}`), 5)
  assert.equal(visible(`${UNDERLINE}mispelled${UNDERLINE_OFF}`), 'mispelled')
})

test('a range that crosses a wrap boundary decorates both row slices', () => {
  const line = `${'a'.repeat(40)} bbbbbbbbbb`
  // 38 usable columns: row 0 is 38 a's, row 1 carries the residual `aa b...`.
  const spelling = linesOf(null, { [line]: [[34, 51]] })
  const plain = gridFor([line])
  const decorated = gridFor([line], { spelling })

  assertUnchangedLayout(plain, decorated)
  assert.equal(decorated.rows[0], `❯ ${'a'.repeat(34)}${UNDERLINE}aaaa${UNDERLINE_OFF}`)
  assert.equal(decorated.rows[1], `❯ ${UNDERLINE}aa bbbbbbbbbb${UNDERLINE_OFF}`)
})

test('ranges are clipped to the slice and never decorate more than their own text', () => {
  const line = 'wrold wrold wrold'
  const spelling = linesOf(null, { [line]: [[0, 5], [6, 11]] })
  const decorated = gridFor([line], { spelling })
  assert.equal(decorated.rows[0], `❯ ${UNDERLINE}wrold${UNDERLINE_OFF} ${UNDERLINE}wrold${UNDERLINE_OFF} wrold`)
})

test('lines without ranges and the submitted-marker form stay plain', () => {
  const spelling = linesOf(null, { wrold: [[0, 5]] })
  const plain = gridFor(['wrold', 'hello'])
  const decorated = gridFor(['wrold', 'hello'], { spelling })
  assertUnchangedLayout(plain, decorated)
  assert.equal(decorated.rows[1], '❯ hello')

  const submitted = gridFor(['wrold'], { spelling, submittedMarker: '❯ You' })
  assert.deepEqual(submitted.rows, ['', '❯ You', '', 'wrold'])
})

test('the cursor column is identical with and without a decoration', () => {
  const line = 'This is a mispelled sentence'
  const spelling = linesOf(null, { [line]: [[10, 19]] })
  for (const col of [0, 10, 15, 19, 27]) {
    const plain = gridFor([line], { col })
    const decorated = gridFor([line], { spelling, col })
    assert.deepEqual(decorated.cursor, plain.cursor, `cursor at column ${col}`)
  }
})

test('unsorted and overlapping ranges never duplicate text or change the width', () => {
  const line = 'one wrold two wrold'
  const spelling = linesOf(null, { [line]: [[8, 13], [0, 3], [2, 11]] })
  const plain = gridFor([line])
  const decorated = gridFor([line], { spelling })

  assertUnchangedLayout(plain, decorated)
  assert.equal(
    decorated.rows[0],
    `❯ ${UNDERLINE}one${UNDERLINE_OFF}${UNDERLINE} wrold t${UNDERLINE_OFF}${UNDERLINE}wo${UNDERLINE_OFF} wrold`,
  )
  assert.equal(decorated.rows[0].match(/wrold/g).length, 2, 'no character is emitted twice')
})

test('a buffer larger than the provider cache checks only the caret line', () => {
  const lines = ['wrold one', 'wrold two', 'wrold three', 'wrold four']
  const asked = []
  const spelling = {
    maxCheckedLines: 3,
    getTypoRanges: (line) => { asked.push(line) },
  }

  gridFor(lines, { spelling, row: 2 })
  assert.deepEqual(asked, ['wrold three'], 'the caret line is the only requested one')

  const withinBound = []
  gridFor(lines.slice(0, 3), { spelling: { maxCheckedLines: 3, getTypoRanges: (line) => { withinBound.push(line) } }, row: 0 })
  assert.deepEqual(withinBound, ['wrold one', 'wrold two', 'wrold three'], 'a buffer within the bound keeps every line checked')
})

function fakeStdin() {
  const stdin = new EventEmitter()
  stdin.isTTY = true
  stdin.readableEnded = false
  stdin.destroyed = false
  stdin.setRawMode = () => {}
  stdin.resume = () => {}
  stdin.pause = () => {}
  return stdin
}

function fakeOutput(columns = 60) {
  const output = new EventEmitter()
  output.columns = columns
  output.rows = 24
  output.isTTY = true
  output.chunks = []
  output.write = (data) => {
    output.chunks.push(data)
    return true
  }
  output.text = () => output.chunks.join('')
  return output
}

function openEditor(extra = {}) {
  const input = fakeStdin()
  const output = fakeOutput()
  const pending = readEditor('', {
    input,
    output,
    prefix: '',
    linePrefix: '❯ ',
    history: [],
    helpFooter: false,
    ...extra,
  })
  return { input, output, pending }
}

test('a landed check repaints the block and a closed editor never repaints again', async () => {
  const backend = { calls: [], run: async (request) => { backend.calls.push(request); return { ranges: [[0, 9]] } } }
  const spelling = createSpellingProvider({ backend, features: { typoDetection: true }, debounceMs: 1 })
  const { input, output, pending } = openEditor({ spelling })
  assert.equal(typeof spelling.onUpdate, 'function', 'the editor installs its repaint hook')

  input.emit('data', 'mispelled')
  await delay(30)
  assert.equal(backend.calls.length, 1)
  assert.ok(output.text().includes(UNDERLINE), 'the misspelled word is underlined')
  assert.ok(output.text().includes(`${UNDERLINE}mispelled${UNDERLINE_OFF}`))

  const repaint = spelling.onUpdate
  input.emit('data', '\r')
  assert.deepEqual(await pending, ['mispelled', null])
  assert.equal(spelling.onUpdate, null, 'the hook is cleared on teardown')

  const chunksAfterClose = output.chunks.length
  repaint()
  await delay(10)
  assert.equal(output.chunks.length, chunksAfterClose, 'nothing is written after the editor closes')
  spelling.dispose()
})

test('a provider-less editor is unaffected', async () => {
  const { input, output, pending } = openEditor()
  input.emit('data', 'hello')
  input.emit('data', '\r')
  assert.deepEqual(await pending, ['hello', null])
  assert.ok(!output.text().includes(UNDERLINE))
})
