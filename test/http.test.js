import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithTimeout, fetchWithRetry, sleep } from '../src/http.js'
import { ApiError, TimeoutError } from '../src/errors.js'

function abortAwareFetch() {
  return (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason || new Error('Aborted')))
  })
}

function errorResponse(status, body) {
  return new ApiError(`status ${status}: ${body}`, { status, retryable: status === 429 || status >= 500 })
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

test('sleep removes the abort listener when the timer fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signal = new EventTarget()
  let listeners = 0
  const origAdd = signal.addEventListener.bind(signal)
  const origRemove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (...args) => { listeners++; origAdd(...args) }
  signal.removeEventListener = (...args) => { listeners--; origRemove(...args) }
  signal.aborted = false
  signal.reason = undefined

  const promise = sleep(100, signal)
  t.mock.timers.tick(100)
  await promise
  assert.equal(listeners, 0)
})

test('sleep rejects immediately when the signal is already aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  const promise = sleep(1000, controller.signal)
  await assert.rejects(promise, (err) => err.message === 'stop')
  t.mock.timers.tick(1000)
})

async function flushTimers(t, ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    t.mock.timers.tick(1000)
    await Promise.resolve()
  }
}

test('fetchWithRetry retries a timeout and succeeds on the second attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const res = new Response('ok', { status: 200 })
  let calls = 0
  const timeoutFetch = (url, opts) => {
    calls++
    if (calls === 1) return abortAwareFetch()(url, opts)
    return Promise.resolve(res)
  }
  t.mock.method(globalThis, 'fetch', timeoutFetch)

  const promise = fetchWithRetry('https://example.test', {}, { timeoutMs: 1000, attempts: 3, retryDelays: [0, 0] })
  await flushTimers(t)
  assert.equal(await promise, res)
  assert.equal(calls, 2)
})

test('fetchWithRetry throws TimeoutError when every attempt times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(globalThis, 'fetch', abortAwareFetch())

  const promise = fetchWithRetry('https://example.test', {}, { timeoutMs: 1000, attempts: 3, retryDelays: [0, 0] })
  const assertion = assert.rejects(promise, (err) => err instanceof TimeoutError && /timed out after 1s/.test(err.message))
  await flushTimers(t)
  await assertion
})

test('fetchWithRetry retries a retryable HTTP status and then fails', async (t) => {
  const response = new Response('slow down', { status: 429 })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return calls === 1 ? response : new Response('ok', { status: 200 })
  })

  const result = await fetchWithRetry('https://example.test', {}, { errorResponse, retryDelays: [0, 0] })
  assert.equal(result.status, 200)
  assert.equal(calls, 2)
})

test('fetchWithRetry does not retry a non-retryable HTTP status', async (t) => {
  const response = new Response('nope', { status: 401 })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return response
  })

  await assert.rejects(
    fetchWithRetry('https://example.test', {}, { errorResponse, retryDelays: [0, 0] }),
    (err) => err instanceof ApiError && err.status === 401
  )
  assert.equal(calls, 1)
})

test('fetchWithRetry retries transient network errors and wraps the final failure', async (t) => {
  const boom = new Error('network down')
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    throw boom
  })

  await assert.rejects(
    fetchWithRetry('https://example.test', {}, { retryDelays: [0, 0] }),
    (err) => err instanceof ApiError && err.retryable === true && /network down/.test(err.message)
  )
  assert.equal(calls, 3)
})

test('fetchWithRetry propagates an external abort immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', abortAwareFetch())

  const promise = fetchWithRetry('https://example.test', {}, { timeoutMs: 10000, signal: controller.signal })
  const assertion = assert.rejects(promise, (err) => err?.message === 'Aborted')
  controller.abort(new Error('Aborted'))
  await flushTimers(t)
  await assertion
})
