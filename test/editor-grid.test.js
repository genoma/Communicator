// Screen-level tests for the frame-diffing editor (src/editor/). A small
// in-memory terminal emulates the ANSI writes the editor paints, so scenarios
// assert on the final screen grid (what the user sees), not on byte streams —
// the ghost-line / duplicate-line bug class is exactly a screen-state bug.
/* eslint-disable no-control-regex */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import stringWidth from 'string-width'
import { readEditor } from '../src/editor/index.js'
import { firstDiffRow, rowBody } from '../src/editor/paint.js'
import { wrapSegments } from '../src/editor/layout.js'
import { stringWidth as editorStringWidth, charWidth as editorCharWidth, colFromVisual, visualCol } from '../src/editor/chars.js'

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
      submitRender: 'preserve',
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

async function run(t, chunks, opts) {
  const h = setup(t, opts)
  for (const chunk of chunks) h.stdin.emit('data', chunk)
  return h
}

// --- Screen parity during typing ---

test('typing renders the expected prompt lines on screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t)
  type(stdin, 'hello world')
  assert.equal(term.lines().slice(0, 1)[0], '❯ hello world')
  assert.equal(term.cursor.c, '❯ hello world'.length)
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'hello world')
})

test('text wider than the terminal wraps explicitly, no soft-wrap reliance', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 20 })
  type(stdin, 'the quick brown fox jumps')
  const lines = term.lines().filter((l) => l !== '')
  assert.deepEqual(lines, [
    '❯ the quick brown', // word-aware fold: 15 chars under the usable width (20 - 2)
    '❯ fox jumps',
  ])
  submit(stdin)
  await editor
})

test('word-aware folding keeps the cursor row and column exact', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 20 })
  type(stdin, 'aaa bbb ccc ddd eee')
  const lines = term.lines().filter((l) => l !== '')
  assert.deepEqual(lines, [
    '❯ aaa bbb ccc ddd',
    '❯ eee',
  ])
  // End of text: right after 'eee' (the folded space is not counted).
  assert.deepEqual(term.cursor, { r: 1, c: 5 })
  press(stdin, '\x1b[D')
  assert.deepEqual(term.cursor, { r: 1, c: 4 })
  press(stdin, '\x1b[D')
  press(stdin, '\x1b[D')
  press(stdin, '\x1b[D')
  // On the dropped fold space: the cursor parks at the end of the first row.
  assert.deepEqual(term.cursor, { r: 0, c: 17 })
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'aaa bbb ccc ddd eee')
})

test('typing exactly to the right margin then one more char keeps every letter', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 20 })
  // 18 chars: the input row fills the terminal exactly (2 prefix + 18 = 20).
  type(stdin, 'abcdefghijklmnopqr')
  assert.deepEqual(term.lines().filter((l) => l !== ''), ['❯ abcdefghijklmnopqr'])
  // The editor positions the cursor at the margin (CHA clamps there in real
  // terminals) and never leaves the pending-wrap flag set behind a paint.
  assert.deepEqual(term.cursor, { r: 0, c: 19 })
  assert.equal(term.wrapPending, false)
  // One more char wraps onto a second row; nothing is eaten at the margin.
  type(stdin, 'X')
  assert.deepEqual(term.lines().filter((l) => l !== ''), [
    '❯ abcdefghijklmnopqr',
    '❯ X',
  ])
  type(stdin, 'YZ')
  assert.deepEqual(term.lines().filter((l) => l !== ''), [
    '❯ abcdefghijklmnopqr',
    '❯ XYZ',
  ])
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'abcdefghijklmnopqrXYZ')
})

test('backspace at the exact right margin removes the last letter cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 20 })
  type(stdin, 'abcdefghijklmnopqr')
  press(stdin, '\x7f')
  assert.deepEqual(term.lines().filter((l) => l !== ''), ['❯ abcdefghijklmnopq'])
  assert.deepEqual(term.cursor, { r: 0, c: 19 })
  press(stdin, '\x7f')
  assert.deepEqual(term.lines().filter((l) => l !== ''), ['❯ abcdefghijklmnop'])
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'abcdefghijklmnop')
})

