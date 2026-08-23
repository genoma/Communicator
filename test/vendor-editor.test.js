import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The history file path is derived from the home dir at module load, so the
// os mock must be registered before input.js is imported.
const tempHome = await mkdtemp(join(tmpdir(), 'communicator-vendor-home-'))
mock.module('node:os', { namedExports: { homedir: () => tempHome } })
after(() => rm(tempHome, { recursive: true, force: true }))

const { readInput } = await import('../src/input.js')
const { readMultiline } = await import('../src/vendor/read-multiline/index.js')
const { _resetKittyDetection } = await import('../src/vendor/read-multiline/footer.js')

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

function installFakeStdin(t, stdin) {
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  t.after(() => {
    delete process.stdin
  })
}

async function submitInput(t, stdin, ...chunks) {
  const pending = readInput({ commands: ['/quit', '/smooth', '/status'] })
  for (const chunk of chunks) stdin.emit('data', chunk)
  return pending
}

test('arrow-up recalls the persisted prompt history', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  _resetKittyDetection(false)
  const historyDir = join(tempHome, '.communicator')
  await mkdir(historyDir, { recursive: true })
  await writeFile(join(historyDir, 'history.json'), JSON.stringify(['first prompt', 'second prompt']))

  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = submitInput(t, stdin, '\x1b[A', '\r')
  const result = await pending
  assert.deepEqual(result, { value: 'second prompt' })
})

test('Tab cycles the command suggestion list', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  _resetKittyDetection(false)

  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = submitInput(t, stdin, '/s', '\t', '\r')
  const result = await pending
  assert.deepEqual(result, { value: '/smooth' })
})

test('arrow-down restores the draft after recall', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  _resetKittyDetection(false)

  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = submitInput(t, stdin, 'draft text', '\x1b[A', '\x1b[B', '\r')
  const result = await pending
  assert.deepEqual(result, { value: 'draft text' })
})

function fakeOutput(t, rows) {
  const writes = []
  const output = {
    columns: 80,
    rows,
    isTTY: true,
    write: (chunk) => {
      writes.push(String(chunk))
      return true
    },
    on: () => {},
    removeListener: () => {},
  }
  return { output, writes }
}

async function runEditor(t, { rows, chunks, submit }) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  _resetKittyDetection(false)
  const { output, writes } = fakeOutput(t, rows)
  const stdin = fakeStdin()
  const pending = readMultiline('', {
    input: stdin,
    output,
    prefix: '',
    linePrefix: '> ',
    helpFooter: false,
    maxLines: 50,
    theme: { linePrefix: { pending: 'cyan', submitted: 'dim', cancelled: 'dim' }, submitRender: 'preserve' },
  })
  for (const chunk of chunks) stdin.emit('data', chunk)
  if (submit) stdin.emit('data', '\r')
  const [value] = await pending
  return { value, writes }
}

function buildPaste(lines) {
  return `\x1b[200~${lines.join('\n')}\x1b[201~`
}

// Like runEditor, but exposes the pending promise so cancel/EOF and
// timer-driven recovery cases can drive input before awaiting.
function runEditorTuple(t, { rows, chunks }) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  _resetKittyDetection(false)
  const { output, writes } = fakeOutput(t, rows)
  const stdin = fakeStdin()
  const pending = readMultiline('', {
    input: stdin,
    output,
    prefix: '',
    linePrefix: '> ',
    helpFooter: false,
    maxLines: 50,
    theme: { linePrefix: { pending: 'cyan', submitted: 'dim', cancelled: 'dim' }, submitRender: 'preserve' },
  })
  for (const chunk of chunks) stdin.emit('data', chunk)
  return { pending, writes, stdin }
}

test('paste split in the middle of the start marker is reassembled', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[2', '00~hello world\x1b[201~', '\r'] })
  const [value] = await pending
  assert.equal(value, 'hello world')
})

test('paste split in the middle of the end marker is reassembled', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[200~hello world\x1b[2', '01~', '\r'] })
  const [value] = await pending
  assert.equal(value, 'hello world')
})

test('paste split at arbitrary byte boundaries is reassembled', async (t) => {
  const payload = 'alpha beta gamma\ndelta epsilon\nzeta'
  const bytes = `\x1b[200~${payload}\x1b[201~`
  const chunks = []
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7))
  const { pending } = runEditorTuple(t, { chunks: [...chunks, '\r'] })
  const [value] = await pending
  assert.equal(value, payload)
})

test('paste split at every byte boundary is reassembled', async (t) => {
  const payload = 'one two three\nfour five six'
  const bytes = `\x1b[200~${payload}\x1b[201~`
  const chunks = []
  for (let i = 0; i < bytes.length; i++) chunks.push(bytes[i])
  const { pending } = runEditorTuple(t, { chunks: [...chunks, '\r'] })
  const [value] = await pending
  assert.equal(value, payload)
})

