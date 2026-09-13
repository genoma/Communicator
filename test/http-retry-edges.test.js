import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithRetry, readBodyWithDeadline } from '../src/http.js'
import { ApiError } from '../src/errors.js'

const retryable = (status) => new ApiError(`status ${status}`, { status, retryable: true })

async function tick(t, seconds) {
  for (let i = 0; i < seconds; i++) {
    t.mock.timers.tick(1000)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test('readBodyWithDeadline enforces the cap on the arrayBuffer fallback', { timeout: 5000 }, async () => {
  const underCap = { arrayBuffer: async () => Buffer.from('small') }
  const bytes = await readBodyWithDeadline(underCap, { limit: 5 })
  assert.ok(Buffer.isBuffer(bytes))
  assert.equal(bytes.toString(), 'small')

  const overCap = { arrayBuffer: async () => Buffer.from('larger than the cap') }
  assert.equal(await readBodyWithDeadline(overCap, { limit: 5 }), null)
})

test('fetchWithRetry refuses attempts below one before sending anything', { timeout: 5000 }, async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response('ok', { status: 200 })
  })

  await assert.rejects(fetchWithRetry('https://example.test', {}, { attempts: 0 }), /requires attempts >= 1/)
  await assert.rejects(fetchWithRetry('https://example.test', {}, { attempts: -3 }), /requires attempts >= 1/)
  assert.equal(calls, 0)
})

test('fetchWithRetry reuses the last delay when the status-retry delay list is short', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response('down', { status: 500 })
  })

  const promise = fetchWithRetry('https://example.test', {}, {
    errorResponse: retryable,
    retryDelays: [5000],
    attempts: 3,
  })
  const assertion = assert.rejects(promise, (err) => err instanceof ApiError && err.status === 500)

  await tick(t, 2)
  assert.equal(calls, 1)
  await tick(t, 6)
  assert.equal(calls, 2)
  // The second backoff has no retryDelays[1] to read: it must reuse the last
  // element (5s). Ticking 2s is well short of that, but far past the 0/undefined
  // a missing fallback would sleep, which fires attempt 3 on the first tick.
  await tick(t, 2)
  assert.equal(calls, 2)
  await tick(t, 6)
  await assertion
  assert.equal(calls, 3)
})

test('fetchWithRetry reuses the last delay when the network-retry delay list is short', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const res = new Response('ok', { status: 200 })
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls < 3) throw new Error('network down')
    return res
  })

  const promise = fetchWithRetry('https://example.test', {}, { retryDelays: [5000], attempts: 3 })

  await tick(t, 2)
  assert.equal(calls, 1)
  await tick(t, 6)
  assert.equal(calls, 2)
  // retryDelays[1] does not exist: the second backoff must wait the last
  // element (5s) again, not fire the third attempt on the next tick.
  await tick(t, 2)
  assert.equal(calls, 2)
  await tick(t, 6)
  assert.equal(await promise, res)
  assert.equal(calls, 3)
})

test('fetchWithRetry rejects with the abort reason when the signal fires during a status-retry backoff', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const reason = new Error('stop retrying')
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response('slow down', { status: 429 })
  })

  let settled = 'pending'
  const promise = fetchWithRetry('https://example.test', {}, {
    errorResponse: retryable,
    retryDelays: [60_000],
    attempts: 3,
    signal: controller.signal,
  })
  promise.then(() => { settled = 'resolved' }, (err) => { settled = err })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  controller.abort(reason)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, reason)
  assert.equal(calls, 1)
})

test('fetchWithRetry rejects with the abort reason when the signal fires during a network-retry backoff', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const reason = new Error('stop retrying')
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    throw new Error('network down')
  })

  let settled = 'pending'
  const promise = fetchWithRetry('https://example.test', {}, {
    retryDelays: [60_000],
    attempts: 3,
    signal: controller.signal,
  })
  promise.then(() => { settled = 'resolved' }, (err) => { settled = err })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  controller.abort(reason)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, reason)
  assert.equal(calls, 1)
})

test('fetchWithRetry ignores a Retry-After that is non-numeric, negative or infinite', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const headers = ['not-a-number', '-5', 'Infinity', null]
  const seen = []
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    const retryAfter = headers[calls - 1]
    return new Response('slow down', {
      status: 429,
      headers: retryAfter != null ? { 'retry-after': retryAfter } : {},
    })
  })

  const promise = fetchWithRetry('https://example.test', {}, {
    errorResponse: (status, body, meta) => {
      seen.push(meta?.retryAfter ?? null)
      return retryable(status)
    },
    retryDelays: [1000],
    attempts: 4,
  })
  const assertion = assert.rejects(promise, (err) => err instanceof ApiError && err.status === 429)

  await tick(t, 4)
  // Every hint was rejected, so the plain retryDelays[0] delay was used and
  // the status path still reached all four attempts.
  assert.deepEqual(seen, [null, null, null, null])
  assert.equal(calls, 4)
  await assertion
})

test('fetchWithRetry reads a millisecond x-ratelimit-reset-requests as an epoch', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const resetMs = (Math.floor(Date.now() / 1000) + 10) * 1000
  const seen = []
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return calls === 1
      ? new Response('slow down', { status: 429, headers: { 'x-ratelimit-reset-requests': String(resetMs) } })
      : new Response('ok', { status: 200 })
  })

  const promise = fetchWithRetry('https://example.test', {}, {
    errorResponse: (status, body, meta) => {
      seen.push(meta?.retryAfter ?? null)
      return retryable(status)
    },
    retryDelays: [0],
    attempts: 2,
  })

  await tick(t, 5)
  // The millisecond epoch is read as ~10s away, not as a ~1.7e9-second window.
  assert.equal(calls, 1)
  await tick(t, 9)
  assert.equal(calls, 2)
  const result = await promise
  assert.equal(result.status, 200)
  assert.ok(seen[0] >= 8 && seen[0] <= 10, `retryAfter ${seen[0]}`)
})

test('fetchWithRetry caps the error body at the limit without losing the status path', { timeout: 5000 }, async (t) => {
  const cap = 512 * 1024
  const seen = []
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response('x'.repeat(cap + (calls === 2 ? 1 : 0)), { status: 500 })
  })

  await assert.rejects(
    fetchWithRetry('https://example.test', {}, {
      errorResponse: (status, body) => {
        seen.push({ status, length: body.length })
        return retryable(status)
      },
      attempts: 2,
      retryDelays: [0],
    }),
    (err) => err instanceof ApiError && err.status === 500
  )
  // Exactly at the cap the body survives; one byte more is discarded, and the
  // retry decision still comes from the status.
  assert.deepEqual(seen, [
    { status: 500, length: cap },
    { status: 500, length: 0 },
  ])
  assert.equal(calls, 2)
})
