import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readInput } from '../src/input.js'

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
