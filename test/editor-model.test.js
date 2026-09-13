// Model-level and key-binding regression tests for src/editor/model.js. The
// screen harness is copied from test/editor-grid.test.js (test helpers are
// per-file): the key sequences run through the real readEditor bindings, while
// the direct model cases pin the exact cursor/history state.
/* eslint-disable no-control-regex */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import stringWidth from 'string-width'
import { readEditor } from '../src/editor/index.js'
import {
  createModel,
  handleBackspace,
  handleDelete,
  insertChar,
  insertNewline,
  insertPaste,
  moveDownOrHistory,
  moveRight,
  moveUpOrHistory,
} from '../src/editor/model.js'

// The emulated terminal needs its OWN width oracle, independent of the one the
// editor ships (src/editor/chars.js). It models what a real terminal does, so
// it iterates grapheme clusters (a ZWJ family occupies one cell pair, not one
// per code point) and measures with string-width. Using the editor's own table
// here would make the harness agree with the code under test by construction:
// the previous oracle was `codePointAt(0) > 0x20000 ? 2 : 1`, under which even
// U+4E00 (中) was one column wide, so the CJK grid tests below passed by
// coincidence and no emoji desync could ever be detected.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function cells(cluster) {
  // A cluster that measures zero (a lone combining mark or zero-width space)
  // still occupies a slot in this simple grid model; over-counting it makes
  // the harness stricter, never more permissive.
  return Math.max(1, stringWidth(cluster))
}

function clustersOf(text) {
  // CR and LF are cursor operations here, not printable clusters, and UAX #29
  // makes CRLF a *single* grapheme — segmenting blindly would swallow the
  // newline and plot it as a character.
  const out = []
  for (const part of text.split(/(\r|\n)/)) {
    if (part === '') continue
    if (part === '\r' || part === '\n') {
      out.push(part)
      continue
    }
    for (const { segment } of graphemes.segment(part)) out.push(segment)
  }
  return out
}

