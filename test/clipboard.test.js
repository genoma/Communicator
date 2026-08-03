import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

class FakeChild {
  constructor() {
    this.listeners = {}
    this.stdin = {
      write: () => {},
      end: () => {},
    }
  }

  on(event, fn) {
    this.listeners[event] = fn
    return this
  }

  emit(event, ...args) {
    this.listeners[event]?.(...args)
  }

  succeed() {
    this.emit('close', 0)
  }

  fail(code = 1) {
    this.emit('close', code)
  }

  spawnError(err) {
    this.emit('error', err)
  }
}

let spawnImpl = null
mock.module('node:child_process', {
  namedExports: {
    spawn: (cmd, args, opts) => spawnImpl(cmd, args, opts),
  },
})

const { copyText } = await import('../src/clipboard.js')

function captureSpawn() {
  const calls = []
  const written = []
  spawnImpl = (cmd, args, opts) => {
    const child = new FakeChild()
    child.stdin.write = (chunk) => written.push(chunk)
    calls.push({ cmd, args, opts, child })
    return child
  }
  return { calls, written }
}

test('copyText writes the text and resolves ok on exit 0 (darwin pbcopy)', async () => {
  const { calls, written } = captureSpawn()

  const promise = copyText('hello', { platform: 'darwin' })
  calls[0].child.succeed()
  const outcome = await promise

  assert.deepEqual(outcome, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'pbcopy')
  assert.deepEqual(calls[0].args, [])
  assert.equal(written.join(''), 'hello')
  assert.equal(calls[0].opts.stdio[0], 'pipe')
})

test('copyText uses clip on Windows', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'win32' })
  calls[0].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'clip')
})

test('copyText falls through the linux toolchain on ENOENT', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'linux' })
  calls[0].child.spawnError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  calls[1].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.map((c) => c.cmd), ['wl-copy', 'xclip'])
  assert.deepEqual(calls[1].args, ['-selection', 'clipboard'])
})

test('copyText falls through on a non-zero exit and reports failure when all tools fail', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'linux' })
  for (let i = 0; i < 3; i++) calls[i].child.fail(1)
  const result = await promise

  assert.deepEqual(result, { ok: false, error: 'No clipboard tool found. Install wl-copy, xclip, or xsel.' })
  assert.deepEqual(calls.map((c) => c.cmd), ['wl-copy', 'xclip', 'xsel'])
})

test('copyText settles once when a later tool errors after an earlier failure', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'linux' })
  calls[0].child.fail(1)
  calls[1].child.spawnError(new Error('ENOENT'))
  calls[2].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.equal(calls[2].cmd, 'xsel')
})

test('copyText defaults to the current platform', async () => {
  const { calls } = captureSpawn()
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try {
    const promise = copyText('hello')
    calls[0].child.succeed()
    const result = await promise
    assert.deepEqual(result, { ok: true })
    assert.equal(calls[0].cmd, 'pbcopy')
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
})