test('wide (CJK) characters never split at the wrap edge', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 12 })
  // usable width is 10; a final 1-column slot cannot split a wide char
  type(stdin, 'abcdef中中x')
  const lines = term.lines().filter((l) => l !== '')
  assert.deepEqual(lines, [
    '❯ abcdef中中',
    '❯ x',
  ])
  submit(stdin)
  await editor
})

test('backspace across wrap boundaries keeps the screen exact', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 12 })
  type(stdin, 'abcdefghij')
  press(stdin, '\x7f')
  press(stdin, '\x7f')
  press(stdin, '\x7f')
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'abcdefg')
  assert.deepEqual(term.lines().filter((l) => l !== ''), ['❯ abcdefg'])
})

test('past the screen width of "❯ " prefix, cursor column stays on the input text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 14 })
  type(stdin, 'abcdefghijklmnop') // wraps at col 14 (prefix 2)
  // second wrapped row: cursor at end after 'mnop'
  assert.equal(term.cursor.r, 1)
  assert.equal(term.lines()[1], '❯ mnop')
  submit(stdin)
  await editor
})

// --- Paste ghost-line regression (screen level) ---

test('paste into existing multiline input never leaves ghost duplicates on screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { rows: 12 })
  type(stdin, 'line 0\n')
  type(stdin, 'line 1\n')
  stdin.emit('data', '\x1b[200~line 2\nline 3\x1b[201~')
  const lines = term.lines().filter((l) => l !== '')
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'line 0\nline 1\nline 2\nline 3')
  for (const expected of ['❯ line 0', '❯ line 1', '❯ line 2', '❯ line 3']) {
    assert.equal(lines.filter((l) => l === expected).length, 1, `${expected} appears exactly once`)
  }
})

test('repeated pastes replicate nothing on screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t)
  type(stdin, 'one\n')
  stdin.emit('data', '\x1b[200~two\x1b[201~')
  stdin.emit('data', '\x1b[200~three\x1b[201~')
  const lines = term.lines().filter((l) => l !== '')
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'one\ntwothree')
  assert.equal(lines.filter((l) => l === '❯ one').length, 1)
  assert.equal(lines.filter((l) => l === '❯ twothree').length, 1)
})

test('paste into empty input shows exactly the pasted content', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdin, editor } = setup(t)
  stdin.emit('data', '\x1b[200~cerametal\x1b[201~')
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'cerametal')
})

test('block taller than the viewport keeps the cursor on the visible content', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { rows: 4 })
  stdin.emit('data', '\x1b[200~line 0\nline 1\nline 2\nline 3\nline 4\nline 5\x1b[201~')
  press(stdin, '\r')
  const [value] = await editor
  assert.equal(value, 'line 0\nline 1\nline 2\nline 3\nline 4\nline 5')
  // The editor paints forward while taller than the viewport; the visible
  // window holds the *tail* of the block (never the transcript above).
  assert.ok(term.lines().some((l) => l.includes('line 5')))
})

// --- Resize / reflow ---

test('resize with a repaint hook rebuilds the block after the hooked transcript', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let hookWrites = []
  const { term, stdin, editor } = setup(t, {
    rows: 24,
    options: {
      onResizeRepaint: () => {
        hookWrites = term.lines().map((l) => l)
        term.grid = term.grid.map(() => Array.from({ length: term.cols }, () => ''))
        term.cursor = { r: 0, c: 0 }
        term.plot('assistant line\n\n')
      },
    },
  })
  type(stdin, 'test\n')
  type(stdin, 'second line')
  term.resize(60, 18)
  await t.mock.timers.tick(80)
  const lines = term.lines().filter((l) => l !== '')
  assert.ok(lines.some((l) => l === 'assistant line'))
  assert.equal(lines.filter((l) => l === '❯ test').length, 1, 'input line appears once')
  assert.equal(lines.filter((l) => l === '❯ second line').length, 1)
  press(stdin, '\r')
  const [value] = await editor
  assert.equal(value, 'test\nsecond line')
  void hookWrites
})