class Terminal {
  constructor({ cols = 80, rows = 24, replyDsr = true } = {}) {
    this.cols = cols
    this.rows = rows
    this.replyDsr = replyDsr
    this.cursor = { r: 0, c: 0 }
    // xterm-authentic: printing at the right margin sets the pending-wrap
    // flag; the next printable char wraps to the next row. Cursor moves and
    // CR/LF clear it.
    this.wrapPending = false
    this.grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''))
    this.out = {
      columns: cols,
      rows,
      write: (chunk) => this.write(String(chunk)),
      on: () => {},
      removeListener: () => {},
    }
    this.emitter = new EventEmitter()
    this.out.on = (event, fn) => this.emitter.on(event, fn)
    this.out.removeListener = (event, fn) => this.emitter.removeListener(event, fn)
    this.out.emit = (event, ...args) => this.emitter.emit(event, ...args)
    this.dsrQueries = 0
  }

  scrollTop() {
    const line = this.grid.shift().map(() => '')
    this.grid.push(Array.from({ length: this.cols }, () => ''))
    return line
  }

  plot(text) {
    let r = this.cursor.r
    let c = this.cursor.c
    let wrap = this.wrapPending
    for (const ch of clustersOf(text)) {
      if (ch === '\r') {
        c = 0
        wrap = false
        continue
      }
      if (ch === '\n') {
        r++
        if (r >= this.rows) {
          this.scrollTop()
          r = this.rows - 1
        }
        wrap = false
        continue
      }
      const w = cells(ch)
      if (wrap || c + w > this.cols) {
        r++
        if (r >= this.rows) {
          this.scrollTop()
          r = this.rows - 1
        }
        c = 0
        wrap = false
      }
      this.grid[r][c] = ch
      if (w === 2 && c + 1 < this.cols) this.grid[r][c + 1] = ''
      if (c + w >= this.cols) {
        // Printed at (or past) the right margin: the cursor stays at the
        // margin and the pending-wrap flag is set (xterm semantics).
        wrap = true
      } else {
        c += w
      }
    }
    this.cursor = { r, c }
    this.wrapPending = wrap
  }

  write(data) {
    if (data.includes('\x1b[6n')) {
      this.dsrQueries++
      const row = this.cursor.r + 1
      const col = this.cursor.c + 1
      this.onDsr?.({ row, col })
    }
    // Sequential parse: text and escape operations interleave in timestamp
    // order (the editor never relies on soft-wrap, so ops are simple moves).
    const text = data.replace(/\x1b\]8;;.*?\x1b\\/g, '').replace(/\x1b\][0-9;]*\x1b\\/g, '')
    const escRe = /\x1b\[[0-9;:<>=?]*[ -/]*[@-~]/g
    let idx = 0
    let match
    while ((match = escRe.exec(text)) !== null) {
      this.plot(text.slice(idx, match.index))
      this.applyEsc(match[0])
      idx = match.index + match[0].length
    }
    this.plot(text.slice(idx))
  }

  applyEsc(esc) {
    const m = esc.slice(2).match(/^([0-9;:<>=?]*)([!-~])/)
    const op = m[2]
    const nums = m[1].split(';').filter((s) => s !== '').map(Number)
    const n = nums[0] > 0 ? nums[0] : 1
    if (op === 'A') {
      this.cursor.r = Math.max(0, this.cursor.r - n)
      this.wrapPending = false
    } else if (op === 'B') {
      this.cursor.r = Math.min(this.rows - 1, this.cursor.r + n)
      this.wrapPending = false
    } else if (op === 'C') {
      this.cursor.c = Math.min(this.cols - 1, this.cursor.c + n)
      this.wrapPending = false
    } else if (op === 'D') {
      this.cursor.c = Math.max(0, this.cursor.c - n)
      this.wrapPending = false
    } else if (op === 'G') {
      this.cursor.c = Math.max(0, Math.min(this.cols - 1, n - 1))
      this.wrapPending = false
    } else if (op === 'H') {
      this.cursor.r = Math.max(0, Math.min(this.rows - 1, (nums[0] || 1) - 1))
      this.cursor.c = Math.max(0, Math.min(this.cols - 1, (nums[1] || 1) - 1))
      this.wrapPending = false
    } else if (op === 'K') {
      const mode = nums[0] ?? 0
      if (mode === 0) {
        for (let c = this.cursor.c; c < this.cols; c++) this.grid[this.cursor.r][c] = ''
      } else if (mode === 1) {
        for (let c = 0; c <= this.cursor.c; c++) this.grid[this.cursor.r][c] = ''
      } else if (mode === 2) {
        this.grid[this.cursor.r] = Array.from({ length: this.cols }, () => '')
      }
    } else if (op === 'J') {
      const mode = nums[0] ?? 0
      if (mode === 0) {
        for (let r = this.cursor.r; r < this.rows; r++) {
          const from = r === this.cursor.r ? this.cursor.c : 0
          for (let c = from; c < this.cols; c++) this.grid[r][c] = ''
        }
      } else if (mode === 2 || mode === 3) {
        this.grid = this.grid.map(() => Array.from({ length: this.cols }, () => ''))
      }
    }
  }

  /** Visible screen lines (erased cells are blank; content is preserved) */
  lines() {
    return this.grid.map((row) => row.join(''))
  }

  resize(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.out.columns = cols
    this.out.rows = rows
    this.emitter.emit('resize')
  }
}

function fakeInput() {
  const stdin = new EventEmitter()
  stdin.isTTY = true
  stdin.readableEnded = false
  stdin.destroyed = false
  stdin.setRawMode = () => {}
  stdin.resume = () => {}
  stdin.pause = () => {}
  return stdin
}

