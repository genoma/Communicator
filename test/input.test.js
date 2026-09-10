import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

// Submitted input appends to the prompt history file. Without the mocked
// homedir that file is the real ~/.communicator/history.json, so a test run
// would write into the user's own history.
mock.module('node:os', { namedExports: { homedir: () => tempHome } })

// Loaded after the node:os mock so src/input.js resolves its history path
// under the temp home.
const { readInput } = await import('../src/input.js')

function fakeStdin(overrides = {}) {
  const stdin = new EventEmitter()
  stdin.isTTY = true
  stdin.readableEnded = false
  stdin.destroyed = false
  stdin.setRawMode = () => {}
  stdin.resume = () => {}
  stdin.pause = () => {}
  return Object.assign(stdin, overrides)
}

function installFakeStdin(t, stdin) {
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  t.after(() => {
    delete process.stdin
  })
}

test('readInput submits when Enter arrives in the same chunk as text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = readInput({ commands: ['/quit'] })
  stdin.emit('data', '/quit\r')
  const result = await pending
  assert.deepEqual(result, { value: '/quit' })

  // Submitting appends to the prompt history under the mocked home, never the
  // real ~/.communicator/history.json.
  const history = JSON.parse(await readFile(join(tempHome, '.communicator', 'history.json'), 'utf-8'))
  assert.ok(history.includes('/quit'), `history holds the submitted line: ${JSON.stringify(history)}`)
})

test('readInput submits text that ends with a control key in one chunk', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = readInput({ commands: ['/smooth'] })
  stdin.emit('data', '/smooth fast\r')
  const result = await pending
  assert.deepEqual(result, { value: '/smooth fast' })
})

test('readInput resolves cancelled when stdin closes while waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = readInput({ commands: ['/quit'] })
  stdin.emit('end')
  const result = await pending
  assert.deepEqual(result, { cancelled: true, eof: true })
})

test('readInput resolves cancelled immediately when stdin already ended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  const stdin = fakeStdin({ readableEnded: true })
  installFakeStdin(t, stdin)

  const result = await readInput({ commands: ['/quit'] })
  assert.deepEqual(result, { cancelled: true, eof: true })
})

test('readInput keeps cancelling via Ctrl+C within the reader', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = readInput({ commands: ['/quit'] })
  stdin.emit('data', 'hello')
  stdin.emit('data', '\x03')
  const result = await pending
  assert.deepEqual(result, { cancelled: true, partial: 'hello' })
})

test('readInput pre-fills the editor buffer with initialValue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = readInput({ initialValue: 'original prompt' })
  stdin.emit('data', '!')
  stdin.emit('data', '\r')
  await t.mock.timers.tick(0)
  const result = await pending
  assert.deepEqual(result, { value: 'original prompt!' })
})