test('resize without a hook queries DSR and repaints absolutely, no duplicates', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t)
  type(stdin, 'test\n')
  type(stdin, 'second line')
  term.resize(60, 18)
  await t.mock.timers.tick(80)
  assert.equal(term.dsrQueries, 1, 'DSR was queried')
  await t.mock.timers.tick(10)
  const lines = term.lines().filter((l) => l !== '')
  assert.equal(lines.filter((l) => l === '❯ test').length, 1)
  assert.equal(lines.filter((l) => l === '❯ second line').length, 1)
  press(stdin, '\r')
  const [value] = await editor
  assert.equal(value, 'test\nsecond line')
})

test('resize with no DSR reply falls back to an in-place rewrite', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { autoDsr: false })
  type(stdin, 'one line')
  term.resize(50, 16)
  await t.mock.timers.tick(80)
  await t.mock.timers.tick(400)
  const lines = term.lines().filter((l) => l !== '')
  assert.equal(lines.filter((l) => l === '❯ one line').length, 1)
  press(stdin, '\r')
  const [value] = await editor
  assert.equal(value, 'one line')
})

// --- Editing semantics ---

test('undo and redo restore content and screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdin, editor } = setup(t)
  type(stdin, 'abc')
  press(stdin, '\x1a') // Ctrl+Z
  press(stdin, '\x19') // Ctrl+Y
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'abc')
})

test('word-kill (Ctrl+W), line-kill (Ctrl+U/K) keep screen parity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t)
  type(stdin, 'foo bar baz')
  press(stdin, '\x17') // Ctrl+W
  const afterWord = term.lines().filter((l) => l !== '')
  assert.deepEqual(afterWord, ['❯ foo bar ']) // the space before the killed word stays (vendor parity)
  press(stdin, '\x15') // Ctrl+U
  assert.deepEqual(term.lines().filter((l) => l !== ''), ['❯ '])
  type(stdin, 'x')
  press(stdin, '\x0b') // Ctrl+K
  assert.deepEqual(term.lines().filter((l) => l !== ''), ['❯ x'])
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'x')
})

test('history navigation recalls entries and restores the draft', async (t) => {
  const { editor } = await run(t, ['draft text', '\x1b[A', '\x1b[B', '\r'], {
    options: { history: ['first', 'second'] },
  })
  const [value] = await editor
  assert.equal(value, 'draft text')
})

test('typing / shows the suggestion list in the footer window, Escape restores', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, {
    options: { suggest: () => ['/quit', '/smooth', '/status'] },
  })
  type(stdin, '/')
  let lines = term.lines().filter((l) => l !== '')
  assert.deepEqual(lines.slice(1), ['› /quit', '  /smooth', '  /status'])

  type(stdin, 's')
  lines = term.lines().filter((l) => l !== '')
  assert.deepEqual(lines.slice(1), ['› /smooth', '  /status'])

  submit(stdin)
  const [value] = await editor
  assert.equal(value, '/s')
})

test('Escape dismisses the list: prefix restored, footer hidden, session stays closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, {
    options: { suggest: () => ['/quit', '/smooth', '/status'] },
  })
  type(stdin, '/m')
  stdin.emit('data', '\x1b') // dismiss
  await t.mock.timers.tick(50) // the lone-Escape flush
  assert.deepEqual(
    term.lines().filter((l) => l !== ''),
    ['❯ /m'],
    'prefix restored and the suggestion rows are gone'
  )
  // The session must not come back on the next repaint alone: an arrow (cursor
  // move, no content change) keeps the list hidden...
  press(stdin, '\x01') // Ctrl+A: cursor move only
  assert.deepEqual(term.lines().filter((l) => l !== ''), ['❯ /m'])
  // ...while the next content edit re-evaluates the prefix naturally.
  type(stdin, 'o') // cursor sits at line start after Ctrl+A
  assert.deepEqual(
    term.lines().filter((l) => l !== ''),
    ['❯ o/m'],
    'non-matching continuation keeps the list hidden'
  )
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'o/m')
})