function setup(t, { cols = 80, rows = 24, autoDsr = true, options = {} } = {}) {
  const term = new Terminal({ cols, rows, replyDsr: autoDsr })
  const stdin = fakeInput()
  if (autoDsr) {
    term.onDsr = ({ row, col }) => stdin.emit('data', `\x1b[${row};${col}R`)
  }
  const editor = readEditor('', {
    input: stdin,
    output: term.out,
    prefix: '',
    linePrefix: '❯ ',
    helpFooter: false,
    maxLines: 50,
    theme: {
      linePrefix: { pending: 'cyan', submitted: 'dim', cancelled: 'dim' },
    },
    ...options,
  })
  return { term, stdin, editor }
}

function type(stdin, text) {
  stdin.emit('data', text)
}

function press(stdin, key) {
  stdin.emit('data', key)
}

function submit(stdin) {
  stdin.emit('data', '\r')
}

// --- History: recall and draft restore ---

test('historyNext restores the saved draft and its cursor after recall', () => {
  const model = createModel({ historyRows: ['first', 'second'] })
  model.lines = ['draft text']
  model.row = 0
  model.col = 'draft text'.length

  moveUpOrHistory(model) // column move only: no recall yet
  assert.deepEqual(model.lines, ['draft text'])
  assert.equal(model.col, 0)

  moveUpOrHistory(model) // recalls the newest entry with the cursor at its start
  assert.deepEqual(model.lines, ['second'])
  assert.equal(model.historyIndex, 1)
  assert.equal(model.col, 0)

  moveDownOrHistory(model) // end of the recalled line: still no historyNext
  assert.equal(model.col, 'second'.length)

  moveDownOrHistory(model) // historyNext restores the draft at its end
  assert.deepEqual(model.lines, ['draft text'])
  assert.equal(model.historyIndex, 2)
  assert.equal(model.col, 'draft text'.length)
})

test('historyNext steps back down through recalled entries', () => {
  const model = createModel({ historyRows: ['first', 'second'] })
  model.lines = ['draft']
  model.row = 0
  model.col = 'draft'.length

  moveUpOrHistory(model)
  moveUpOrHistory(model)
  moveUpOrHistory(model) // oldest entry
  assert.deepEqual(model.lines, ['first'])
  assert.equal(model.historyIndex, 0)

  moveDownOrHistory(model) // column move to the end of the recalled line
  moveDownOrHistory(model) // next entry through the non-draft branch
  assert.deepEqual(model.lines, ['second'])
  assert.equal(model.historyIndex, 1)

  moveDownOrHistory(model)
  moveDownOrHistory(model) // draft restore at the end of history
  assert.deepEqual(model.lines, ['draft'])
  assert.equal(model.historyIndex, 2)
  assert.equal(model.col, 'draft'.length)
})

test('history keys recall entries and restore the draft end to end', async (t) => {
  const recalled = setup(t, { options: { history: ['first', 'second'] } })
  type(recalled.stdin, 'draft text')
  press(recalled.stdin, '\x1b[A')
  press(recalled.stdin, '\x1b[A')
  submit(recalled.stdin)
  const [recalledValue] = await recalled.editor
  assert.equal(recalledValue, 'second')

  const restored = setup(t, { options: { history: ['first', 'second'] } })
  type(restored.stdin, 'draft text')
  press(restored.stdin, '\x1b[A')
  press(restored.stdin, '\x1b[A')
  press(restored.stdin, '\x1b[B')
  press(restored.stdin, '\x1b[B')
  submit(restored.stdin)
  const [restoredValue] = await restored.editor
  assert.equal(restoredValue, 'draft text')
})

// --- Delete ---

test('handleDelete removes at the cursor and joins lines at end of line', () => {
  const mid = createModel()
  mid.lines = ['abcd']
  mid.col = 2
  handleDelete(mid)
  assert.deepEqual(mid.lines, ['abd'])
  assert.equal(mid.col, 2)

  const eol = createModel()
  eol.lines = ['foo', 'bar']
  eol.row = 0
  eol.col = 3
  handleDelete(eol)
  assert.deepEqual(eol.lines, ['foobar'])
  assert.equal(eol.row, 0)
  assert.equal(eol.col, 3)
})

