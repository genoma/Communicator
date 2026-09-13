// Branch-level tests for the editor front-end's non-obvious edges: the piped
// (non-TTY) reader, malformed-CSI recovery in the input consumer, the
// multi-line prompt-header measure, the exact-fold wrap guard, and the prompt
// history's home expansion / maxEntries cap / swallow-on-failure writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEditor } from '../src/editor/index.js'
import { createInputConsumer } from '../src/editor/keys.js'
import { buildPromptHeader, computeHeaderHeight } from '../src/editor/style.js'
import { wrapSegments } from '../src/editor/layout.js'
import { appendPersistedHistory, loadHistory } from '../src/editor/history.js'

function pipedInput() {
  const input = new EventEmitter()
  input.isTTY = false
  return input
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// --- Piped (non-TTY) reader: src/editor/index.js readFromPipe ---

test('a non-TTY input resolves the piped text, stripping one trailing newline', async () => {
  const withNewline = pipedInput()
  const first = readEditor('ignored prompt', { input: withNewline })
  withNewline.emit('data', Buffer.from('hello '))
  withNewline.emit('data', 'world\n')
  withNewline.emit('end')
  assert.deepEqual(await first, ['hello world', null])

  const withoutNewline = pipedInput()
  const second = readEditor('ignored prompt', { input: withoutNewline })
  withoutNewline.emit('data', 'no trailing newline')
  withoutNewline.emit('end')
  assert.deepEqual(await second, ['no trailing newline', null])

  // Exactly one newline is the pipe terminator: the final empty line stays.
  const multiline = pipedInput()
  const third = readEditor('ignored prompt', { input: multiline })
  multiline.emit('data', 'first\n\n')
  multiline.emit('end')
  assert.deepEqual(await third, ['first\n', null])
})

test('the pipe reader detaches every listener when the stream ends', async () => {
  const input = pipedInput()
  const pending = readEditor('', { input })
  input.emit('data', 'piped text')
  input.emit('end')
  assert.deepEqual(await pending, ['piped text', null])
  assert.equal(input.listenerCount('data'), 0)
  assert.equal(input.listenerCount('end'), 0)
  assert.equal(input.listenerCount('error'), 0)
})

test('a piped input stream that errors resolves the bytes read so far as an eof error', async () => {
  const input = pipedInput()
  const pending = readEditor('', { input })
  input.emit('data', 'partial')
  input.emit('error', new Error('pipe broke'))
  assert.deepEqual(await pending, ['partial', { kind: 'eof', message: 'Piped input error' }])
  assert.equal(input.listenerCount('data'), 0)
  assert.equal(input.listenerCount('error'), 0)
})

// --- Malformed CSI recovery: src/editor/keys.js escapeLength ---

function consumerHarness() {
  const dispatched = []
  const consumer = createInputConsumer({
    model: { isPasting: false },
    dispatch: (seq) => dispatched.push(seq),
    dsrAnswer: () => {},
    pasteStarted: () => {},
    pasteText: () => {},
    pasteEnded: () => {},
    pasteWatchdogFired: () => {},
  })
  return { consumer, dispatched }
}

test('a control byte inside a CSI ends the malformed escape and is reprocessed as a key', () => {
  // Ctrl+C arrives as the first byte after an unterminated CSI parameter:
  // the escape is dispatched as unknown input, the control byte must not be
  // swallowed with it (it is what cancels the prompt).
  const malformed = consumerHarness()
  malformed.consumer.data('\x1b[1\x03')
  assert.deepEqual(malformed.dispatched, ['\x1b[1', '\x03'])

  // A well-formed CSI is still dispatched whole.
  const wellFormed = consumerHarness()
  wellFormed.consumer.data('\x1b[1;5A')
  assert.deepEqual(wellFormed.dispatched, ['\x1b[1;5A'])
})

// --- Multi-line prompt header: src/editor/style.js computeHeaderHeight ---

test('computeHeaderHeight counts every line of a multi-line prompt header', () => {
  const multiLine = buildPromptHeader('> ', 'first line\nsecond line', undefined, 'pending')
  assert.equal(computeHeaderHeight(multiLine), 2)
  assert.equal(computeHeaderHeight(buildPromptHeader('> ', 'single line', undefined, 'pending')), 1)
  assert.equal(computeHeaderHeight(buildPromptHeader('', '', undefined, 'pending')), 0)
})

// --- Exact-fold wrap guard: src/editor/layout.js wrapSegmentsDetailed ---

test('an exact fold at the end never appends an empty trailing segment', () => {
  // A trailing empty segment would paint a ghost grid row. Real callers clamp
  // the usable width to at least 1 (layout.js usableWidth), so the exact-fold
  // guard is only reachable at the degenerate limit 0, where every space
  // overflows onto a row of its own: it must drop that ghost segment instead
  // of handing the caller an empty row after the content.
  assert.deepEqual(wrapSegments('a  ', 0), ['a'])
  assert.deepEqual(wrapSegments('  ', 0), [''])
})

// --- Prompt history: src/editor/history.js ---

test('loadHistory expands a leading ~ to the home directory', async (t) => {
  const home = await tempDir(t, 'communicator-tilde-')
  // os.homedir() follows HOME on POSIX and USERPROFILE on Windows: point both
  // at the temp dir instead of mocking node:os.
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    await writeFile(join(home, 'history.json'), JSON.stringify(['from-home']))
    assert.deepEqual(loadHistory('~/history.json', 10), ['from-home'])
    assert.deepEqual(loadHistory('~/missing.json', 10), [])
  } finally {
    process.env.HOME = previousHome.HOME
    process.env.USERPROFILE = previousHome.USERPROFILE
  }
})