test('the suggestion list reflects only the gated commands passed in', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { visibleChatCommands } = await import('../src/commands/chat/index.js')
  const make = async (gated) => {
    const h = setup(t, { options: { suggest: () => gated } })
    type(h.stdin, '/')
    const rows = h.term.lines().filter((l) => l !== '')
    h.stdin.emit('data', '\x03') // cancel: no submit, just close
    const [, err] = await h.editor
    assert.equal(err?.kind, 'cancel')
    return rows
  }
  const textOnly = visibleChatCommands({ visionSupported: false, providerName: 'openrouter' })
  assert.ok(!textOnly.includes('/attach') && !textOnly.includes('/attachments') && !textOnly.includes('/scrape'))
  const nonVision = await make(textOnly)
  assert.ok(nonVision.some((l) => l === '› /quit'), 'commands show')
  assert.ok(!nonVision.some((l) => l.includes('/attach')), '/attach hidden for text-only models')
  assert.ok(!nonVision.some((l) => l.includes('/scrape')), '/scrape hidden outside Venice')

  const full = visibleChatCommands({ visionSupported: true, providerName: 'openrouter' })
  const vision = await make(full)
  assert.ok(vision.some((l) => l === '  /attach' || l.startsWith('› /attach')), '/attach shown for vision models')
  assert.ok(vision.some((l) => l.startsWith('  /attachments') || l.startsWith('› /attachments')))
  assert.ok(!vision.some((l) => l.includes('/scrape')), '/scrape hidden outside Venice')
})

test('submit erases the suggestion list so picker output lands clean', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, {
    options: { suggest: () => ['/quit', '/smooth', '/status'] },
  })
  type(stdin, '/s')
  stdin.emit('data', '\t') // fills /smooth, list stays open (vendored parity)
  submit(stdin)
  const [value] = await editor
  assert.equal(value, '/smooth')
  assert.deepEqual(
    term.lines().filter((l) => l !== ''),
    ['❯ /smooth'],
    'only the submitted line remains; the list rows are erased'
  )
})

test('command suggestions fill the line with Tab and dismiss with Escape', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdin, editor } = setup(t, {
    options: { suggest: () => ['/quit', '/smooth', '/status'] },
  })
  type(stdin, '/s')
  stdin.emit('data', '\t')
  stdin.emit('data', '\x1b') // dismiss
  stdin.emit('data', '\t')
  submit(stdin)
  const [value] = await editor
  assert.equal(value, '/smooth')
})

// --- Lifecycle ---

test('Cancel returns the partial value and restores the screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t)
  type(stdin, 'abc')
  press(stdin, '\x03')
  const [value, error] = await editor
  assert.equal(value, 'abc')
  assert.equal(error?.kind, 'cancel')
  assert.ok(term.lines().slice(0, 1)[0] === '')
})

test('Ctrl+D is unbound: it neither deletes nor ends the input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h1 = setup(t)
  press(h1.stdin, '\x04')
  assert.ok(h1.term.lines().some((l) => l === '❯ '), 'prompt stays on screen after Ctrl+D')
  submit(h1.stdin)
  const [v1] = await h1.editor
  assert.equal(v1, '')

  const h2 = setup(t)
  type(h2.stdin, 'ab')
  press(h2.stdin, '\x01') // line start
  press(h2.stdin, '\x04')
  assert.deepEqual(h2.term.lines().filter((l) => l !== ''), ['❯ ab'], 'Ctrl+D does not delete')
  submit(h2.stdin)
  const [v2] = await h2.editor
  assert.equal(v2, 'ab')
})

// --- Paint kernel (unit) ---

test('firstDiffRow finds the first changed row', () => {
  assert.equal(firstDiffRow(['a', 'b', 'c'], ['a', 'b', 'c']), -1)
  assert.equal(firstDiffRow(['a', 'x', 'c'], ['a', 'b', 'c']), 1)
  assert.equal(firstDiffRow(['a', 'b'], ['a']), 1)
  assert.equal(firstDiffRow(['a'], ['a', 'b']), 1)
})

test('rowBody joins rows with erase-to-EOL and newlines', () => {
  assert.equal(rowBody(['x', 'y'], 80), 'x\x1b[K\r\ny\x1b[K')
})

test('rowBody never erases after a row that fills the terminal exactly', () => {
  // The cursor parks on the last cell after the last character of a full row;
  // erase-to-EOL would clear that very cell (the row's last letter).
  assert.equal(rowBody(['abcdef'], 6), 'abcdef')
  assert.equal(rowBody(['abcdef', 'x'], 6), 'abcdef\r\nx\x1b[K')
  assert.equal(rowBody(['abcdef', 'xyz'], 6), 'abcdef\r\nxyz\x1b[K')
})

