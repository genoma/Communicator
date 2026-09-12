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
  const spelling = createSpellingProvider({ backend, features: { typoDetection: true, autocomplete: false }, debounceMs: 1 })
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

test('the ghost hint extends the caret row without moving the cursor or the row count', () => {
  const line = 'please recon'
  const plain = gridFor([line], { col: line.length })
  const hinted = gridFor([line], { col: line.length, ghostHint: 'ciliation' })

  assert.deepEqual(hinted.cursor, plain.cursor, 'the cursor stays before the hint')
  assert.equal(hinted.rows.length, plain.rows.length)
  assert.equal(visible(hinted.rows[0]), `${plain.rows[0]}ciliation`, 'the hint is appended, not inserted')
  assert.equal(stringWidth(hinted.rows[0]), stringWidth(plain.rows[0]) + 'ciliation'.length)
})

test('the ghost hint is clipped to the terminal and only paints at the row end', () => {
  const line = 'please recon'
  const long = gridFor([line], { col: line.length, ghostHint: 'x'.repeat(80) })
  assert.ok(stringWidth(long.rows[0]) <= 40, 'a hint never overflows the terminal')

  const midLine = gridFor([line], { col: 3, ghostHint: 'ciliation' })
  assert.equal(visible(midLine.rows[0]), `❯ ${line}`, 'a caret inside the row carries no hint')

  const submitted = gridFor([line], { col: line.length, ghostHint: 'ciliation', submittedMarker: '❯ You' })
  assert.deepEqual(submitted.rows, ['', '❯ You', '', line], 'the replay form never carries a hint')
})

test('a landed completion repaints the block with the dim hint', async () => {
  const backend = {
    calls: [],
    async run(request) {
      backend.calls.push(request)
      return { words: request.op === 'completions' ? ['reconciliation'] : [] }
    },
  }
  const spelling = createSpellingProvider({ backend, features: { autocomplete: true }, debounceMs: 1 })
  const { input, output, pending } = openEditor({ spelling })

  input.emit('data', 'please recon')
  await delay(30)
  assert.equal(backend.calls.filter((c) => c.op === 'completions').length, 1)
  assert.ok(output.text().includes('ciliation'), 'the hint is painted after the result lands')

  input.emit('data', '\r')
  assert.deepEqual(await pending, ['please recon', null], 'the hint is never part of the submitted text')
  spelling.dispose()
})

test('Tab accepts the ghost hint only when no suggestion list is open', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordReplacements: async () => null,
    getWordCompletion: () => 'ciliation',
  }

  const accepted = openEditor({ spelling })
  accepted.input.emit('data', 'please recon')
  accepted.input.emit('data', '\t')
  accepted.input.emit('data', '\r')
  assert.deepEqual(await accepted.pending, ['please reconciliation', null], 'Tab accepts the hint')

  const cycling = openEditor({ spelling, suggest: ({ value }) => (value.startsWith('/') ? ['/edit', '/export-format'] : []) })
  cycling.input.emit('data', '/e')
  cycling.input.emit('data', '\t')
  cycling.input.emit('data', '\r')
  const [cycled] = await cycling.pending
  assert.equal(cycled, '/edit', 'the command list kept Tab')
  assert.ok(!cycled.includes('ciliation'), 'the hint is not accepted while a list is open')
})

test('an accepted hint is one undoable edit', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordReplacements: async () => null,
    getWordCompletion: () => 'ciliation',
  }
  const { input, pending } = openEditor({ spelling })

  input.emit('data', 'please recon')
  input.emit('data', '\t')
  input.emit('data', '\x1b[122;5u') // Ctrl+Z (kitty)
  input.emit('data', '\r')

  assert.deepEqual(await pending, ['please recon', null], 'one undo reverts the whole completion')
})

test('Ctrl+. opens the replacement list and Enter applies it in one undo step', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordCompletion: () => null,
    getWordReplacements: async (lines, row) => ({ line: row, startCol: 6, endCol: 11, items: ['world', 'word'] }),
  }
  const { input, output, pending } = openEditor({ spelling })

  input.emit('data', 'hello wrold')
  input.emit('data', '\x1b[46;5u') // Ctrl+.
  await delay(10)
  assert.ok(output.text().includes('world'), 'the replacement list is rendered')

  input.emit('data', '\r')
  await delay(10)
  input.emit('data', '\x1b[122;5u') // Ctrl+Z reverts the replacement only
  input.emit('data', '\r')

  assert.deepEqual(await pending, ['hello wrold', null], 'the replacement is one undoable edit')
})

test('Escape cancels an open replacement list without editing', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordCompletion: () => null,
    getWordReplacements: async (lines, row) => ({ line: row, startCol: 6, endCol: 11, items: ['world'] }),
  }
  const { input, output, pending } = openEditor({ spelling })

  input.emit('data', 'hello wrold')
  input.emit('data', '\x1b[46;5u')
  await delay(10)
  assert.ok(output.text().includes('world'), 'the list is open before Escape')

  input.emit('data', '\x1b') // a lone Escape is flushed after 50 ms
  await delay(80)
  input.emit('data', '\r')

  assert.deepEqual(await pending, ['hello wrold', null], 'the line is untouched')
})

test('Tab never inserts a completion the layout did not paint', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordReplacements: async () => null,
    getWordCompletion: () => 'ciliation',
  }

  const midRow = openEditor({ spelling })
  midRow.input.emit('data', 'please recon and more')
  midRow.input.emit('data', '\x1b[D'.repeat(9))
  midRow.input.emit('data', '\t')
  midRow.input.emit('data', '\r')
  assert.deepEqual(await midRow.pending, ['please recon and more', null], 'a caret inside the row accepts nothing')

  const full = openEditor({ spelling })
  const fullLine = `${'word '.repeat(10)}ab recon`
  assert.equal(fullLine.length, 58, 'the line fills the usable width exactly')
  full.input.emit('data', fullLine)
  full.input.emit('data', '\t')
  full.input.emit('data', '\r')
  assert.deepEqual(await full.pending, [fullLine, null], 'a row with no free column accepts nothing')
})