test('loadHistory keeps only the newest maxEntries entries', async (t) => {
  const dir = await tempDir(t, 'communicator-history-')
  const file = join(dir, 'history.json')
  const entries = Array.from({ length: 205 }, (_, index) => `entry ${index}`)
  await writeFile(file, JSON.stringify(entries))

  // src/input.js asks for maxEntries: 200 on the persisted prompt history.
  assert.deepEqual(loadHistory(file, 200), entries.slice(-200))
  // No cap (or a non-positive one) leaves the list untouched.
  assert.equal(loadHistory(file, undefined).length, 205)
  assert.deepEqual(loadHistory(file, 0), entries)
})

test('appendPersistedHistory trims the file to maxEntries, keeping the newest', async (t) => {
  const dir = await tempDir(t, 'communicator-history-')
  const file = join(dir, 'history.json')
  const entries = Array.from({ length: 200 }, (_, index) => `entry ${index}`)
  await writeFile(file, JSON.stringify(entries))

  appendPersistedHistory(file, 'fresh entry', 200)

  const stored = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(stored.length, 200)
  assert.equal(stored.at(-1), 'fresh entry')
  assert.equal(stored[0], 'entry 1', 'the oldest entry fell off the cap')
})

test('appendPersistedHistory swallows a directory-creation failure', async (t) => {
  const dir = await tempDir(t, 'communicator-history-')
  const blocked = join(dir, 'not-a-dir')
  await writeFile(blocked, 'occupied')

  // dirname(<blocked>/history.json) is a file: mkdirSync throws ENOTDIR.
  assert.doesNotThrow(() => appendPersistedHistory(join(blocked, 'history.json'), 'entry', 10))
  assert.equal(await readFile(blocked, 'utf8'), 'occupied')
  assert.deepEqual(await readdir(dir), ['not-a-dir'])
})

test('appendPersistedHistory swallows a rename failure and removes the temp file', async (t) => {
  const dir = await tempDir(t, 'communicator-history-')
  const target = join(dir, 'history-dir')
  await mkdir(target)

  // The target path is a directory: the atomic rename fails (EISDIR).
  assert.doesNotThrow(() => appendPersistedHistory(target, 'entry', 10))
  assert.deepEqual(await readdir(dir), ['history-dir'], 'no temp file is left behind')
})
