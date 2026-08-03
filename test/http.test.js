import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithTimeout, sleep } from '../src/http.js'
import { ApiError } from '../src/errors.js'

function abortAwareFetch() {
  return (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason || new Error('Aborted')))
  })
}

test('fetchWithTimeout resolves the response when the request completes in time', async (t) => {
  const res = new Response('ok', { status: 200 })
  t.mock.method(globalThis, 'fetch', async () => res)
  const result = await fetchWithTimeout('https://example.test', {}, { timeoutMs: 1000 })
  assert.equal(result, res)
})

test('fetchWithTimeout throws a retryable ApiError when the timeout fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(globalThis, 'fetch', abortAwareFetch())

  const promise = fetchWithTimeout('https://example.test', {}, { timeoutMs: 1000 })
  const assertion = assert.rejects(promise, (err) => err instanceof ApiError && err.retryable === true && /timed out after 1s/.test(err.message))

  t.mock.timers.tick(1000)
  await assertion
})

test('fetchWithTimeout rethrows non-timeout errors unchanged', async (t) => {
  const boom = new Error('network down')
  t.mock.method(globalThis, 'fetch', async () => { throw boom })
  await assert.rejects(fetchWithTimeout('https://example.test', {}, { timeoutMs: 1000 }), (err) => err === boom)
})

test('fetchWithTimeout rethrows when an external signal aborts first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', abortAwareFetch())

  const promise = fetchWithTimeout('https://example.test', {}, { timeoutMs: 10000, signal: controller.signal })
  const assertion = assert.rejects(promise, (err) => err?.name === 'AbortError' || err?.message === 'Aborted')

  controller.abort(new DOMException('The operation was aborted.', 'AbortError'))
  t.mock.timers.tick(10000)
  await assertion
})

test('sleep resolves after the delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const promise = sleep(100).then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(100)
  await promise
  assert.equal(settled, true)
})

test('sleep rejects with the abort reason', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const reason = new Error('stop')
  const promise = sleep(100, controller.signal)
  const assertion = assert.rejects(promise, (err) => err === reason)
  controller.abort(reason)
  t.mock.timers.tick(100)
  await assertion
})