test('Delete removes at the cursor and joins the next line', async (t) => {
  const mid = setup(t, { options: { initialValue: 'abcd' } })
  press(mid.stdin, '\x1b[D')
  press(mid.stdin, '\x1b[D')
  press(mid.stdin, '\x1b[3~')
  submit(mid.stdin)
  const [midValue] = await mid.editor
  assert.equal(midValue, 'abd')

  const eol = setup(t, { options: { initialValue: 'foo\nbar' } })
  press(eol.stdin, '\x1b[A') // row 0, end of 'foo'
  press(eol.stdin, '\x1b[3~') // joins the next line
  submit(eol.stdin)
  const [eolValue] = await eol.editor
  assert.equal(eolValue, 'foobar')
})

// --- Right arrow ---

test('moveRight crosses a line boundary and steps over an astral pair', () => {
  const lines = createModel()
  lines.lines = ['foo', 'bar']
  lines.row = 0
  lines.col = 3
  moveRight(lines)
  assert.equal(lines.row, 1)
  assert.equal(lines.col, 0)

  const astral = createModel()
  astral.lines = ['a\u{1F600}b']
  astral.col = 1
  moveRight(astral)
  assert.equal(astral.col, 3)
  moveRight(astral)
  assert.equal(astral.col, 4)
})

test('Right arrow crosses a line boundary before inserting', async (t) => {
  const { stdin, editor } = setup(t, { options: { initialValue: 'foo\nbar' } })
  press(stdin, '\x1b[A') // row 0, end of 'foo'
  press(stdin, '\x1b[C') // crosses to row 1, column 0
  type(stdin, 'X')
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'foo\nXbar')
})

// --- Backspace at a line boundary ---

test('handleBackspace at column 0 merges into the previous line', () => {
  const model = createModel()
  model.lines = ['foo', 'bar']
  model.row = 1
  model.col = 0
  handleBackspace(model)
  assert.deepEqual(model.lines, ['foobar'])
  assert.equal(model.row, 0)
  assert.equal(model.col, 3)
})

test('Backspace at the start of a line merges it into the previous line', async (t) => {
  const { stdin, editor } = setup(t, { options: { initialValue: 'foo\nbar' } })
  press(stdin, '\x1b[H') // start of row 1
  press(stdin, '\x7f')
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'foobar')
})

// --- Length budgets ---

test('insertChar stops at maxLength and reports the limit', () => {
  const model = createModel({ maxLength: 3 })
  insertChar(model, 'a')
  insertChar(model, 'b')
  insertChar(model, 'c')
  insertChar(model, 'd')
  assert.deepEqual(model.lines, ['abc'])
  assert.equal(model.statusText, 'Maximum 3 characters')
  assert.equal(model.visualState, 'error')
})

test('insertNewline honors the maxLines and maxLength budgets', () => {
  const linesModel = createModel({ maxLines: 1 })
  insertNewline(linesModel)
  assert.deepEqual(linesModel.lines, [''])
  assert.equal(linesModel.statusText, 'Maximum 1 lines')

  const charsModel = createModel({ maxLength: 3 })
  charsModel.lines = ['abc']
  charsModel.col = 3
  insertNewline(charsModel)
  assert.deepEqual(charsModel.lines, ['abc'])
  assert.equal(charsModel.statusText, 'Maximum 3 characters')
})

test('insertPaste truncates at the character budget and reports the limit', () => {
  const model = createModel({ maxLength: 5 })
  insertPaste(model, 'abcdefgh')
  assert.deepEqual(model.lines, ['abcde'])
  assert.equal(model.statusText, 'Maximum 5 characters')
  assert.equal(model.visualState, 'error')
})

test('insertPaste stops at the line budget', () => {
  const model = createModel({ maxLines: 2 })
  insertPaste(model, 'a\nb\nc')
  assert.deepEqual(model.lines, ['a', 'b'])
  assert.equal(model.statusText, 'Maximum 2 lines')
  assert.equal(model.visualState, 'error')
})