test('wrapSegments never splits a wide char and folds at word boundaries', () => {
  // No spaces: long words still hard-cut at the exact width.
  assert.deepEqual(wrapSegments('abcde', 3), ['abc', 'de'])
  assert.deepEqual(wrapSegments('abcde', 5), ['abcde'])
  assert.deepEqual(wrapSegments('中a中', 3), ['中a', '中'])
  // Words that do not fit start the next segment; the fold space is dropped.
  assert.deepEqual(wrapSegments('aa bb cc', 4), ['aa', 'bb', 'cc'])
  assert.deepEqual(wrapSegments('the quick brown fox jumps', 10), ['the quick', 'brown fox', 'jumps'])
  assert.deepEqual(wrapSegments('a b c d e f g', 3), ['a b', 'c d', 'e f', 'g'])
  // A space that would cross the width is the fold point: it is dropped and
  // the next word starts a fresh row (rows never exceed the terminal width).
  assert.deepEqual(wrapSegments('aaaa bbbbb', 5), ['aaaa', 'bbbbb'])
  assert.deepEqual(wrapSegments('', 3), [''])
})

test('wrapSegments never emits an empty segment at limit 1 with wide chars', () => {
  // A wide char cannot fit the 1-column row: the hard cut must not push a
  // ghost blank segment (it would paint an extra empty row and shift every
  // later cursor row).
  assert.deepEqual(wrapSegments('a 文', 1), ['a', '文'])
  assert.deepEqual(wrapSegments('中A', 1), ['中', 'A'])
})

test('typing to the exact row width never duplicates rows across a fold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 64 })
  const l1 = '"I mean..." I stand up "Wouldn\'t be easy to let out to the public, the absolute abominion they did in the past centuries? Guide the rebel and put the soldier against them, directly?'
  const l2 = '"Wouldn\'t be easier to flush them out, get them in those nice quantum locks they created for me?" I stop walking in circles "Would it work?" I open my hand a million timelines starts'
  type(stdin, l1)
  type(stdin, '\n')
  type(stdin, l2)
  await t.mock.timers.tick(50)
  const lines = term.lines().filter((l) => l.trim() !== '')
  assert.deepEqual(lines, [
    '❯ "I mean..." I stand up "Wouldn\'t be easy to let out to the',
    '❯ public, the absolute abominion they did in the past centuries?',
    '❯ Guide the rebel and put the soldier against them, directly?',
    '❯ "Wouldn\'t be easier to flush them out, get them in those nice',
    '❯ quantum locks they created for me?" I stop walking in circles',
    '❯ "Would it work?" I open my hand a million timelines starts',
  ])
  submit(stdin)
  const [value] = await editor
  assert.equal(value, `${l1}\n${l2}`)
})

// --- Cursor mapping in display space (wide chars) ---

test('cursor maps wide chars by display column, not code-unit offset', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 12 })
  type(stdin, 'abcdef中中x') // wraps at usable width 10: 'abcdef中中' | 'x'
  // End of text: after 'x' — display col 1 on the second row.
  assert.deepEqual(term.cursor, { r: 1, c: 3 })
  press(stdin, '\x1b[D') // before 'x'
  assert.deepEqual(term.cursor, { r: 1, c: 2 })
  press(stdin, '\x1b[D') // after 中#1 → display col 8 on row 0
  assert.deepEqual(term.cursor, { r: 0, c: 10 })
  press(stdin, '\x1b[D') // before 中#1 → display col 6
  assert.deepEqual(term.cursor, { r: 0, c: 8 })
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'abcdef中中x')
})

