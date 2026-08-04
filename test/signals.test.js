import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSignalHandlers } from '../src/signals.js'

function fakeProcess(t) {
  const handlers = {}
  t.mock.method(process, 'on', (event, fn) => { handlers[event] = fn })
  t.mock.method(process, 'off', (event) => { delete handlers[event] })
  return handlers
}

test('registers SIGINT, beforeExit and uncaughtException handlers', (t) => {
  const handlers = fakeProcess(t)
  const cleanup = registerSignalHandlers({ sigint: () => {}, beforeExit: () => {}, uncaughtException: () => {} })
  t.after(cleanup)

  assert.equal(typeof handlers.SIGINT, 'function')
  assert.equal(typeof handlers.beforeExit, 'function')
  assert.equal(typeof handlers.uncaughtException, 'function')
})

test('dispatches each signal to the matching handler', (t) => {
  const handlers = fakeProcess(t)
  const calls = []
  const cleanup = registerSignalHandlers({
    sigint: () => calls.push('sigint'),
    beforeExit: () => calls.push('beforeExit'),
    uncaughtException: (err) => calls.push(['uncaught', err.message]),
  })
  t.after(cleanup)

  handlers.SIGINT()
  handlers.beforeExit()
  handlers.uncaughtException(new Error('boom'))

  assert.deepEqual(calls, ['sigint', 'beforeExit', ['uncaught', 'boom']])
})

test('cleanup removes every registered listener', (t) => {
  const handlers = fakeProcess(t)
  const cleanup = registerSignalHandlers({ sigint: () => {}, beforeExit: () => {}, uncaughtException: () => {} })

  cleanup()

  assert.equal(handlers.SIGINT, undefined)
  assert.equal(handlers.beforeExit, undefined)
  assert.equal(handlers.uncaughtException, undefined)
})

test('cleanup is idempotent', (t) => {
  const handlers = fakeProcess(t)
  const cleanup = registerSignalHandlers({ sigint: () => {}, beforeExit: () => {}, uncaughtException: () => {} })

  cleanup()
  cleanup()

  assert.equal(handlers.SIGINT, undefined)
})
