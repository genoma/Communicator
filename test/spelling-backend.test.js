import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createOsascriptBackend, SPELLING_ABORTED } from '../src/spelling/osascript.js'
import { JXA_PROGRAM, JXA_REQUEST_ENV } from '../src/spelling/jxa.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The spawn seam is the only place the backend touches the outside world, so a
// fake child covers the whole contract without an osascript process.
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killSignals = []
  child.kill = (signal) => {
    child.killSignals.push(signal)
    return true
  }
  child.reply = (payload) => {
    child.stdout.emit('data', payload)
    child.emit('close', 0)
  }
  return child
}

function withChild(child) {
  const calls = []
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options })
    return child
  }
  return { calls, spawnFn }
}

test('one call spawns osascript with the request in the environment', async () => {
  const child = fakeChild()
  const { calls, spawnFn } = withChild(child)
  const backend = createOsascriptBackend({ spawnFn })
  const request = { op: 'check', text: 'hello wrold' }

  const pending = backend.run(request)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/usr/bin/osascript')
  assert.deepEqual(calls[0].args, ['-l', 'JavaScript', '-e', JXA_PROGRAM])
  assert.equal(calls[0].options.env[JXA_REQUEST_ENV], JSON.stringify(request))
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])

  child.reply('{"ranges":[[6,5]]}\n')
  assert.deepEqual(await pending, { ranges: [[6, 5]] })
})

test('a non-zero exit, an error reply and unparsable output all reject', async () => {
  const exiting = fakeChild()
  const exitBackend = createOsascriptBackend({ spawnFn: withChild(exiting).spawnFn })
  const exited = exitBackend.run({ op: 'check', text: 'x' })
  exiting.emit('close', 3)
  await assert.rejects(exited, /exited with code 3/)

  const erroring = fakeChild()
  const errorBackend = createOsascriptBackend({ spawnFn: withChild(erroring).spawnFn })
  const errored = errorBackend.run({ op: 'check', text: 'x' })
  erroring.reply('{"error":"unknown op: nope"}')
  await assert.rejects(errored, /unknown op: nope/)

  const garbled = fakeChild()
  const garbledBackend = createOsascriptBackend({ spawnFn: withChild(garbled).spawnFn })
  const unparsable = garbledBackend.run({ op: 'check', text: 'x' })
  garbled.reply('not json at all')
  await assert.rejects(unparsable, /unparsable reply/)

  const arrayed = fakeChild()
  const arrayBackend = createOsascriptBackend({ spawnFn: withChild(arrayed).spawnFn })
  const unexpected = arrayBackend.run({ op: 'check', text: 'x' })
  arrayed.reply('[1,2,3]')
  await assert.rejects(unexpected, /unexpected reply/)
})

test('a spawn error rejects', async () => {
  const child = fakeChild()
  const backend = createOsascriptBackend({ spawnFn: withChild(child).spawnFn })
  const pending = backend.run({ op: 'check', text: 'x' })
  const failure = new Error('spawn /usr/bin/osascript ENOENT')
  failure.code = 'ENOENT'
  child.emit('error', failure)
  await assert.rejects(pending, /ENOENT/)
})

test('a hanging child is SIGKILLed after the hard timeout', async () => {
  const child = fakeChild()
  const backend = createOsascriptBackend({ spawnFn: withChild(child).spawnFn, timeoutMs: 5 })
  const pending = backend.run({ op: 'check', text: 'x' })
  const timedOut = assert.rejects(pending, /timed out after 5ms/)
  await delay(25)
  assert.deepEqual(child.killSignals, ['SIGKILL'])
  await timedOut
})

test('over-long output kills the child and rejects', async () => {
  const child = fakeChild()
  const backend = createOsascriptBackend({ spawnFn: withChild(child).spawnFn, maxBuffer: 16 })
  const pending = backend.run({ op: 'check', text: 'x' })
  child.stdout.emit('data', 'x'.repeat(64))
  assert.deepEqual(child.killSignals, ['SIGKILL'])
  await assert.rejects(pending, /exceeded the buffer limit/)

  const noisy = fakeChild()
  const stderrBackend = createOsascriptBackend({ spawnFn: withChild(noisy).spawnFn, maxBuffer: 16 })
  const noisyPending = stderrBackend.run({ op: 'check', text: 'x' })
  noisy.stderr.emit('data', 'y'.repeat(64))
  assert.deepEqual(noisy.killSignals, ['SIGKILL'])
  await assert.rejects(noisyPending, /error output exceeded the buffer limit/)
})

test('an aborted call kills the child and reports the abort', async () => {
  const child = fakeChild()
  const backend = createOsascriptBackend({ spawnFn: withChild(child).spawnFn })
  const controller = new AbortController()
  const pending = backend.run({ op: 'check', text: 'x' }, { signal: controller.signal })
  controller.abort()
  assert.deepEqual(child.killSignals, ['SIGKILL'])
  await assert.rejects(pending, (err) => err.code === SPELLING_ABORTED)

  const done = fakeChild()
  const doneBackend = createOsascriptBackend({ spawnFn: withChild(done).spawnFn })
  const already = new AbortController()
  already.abort()
  const abandoned = doneBackend.run({ op: 'check', text: 'x' }, { signal: already.signal })
  await assert.rejects(abandoned, (err) => err.code === SPELLING_ABORTED)
  assert.deepEqual(done.killSignals, ['SIGKILL'])
})

test('a settled call never kills the child', async () => {
  const child = fakeChild()
  const backend = createOsascriptBackend({ spawnFn: withChild(child).spawnFn })
  const pending = backend.run({ op: 'check', text: 'x' })
  child.reply('{"ranges":[]}')
  await pending
  assert.deepEqual(child.killSignals, [])
})