test('word-aware folding keeps display columns exact with wide chars', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 8 }) // usable width 6
  type(stdin, 'aa 中 中bb') // folds: 'aa 中' | '中bb' (the second space is the fold)
  assert.deepEqual(term.lines().filter((l) => l !== ''), ['❯ aa 中', '❯ 中bb'])
  // End: after 'bb' — display col 4 of the second row (the dropped space is
  // not counted, the wide 中 is 2 columns).
  assert.deepEqual(term.cursor, { r: 1, c: 6 })
  press(stdin, '\x1b[D') // before b#2
  assert.deepEqual(term.cursor, { r: 1, c: 5 })
  press(stdin, '\x1b[D') // before b#1
  assert.deepEqual(term.cursor, { r: 1, c: 4 })
  press(stdin, '\x1b[D') // before 中#2 → start of the second row
  assert.deepEqual(term.cursor, { r: 1, c: 2 })
  press(stdin, '\x1b[D') // on the dropped fold space: parks at end of row 0
  assert.deepEqual(term.cursor, { r: 0, c: 7 })
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'aa 中 中bb')
})

// --- Editing semantics ---

test('undo groups do not span a cursor move', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdin, editor } = setup(t)
  type(stdin, 'abc')
  press(stdin, '\x1b[D') // left: an undo-group boundary
  type(stdin, 'de') // => 'abdec'
  press(stdin, '\x1a') // Ctrl+Z: only the second insert group
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'abc')
})

test('undo across a cursor move restores the cursor position of the group', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdin, editor } = setup(t)
  type(stdin, 'abc')
  press(stdin, '\x1b[D')
  type(stdin, 'de')
  press(stdin, '\x1a') // undo 'de' → 'abc' with the cursor after 'b'
  type(stdin, 'X') // inserts at the restored position: 'abXc'
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'abXc')
})

test('word jumps stay on char boundaries and never corrupt a surrogate pair', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdin, editor } = setup(t)
  type(stdin, 'a😀b')
  press(stdin, '\x1b[1;3D') // Alt+Left: word left of 'b'
  press(stdin, '\x1b[1;3C') // Alt+Right: back to the end
  type(stdin, '!')
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'a😀b!')
})

test('paste beyond maxLines stops instead of merging the overflow', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdin, editor } = setup(t, { options: { maxLines: 2, initialValue: 'x' } })
  type(stdin, '\x1b[200~a\nbc\nd\x1b[201~')
  submit(stdin)
  await t.mock.timers.tick(0)
  const [value] = await editor
  assert.equal(value, 'xa\nbc')
})

test('stdin EOF tears the editor down and resolves as an EOF cancel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t)
  let rawOff = false
  let paused = false
  stdin.setRawMode = (on) => {
    if (on === false) rawOff = true
  }
  stdin.pause = () => {
    paused = true
  }
  const writes = []
  const out = term.out
  const write = out.write.bind(out)
  out.write = (chunk) => {
    writes.push(String(chunk))
    write(chunk)
  }
  type(stdin, 'partial')
  stdin.emit('end')
  const [value, error] = await editor
  assert.equal(value, 'partial')
  assert.equal(error.kind, 'eof')
  assert.equal(rawOff, true)
  assert.equal(paused, true)
  const all = writes.join('')
  assert.ok(all.includes('\x1b[?2004l'), 'bracketed paste disabled')
  assert.ok(all.includes('\x1b[<u'), 'kitty protocol disabled')
})

test('a paste starting while an escape tail is held joins cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdin, editor } = setup(t, { options: { suggest: () => ['/quit'] } })
  type(stdin, '/') // open a suggestion session
  press(stdin, '\x1b') // lone ESC: dismissed after the 50 ms flush — but a
  // paste arrives before the flush: the held tail must not swallow the
  // paste marker (it would be re-dispatched as one unknown escape and the
  // whole paste would be lost).
  type(stdin, '\x1b[200~paste text\x1b[201~')
  await t.mock.timers.tick(50)
  submit(stdin)
  await t.mock.timers.tick(0)
  const [value] = await editor
  assert.equal(value, '/paste text')
})

// Width-oracle guards. The editor's own width table (src/editor/chars.js) must
// never measure a character as NARROWER than the terminal renders it: an
// under-count packs too much into a grid row, the terminal soft-wraps it, and
// the grid<->screen 1:1 mapping desyncs into ghost duplicate rows. Over-counting
// is permitted (a row folds early — cosmetic), which is why these assert an
// upper bound on row width rather than an exact layout.
function realWidth(row) {
  return clustersOf(row).reduce((sum, ch) => sum + cells(ch), 0)
}

