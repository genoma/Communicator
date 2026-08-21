import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { fetchWithTimeout, fetchWithRetry, fetchSafeBytes, assertSafeUrl, readBodyWithDeadline, pinnedFetch, sleep } from '../src/http.js'
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

test('assertSafeUrl blocks deprecated IPv6 site-local addresses', async () => {
  for (const url of ['http://[fec0::1]/x', 'http://[fecf::1]/x', 'http://[feff::1]/x']) {
    assert.equal(await assertSafeUrl(url), 'blocked URL (private or loopback address)')
  }
  assert.equal(await assertSafeUrl('http://[feb0::1]/x'), 'blocked URL (private or loopback address)')
  assert.equal(await assertSafeUrl('https://[2600:1f18:2::42]/x'), null)
})

test('assertSafeUrl blocks benchmark, NAT64, 6to4, Teredo and mapped IPv4 ranges', async () => {
  const blocked = [
    'http://198.18.0.1/x',
    'http://198.19.255.1/x',
    'http://[64:ff9b::a00:1]/x',
    'http://[64:ff9b:1::a00:1]/x',
    'http://[2002:c0a8:0101::1]/x',
    'http://[2001:0:102:1001::1]/x',
    'http://[2001:0000:102:1001::1]/x',
    'http://[2001::1]/x',
    // The URL parser canonicalizes [::ffff:10.0.0.1] to [::ffff:a00:1].
    'http://[::ffff:10.0.0.1]/x',
    'http://[::ffff:a00:1]/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://[::ffff:7f00:1]/x',
  ]
  for (const url of blocked) {
    assert.equal(await assertSafeUrl(url), 'blocked URL (private or loopback address)', url)
  }
  const allowed = [
    'http://192.18.1.1/x',
    'http://192.19.1.1/x',
    'http://[2001:1::1]/x',
    'http://[2001:db8::1]/x',
    'http://[2001:4860:4860::8888]/x',
    'http://[::ffff:102:304]/x',
    'http://[::ffff:808:808]/x',
  ]
  for (const url of allowed) {
    assert.equal(await assertSafeUrl(url), null, url)
  }
})

function nodeResponse({ status = 200, headers = {}, body = null }) {
  let stream
  if (body == null) stream = Readable.from([])
  else if (body instanceof ReadableStream) stream = Readable.fromWeb(body)
  else if (typeof body.pipe === 'function') stream = body
  else stream = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)])
  stream.statusCode = status
  stream.headers = headers
  return stream
}

// Delivers synchronously so mocked timers can never fire the transport's
// own timeout before the response arrives.
function respond(response) {
  return () => ({
    on(event, listener) {
      if (event === 'response') listener(response)
      return this
    },
    end() {},
  })
}

test('fetchSafeBytes bounds a slow-drip body with the read deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('half'))
    },
    cancel() {
      cancelled = true
    },
  })
  const requestFn = respond(nodeResponse({ body }))

  const promise = fetchSafeBytes('https://93.184.216.34/blob', { maxBytes: 1000, timeoutMs: 1000, requestFn })
  await flushTimers(t)
  t.mock.timers.tick(1000)
  const result = await promise

  assert.equal(result, null)
  assert.equal(cancelled, true)
})

test('fetchSafeBytes rejects private IPv6 targets and reports oversized bodies', async () => {
  assert.equal(await fetchSafeBytes('http://[fec0::1]/x', { maxBytes: 100 }), null)
})

test('pinnedFetch pins DNS to the validated addresses and exposes status/headers', async () => {
  let lookupOptions = null
  const requestFn = (parsed, options) => {
    assert.equal(parsed.hostname, 'example.com')
    assert.equal(typeof options.lookup, 'function')
    options.lookup('example.com', { all: true }, (err, entries) => {
      lookupOptions = { err, entries }
    })
    return {
      on(event, listener) {
        if (event === 'response') queueMicrotask(() => listener(nodeResponse({ headers: { 'content-type': 'image/png' }, body: Buffer.from('x') })))
        return this
      },
      end() {},
    }
  }
  const res = await pinnedFetch('https://example.com/a.png', { addresses: ['1.2.3.4'], family: 4, requestFn })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.deepEqual(lookupOptions.entries, [{ address: '1.2.3.4', family: 4 }])
})

test('readBodyWithDeadline resets the idle deadline on every chunk', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Chunks at t=0, 800, 1600 (then close): each read gap is under the 1000ms
  // deadline, but the total is far over it — only an idle (reset-per-chunk)
  // deadline survives this stream.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('a'))
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('b'))
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('c'))
          controller.close()
        }, 800)
      }, 800)
    },
  })
  const res = { body }
  const promise = readBodyWithDeadline(res, { timeoutMs: 1000 })
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(800)
    await Promise.resolve()
  }
  const bytes = await promise
  assert.equal(Buffer.from(bytes).toString(), 'abc')
})

test('readBodyWithDeadline still dies on a stalled body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('a'))
    },
    cancel() {
      cancelled = true
    },
  })
  const promise = readBodyWithDeadline({ body }, { timeoutMs: 1000 })
  const assertion = assert.rejects(promise, /could not read response body/)
  t.mock.timers.tick(1000)
  await assertion
  assert.equal(cancelled, true)
})

test('fetchWithRetry wraps a non-throwing errorResponse as a non-retryable ApiError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 500 }))

  await assert.rejects(
    fetchWithRetry('https://example.test', {}, { errorResponse: () => undefined, retryDelays: [0, 0] }),
    (err) => err instanceof ApiError && err.status === 500 && err.retryable === true
  )
})