test('Tab inserts exactly the clipped hint the layout painted', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordReplacements: async () => null,
    getWordCompletion: () => 'ciliation',
  }
  const { input, pending } = openEditor({ spelling })
  const line = `${'word '.repeat(9)}ab recon`

  input.emit('data', line)
  input.emit('data', '\t')
  input.emit('data', '\r')

  const [value] = await pending
  assert.equal(value, `${line}cilia`, 'only the columns the row had room for are inserted')
})

test('a submitted block never carries the ghost hint', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordReplacements: async () => null,
    getWordCompletion: () => 'ciliation',
  }
  const { input, output, pending } = openEditor({ spelling })

  input.emit('data', 'please recon')
  await delay(10)
  assert.ok(output.text().includes('ciliation'), 'the hint is painted while typing')

  const before = output.text().length
  input.emit('data', '\r')
  assert.deepEqual(await pending, ['please recon', null])
  assert.ok(!output.text().slice(before).includes('ciliation'), 'the submit repaint drops the hint')
})

test('Shift+Tab never accepts the ghost hint', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordReplacements: async () => null,
    getWordCompletion: () => 'ciliation',
  }
  const { input, pending } = openEditor({ spelling })

  input.emit('data', 'please recon')
  input.emit('data', '\x1b[Z')
  input.emit('data', '\r')

  assert.deepEqual(await pending, ['please recon', null])
})

test('a replacement lookup that lands after a cursor move is dropped', async () => {
  let resolveLookup
  const lookup = new Promise((resolve) => { resolveLookup = resolve })
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordCompletion: () => null,
    getWordReplacements: () => lookup,
  }
  const { input, output, pending } = openEditor({ spelling })

  input.emit('data', 'hello wrold')
  input.emit('data', '\x1b[46;5u')
  await delay(5)
  input.emit('data', '\x1b[D')
  const before = output.text().length
  resolveLookup({ line: 0, startCol: 6, endCol: 11, items: ['world'] })
  await delay(10)

  assert.ok(!output.text().slice(before).includes('world'), 'a stale lookup opens nothing')
  input.emit('data', '\r')
  assert.deepEqual(await pending, ['hello wrold', null])
})

test('a second Ctrl+. that finds nothing closes the open list', async () => {
  let lookups = 0
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordCompletion: () => null,
    async getWordReplacements(lines, row) {
      lookups += 1
      return lookups === 1 ? { line: row, startCol: 6, endCol: 11, items: ['world'] } : null
    },
  }
  const { input, output, pending } = openEditor({ spelling })

  input.emit('data', 'hello wrold')
  input.emit('data', '\x1b[46;5u')
  await delay(10)
  assert.ok(output.text().includes('world'), 'the first lookup opens the list')

  const before = output.text().length
  input.emit('data', '\x1b[46;5u')
  await delay(10)
  assert.ok(!output.text().slice(before).includes('world'), 'the empty second lookup closes it')

  input.emit('data', '\r')
  assert.deepEqual(await pending, ['hello wrold', null])
})

test('the arrows move the replacement selection and Enter applies the selected one', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordCompletion: () => null,
    getWordReplacements: async (lines, row) => ({ line: row, startCol: 6, endCol: 11, items: ['world', 'word'] }),
  }
  const { input, pending } = openEditor({ spelling })

  input.emit('data', 'hello wrold')
  input.emit('data', '\x1b[46;5u')
  await delay(10)
  input.emit('data', '\x1b[B')
  input.emit('data', '\r')
  input.emit('data', '\r')

  assert.deepEqual(await pending, ['hello word', null], 'the second entry is applied')
})

test('Ctrl+. on a word that is not flagged opens nothing', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordCompletion: () => null,
    getWordReplacements: async () => null,
  }
  const { input, output, pending } = openEditor({ spelling })

  input.emit('data', 'hello world')
  const before = output.text().length
  input.emit('data', '\x1b[46;5u')
  await delay(10)
  assert.ok(!output.text().slice(before).includes('\u203a'), 'no list row is painted')

  input.emit('data', '\r')
  assert.deepEqual(await pending, ['hello world', null], 'the line is untouched')
})

test('the ghost hint is suppressed while the replacement list is open', async () => {
  const spelling = {
    onUpdate: null,
    setFeatures() {},
    dispose() {},
    getTypoRanges: () => undefined,
    getWordCompletion: () => 'ciliation',
    getWordReplacements: async (lines, row) => ({ line: row, startCol: 6, endCol: 11, items: ['world'] }),
  }
  const { input, output, pending } = openEditor({ spelling })

  input.emit('data', 'please recon')
  await delay(10)
  assert.ok(output.text().includes('ciliation'), 'the hint is painted first')

  const before = output.text().length
  input.emit('data', '\x1b[46;5u')
  await delay(10)
  assert.ok(output.text().slice(before).includes('world'), 'the list opens')
  assert.ok(!output.text().slice(before).includes('ciliation'), 'and the hint is gone')

  input.emit('data', '\x1b')
  await delay(80)
  input.emit('data', '\r')
  assert.deepEqual(await pending, ['please recon', null])
})

test('a provider-less editor is unaffected', async () => {
  const { input, output, pending } = openEditor()
  input.emit('data', 'hello')
  input.emit('data', '\r')
  assert.deepEqual(await pending, ['hello', null])
  assert.ok(!output.text().includes(UNDERLINE))
})