test('an emoji in the input never produces a ghost duplicate row', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 80, options: { helpFooter: true } })
  const typed = 'Hey there, can you summarize this thread for me please \u{1F600} and then list the action items?'
  type(stdin, typed)

  // The grid can never physically hold more than `cols` cells, so an
  // over-wide row shows up as DUPLICATED CONTENT: the terminal soft-wrapped a
  // row the editor believed was one row, and the next repaint left the stale
  // tail behind. Reconstructing the value from the visible input rows catches
  // exactly that (word folding drops the fold space, so compare on collapsed
  // whitespace).
  const inputRows = term.lines().filter((l) => l.startsWith('\u276f '))
  const rebuilt = inputRows.map((l) => l.slice(2).trimEnd()).join(' ').replace(/\s+/g, ' ').trim()
  assert.equal(rebuilt, typed.replace(/\s+/g, ' ').trim(), `screen does not reconstruct the typed text:\n${inputRows.join('\n')}`)
  submit(stdin)
  await editor
})

test('an emoji at the exact row width is not erased from the screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 20 })
  // 2 prefix + 16 'a' + a 2-cell emoji fills the row exactly. rowBody must not
  // append \x1b[K here: the erase would wipe the glyph the terminal just drew,
  // leaving the character in the buffer but invisible on screen.
  type(stdin, 'a'.repeat(16) + '😀')

  const screen = term.lines().join('')
  assert.ok(screen.includes('😀'), `the emoji vanished from the screen:\n${term.lines().filter((l) => l !== '').join('\n')}`)
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'a'.repeat(16) + '😀')
})

test('charWidth never under-counts what the terminal renders', () => {
  // Over-counts are allowed and expected (chars.js has no grapheme clustering,
  // so a ZWJ family or a skin-tone sequence measures as the sum of its parts).
  // Under-counts are the bug class: they are what desyncs the grid.
  for (const sample of ['😀', '⚡', '⚠️', '❤️', '👨‍👩‍👧‍👦', '1️⃣', '🇫🇷', '👍🏽', '中', '！', 'é', 'a']) {
    const measured = editorStringWidth(sample)
    const rendered = realWidth(sample)
    assert.ok(measured >= rendered, `chars.js measures ${JSON.stringify(sample)} as ${measured}, terminal renders ${rendered}`)
  }
})

