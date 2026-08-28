import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createStreamKeyMonitor } from '../src/stream-keys.js'

function fakeInput() {
  const input = new EventEmitter()
  input.isTTY = true
  input.readableEnded = false
  input.destroyed = false
  const calls = { rawMode: [], resume: 0, pause: 0 }
  input.setRawMode = (v) => calls.rawMode.push(v)
  input.resume = () => { calls.resume += 1 }
  input.pause = () => { calls.pause += 1 }
  return { input, calls }
}

function monitorFor({ input, list }) {
  return createStreamKeyMonitor({
    input,
    onStop: () => list.push('stop'),
    onInterrupt: () => list.push('interrupt'),
  })
}

test('a lone Escape fires onStop only after the 50 ms disambiguation flush', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { input } = fakeInput()
  const list = []
  const monitor = monitorFor({ input, list })
  monitor.start()

  input.emit('data', '\x1b')
  assert.deepEqual(list, [], 'the lone ESC is held, not dispatched yet')
  await t.mock.timers.tick(50)
  assert.deepEqual(list, ['stop'])
  monitor.stop()
})

test('escape sequences (arrows, word-motion, kitty) are ignored, never a stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { input } = fakeInput()
  const list = []
  const monitor = monitorFor({ input, list })
  monitor.start()

  input.emit('data', '\x1b[A')
  input.emit('data', '\x1b[B')
  input.emit('data', '\x1bb')
  input.emit('data', '\x1b[27u')
  input.emit('data', '\x1b[3~')
  await t.mock.timers.tick(100)
  assert.deepEqual(list, [])
  monitor.stop()
})

test('an escape sequence split across chunks never fires a stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { input } = fakeInput()
  const list = []
  const monitor = monitorFor({ input, list })
  monitor.start()

  input.emit('data', '\x1b')
  input.emit('data', '[A')
  await t.mock.timers.tick(50)
  assert.deepEqual(list, [])
  monitor.stop()
})

test('Ctrl+C as the \\x03 byte fires onInterrupt (raw mode disables ISIG)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { input } = fakeInput()
  const list = []
  const monitor = monitorFor({ input, list })
  monitor.start()

  input.emit('data', '\x03')
  assert.deepEqual(list, ['interrupt'])
  monitor.stop()
})

test('a chunk bundling \\x03 with another byte still fires onInterrupt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { input } = fakeInput()
  const list = []
  const monitor = monitorFor({ input, list })
  monitor.start()

  input.emit('data', '\x03X')
  assert.deepEqual(list, ['interrupt'])
  monitor.stop()
})

test('a held ESC bundled with \\x03 (\\x1b\\x03) fires onInterrupt, not a stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { input } = fakeInput()
  const list = []
  const monitor = monitorFor({ input, list })
  monitor.start()

  input.emit('data', '\x1b\x03')
  assert.deepEqual(list, ['interrupt'])
  monitor.stop()
})

test('two ESC bytes in one chunk are an escape sequence, not two stops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { input } = fakeInput()
  const list = []
  const monitor = monitorFor({ input, list })
  monitor.start()

  input.emit('data', '\x1b\x1b')
  await t.mock.timers.tick(50)
  assert.deepEqual(list, [])
  monitor.stop()
})

test('start/stop restore the raw-mode lifecycle symmetrically and stop() is idempotent', async () => {
  const { input, calls } = fakeInput()
  const list = []
  const monitor = monitorFor({ input, list })

  monitor.start()
  assert.deepEqual(calls.rawMode, [true])
  assert.equal(calls.resume, 1)

  monitor.stop()
  assert.deepEqual(calls.rawMode, [true, false])
  assert.equal(calls.pause, 1)

  // A second stop after the first must not re-toggle the terminal.
  monitor.stop()
  assert.deepEqual(calls.rawMode, [true, false])
  assert.equal(calls.pause, 1)
})

test('stop() cancels a pending escape flush so a buffered ESC never fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { input } = fakeInput()
  const list = []
  const monitor = monitorFor({ input, list })
  monitor.start()

  input.emit('data', '\x1b') // held, waiting for the flush
  monitor.stop() // cancel the pending flush
  await t.mock.timers.tick(50)
  assert.deepEqual(list, [])
})