test('keys keep working after a split paste end marker', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[200~hi\x1b[2', '01~', 'x', '\r'] })
  const [value] = await pending
  assert.equal(value, 'hix')
})

test('Ctrl+C cancels after a split paste end marker', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[200~hi\x1b[2', '01~', '\x03'] })
  const [, error] = await pending
  assert.equal(error?.kind, 'cancel')
})

test('backspace works after a split paste end marker', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[200~hello\x1b[2', '01~', '\x7f', '\r'] })
  const [value] = await pending
  assert.equal(value, 'hell')
})

test('paste with a lost end marker recovers when the stream goes quiet', async (t) => {
  const { pending, stdin } = runEditorTuple(t, { chunks: ['\x1b[200~stuck text'] })
  t.mock.timers.tick(1600)
  stdin.emit('data', 'x')
  stdin.emit('data', '\r')
  const [value] = await pending
  assert.equal(value, 'stuck textx')
})

test('kitty Ctrl+C cancels', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[99;5u'] })
  const [, error] = await pending
  assert.equal(error?.kind, 'cancel')
})

test('kitty Ctrl+C mixed with typed text cancels with the partial input', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['abc\x1b[99;5u'] })
  const [value, error] = await pending
  assert.equal(error?.kind, 'cancel')
  assert.equal(value, 'abc')
})

test('kitty Enter submits', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[13u'] })
  const [value] = await pending
  assert.equal(value, '')
})

test('escape sequences split across chunks are reassembled', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[1', ';5C', '\r'] })
  const [value] = await pending
  assert.equal(value, '')
})

test('Enter arriving in the same chunk as the paste end marker submits', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[200~hi\x1b[201~\r'] })
  const [value] = await pending
  assert.equal(value, 'hi')
})

test('repeated pastes accumulate without corruption', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[200~aaa\x1b[2', '01~', '\x1b[200~bbb\x1b[201~', '\r'] })
  const [value] = await pending
  assert.equal(value, 'aaabbb')
})

test('CRLF in pasted text is normalized', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['\x1b[200~a\r\nb\r\x1b[201~', '\r'] })
  const [value] = await pending
  assert.equal(value, 'a\nb\n')
})

test('paste into existing input keeps keys working after', async (t) => {
  const { pending } = runEditorTuple(t, { chunks: ['one', '\x1b[200~two\x1b[2', '01~', 'three', '\r'] })
  const [value] = await pending
  assert.equal(value, 'onetwothree')
})

test('paste repaint does not rewind above the editor top when the block is taller than the terminal', async (t) => {
  const lines = ['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5']

  const { value, writes } = await runEditor(t, { rows: 4, chunks: [buildPaste(lines)], submit: true })
  assert.equal(value, lines.join('\n'))
  // A paste replaces the buffer silently, so the repaint must draw forward
  // from the current cursor (clear below, then content); an in-place redraw
  // would rewind a cursor-up that clamps at the top row and erases whatever
  // was printed above the prompt.
  assert.ok(writes.some((w) => w.startsWith('\x1b[?25l\x1b[J')))
  const rewindToTop = (w) => w.startsWith('\x1b[?25l\x1b[') && /^\d+A/.test(w.slice(8))
  assert.equal(writes.some(rewindToTop), false)
  // Submit must also skip the in-place redraw when the block does not fit.
  assert.equal(writes.some((w) => w.includes('\r\x1b[J')), false)
})

test('paste repaint is bottom-anchored even when the editor fits the terminal', async (t) => {
  const lines = ['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5']

  const { value, writes } = await runEditor(t, { rows: 12, chunks: [buildPaste(lines)], submit: true })
  assert.equal(value, lines.join('\n'))
  // The paste-end repaint is forward from the cursor (the terminal still shows
  // the pre-paste content), never a top-anchored rewind.
  assert.ok(writes.some((w) => w.startsWith('\x1b[?25l\x1b[J')))
  const rewindToTop = (w) => w.startsWith('\x1b[?25l\x1b[') && /^\d+A/.test(w.slice(8))
  assert.equal(writes.some(rewindToTop), false)
  // After that repaint the terminal is back in sync, so the submit redraws
  // in place.
  assert.equal(writes.some((w) => w.includes('\r\x1b[J')), true)
})

test('paste repaint returns to the line start so the prompt prefix is not duplicated', async (t) => {
  const { value, writes } = await runEditor(t, { rows: 10, chunks: [buildPaste(['cerametal'])], submit: true })
  assert.equal(value, 'cerametal')
  const repaint = writes.find((w) => w.startsWith('\x1b[?25l\x1b[J'))
  assert.ok(repaint, 'expected the post-paste repaint')
  assert.ok(repaint.startsWith('\x1b[?25l\x1b[J\r> '), 'paste repaint should redraw from the start of the line')
})

test('submit skips the in-place redraw when the editor is taller than the terminal', async (t) => {
  const chunks = []
  const lines = ['one', 'two', 'three', 'four', 'five', 'six']
  for (const [index, line] of lines.entries()) {
    chunks.push(line)
    if (index < lines.length - 1) chunks.push('\n')
  }

  const { value, writes } = await runEditor(t, { rows: 4, chunks, submit: true })
  assert.equal(value, lines.join('\n'))
  assert.equal(writes.some((w) => w.includes('\r\x1b[J')), false)
})

test('submit still redraws in place when the editor fits the terminal', async (t) => {
  const { value, writes } = await runEditor(t, { rows: 10, chunks: ['one'], submit: true })
  assert.equal(value, 'one')
  assert.equal(writes.some((w) => w.includes('\r\x1b[J')), true)
})