// The width table in src/editor/chars.js is hardcoded, but the rest of the
// rule set (\p{Emoji_Presentation}) and the string-width truth oracle both
// track the RUNTIME's Unicode data. So a Node upgrade can introduce new
// under-counts — new instances of the ghost-row bug — with no code change.
// This is the alarm for that: it fails when the table falls behind the
// runtime, and the fix is mechanical (add the reported range to WIDE_RANGES).
// Scoped to the BMP plus plane 1, which is where all realistic wide text and
// every emoji live; sweeping all 17 planes costs seconds for no added signal.
test('the width table has not fallen behind the runtime Unicode data', () => {
  const under = []
  for (let cp = 0x20; cp <= 0x1ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const ch = String.fromCodePoint(cp)
    if (editorCharWidth(cp) < stringWidth(ch)) under.push(cp)
  }
  const hex = (n) => 'U+' + n.toString(16).toUpperCase().padStart(4, '0')
  const ranges = []
  for (const cp of under) {
    const last = ranges[ranges.length - 1]
    if (last && last[1] === cp - 1) last[1] = cp
    else ranges.push([cp, cp])
  }
  assert.deepEqual(
    under,
    [],
    `chars.js under-counts ${under.length} code points the runtime renders wider; add to WIDE_RANGES: ` +
      ranges.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}..${hex(b)}`)).join(' ')
  )
})

test('shrinking from a multiline tail clears the stale rows and parks the cursor (no helpFooter)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 12 })
  // 25 chars wrap to 3 rows ('❯ abcdefghij' / '❯ klmnopqrst' / '❯ uvwxy').
  type(stdin, 'abcdefghijklmnopqrstuvwxy')
  assert.deepEqual(term.lines().slice(0, 3), ['❯ abcdefghij', '❯ klmnopqrst', '❯ uvwxy'])
  // Deleting the tail char by char shrinks the grid 3 -> 2 rows; the step
  // where the trailing row vanishes leaves no row to rewrite, so the cursor
  // must still climb back to the new last row instead of parking one row
  // below the block (the ghost-row bug).
  for (let i = 0; i < 10; i++) press(stdin, '\x7f')
  assert.deepEqual(term.lines().slice(0, 3), ['❯ abcdefghij', '❯ klmno', ''])
  assert.deepEqual(term.cursor, { r: 1, c: 7 })
  type(stdin, 'XYZ')
  assert.deepEqual(term.lines().slice(0, 3), ['❯ abcdefghij', '❯ klmnoXYZ', ''])
  assert.deepEqual(term.cursor, { r: 1, c: 10 })
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'abcdefghijklmnoXYZ')
})

test('combining mark after a base is one cell (marks zero in context)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 12 })
  // 'e' + U+0301 is one terminal cell; the row must not split the pair.
  type(stdin, 'e\u0301')
  assert.deepEqual(term.lines().slice(0, 2), ['❯ e\u0301', ''])
  assert.deepEqual(term.cursor, { r: 0, c: 3 })
  // Two more bases confirm the grid keeps counting display columns.
  type(stdin, 'bc')
  assert.deepEqual(term.lines().slice(0, 2), ['❯ e\u0301bc', ''])
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'e\u0301bc')
})

test('a lone combining mark occupies one cell (never a zero-width row)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 12 })
  type(stdin, '\u0301')
  assert.deepEqual(term.lines().slice(0, 2), ['❯ \u0301', ''])
  assert.deepEqual(term.cursor, { r: 0, c: 3 })
  submit(stdin)
  const [value] = await editor
  assert.equal(value, '\u0301')
})

test('a hard-cut base leaves its mark to start the next row as one cell', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 12 })
  // usable width 10: 10 bases fill the row exactly; the next wide char must
  // fold and the mark after it starts the next row alone.
  type(stdin, 'abcdefghij\u4e00\u0301')
  const lines = term.lines().filter((l) => l !== '')
  assert.deepEqual(lines, ['❯ abcdefghij', '❯ \u4e00\u0301'])
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'abcdefghij\u4e00\u0301')
})

test('spacing marks keep width 1 (Mc keycap and Devanagari vowels never under-count)', () => {
  // U+093E is a spacing mark: it consumes a cell, so it must stay 1 like the
  // terminal's cluster measurement. U+20E3 (keycap) is an enclosing mark.
  for (const sample of ['क\u093e', '1\u20e3']) {
    const measured = editorStringWidth(sample)
    const rendered = realWidth(sample)
    assert.ok(measured >= rendered, `chars.js measures ${JSON.stringify(sample)} as ${measured}, terminal renders ${rendered}`)
  }
})

test('a spacing-mark cluster never measures narrower than the terminal (no ghost row)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { term, stdin, editor } = setup(t, { cols: 12 })
  // 'a'*9 + क + U+093E = 11 cells at cols 12 (usable 10): the row must fold
  // before it would exceed 10 cells — the spacing mark keeps width 1, so the
  // fold happens at 10 real cells, not 9 (which would leave an 11-cell row
  // that soft-wraps and ghosts).
  type(stdin, 'a'.repeat(9) + '\u0915\u093e')
  const lines = term.lines().filter((l) => l !== '')
  const screen = lines.join(' ')
  assert.ok(screen.includes('\u0915') && screen.includes('\u093e'), 'both Devanagari code points must stay on screen')
  for (const row of lines) {
    const width = [...row].reduce((sum, ch) => sum + editorStringWidth(ch), 0)
    assert.ok(width <= 12, `row exceeds the terminal width: ${JSON.stringify(row)} (${width})`)
  }
  submit(stdin)
  const [value] = await editor
  assert.equal(value, 'a'.repeat(9) + '\u0915\u093e')
})

test('colFromVisual inverts visualCol across combining marks (cursor preservation)', () => {
  const line = 'e\u0301x'
  assert.equal(visualCol(line, 3), 2)
  assert.equal(colFromVisual(line, 2), 3)
  // Round trip: every valid column maps back to a point with the same width.
  for (let col = 0; col <= editorStringWidth(line); col++) {
    const idx = colFromVisual(line, col)
    assert.equal(visualCol(line, idx), col)
  }
})
