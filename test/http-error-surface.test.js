import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import * as realDns from 'node:dns/promises'

// The resolver mock must be registered before src/http.js resolves its
// `lookup` import (same constraint as test/chat-claim-cleanup.test.js); it is
// also what keeps the unresolvable-host case off the network.
let lookupImpl = async (host) => {
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
}
mock.module('node:dns/promises', { namedExports: { ...realDns, lookup: (...args) => lookupImpl(...args) } })

const { assertSafeUrl, fetchWithRedirects } = await import('../src/http.js')
const { generateImage } = await import('../src/providers/openrouter.js')
const { produceParts } = await import('../src/artifacts.js')

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

// Holds a download request open until the caller aborts, recording the signal
// the transport was handed. A build that never threaded the caller's signal
// cannot cancel this request, so the fallback error after a beat fails the
// test on its assertions rather than on its timeout.
function holdTransport() {
  const state = { signal: null }
  let started = null
  const startedPromise = new Promise((resolve) => { started = resolve })
  const requestFn = (parsed, opts) => {
    state.signal = opts.signal
    const errorListeners = []
    const timer = setTimeout(() => {
      for (const listener of errorListeners) listener(new Error('download was never aborted'))
    }, 50)
    opts?.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true })
    return {
      on(event, listener) {
        if (event === 'error') errorListeners.push(listener)
        return this
      },
      end() { started() },
    }
  }
  return { requestFn, started: startedPromise, state }
}

test('assertSafeUrl reports an invalid URL instead of throwing', async () => {
  assert.equal(await assertSafeUrl('not a url'), 'invalid URL')
  assert.equal(await assertSafeUrl(''), 'invalid URL')
})

test('assertSafeUrl fails closed when the resolver cannot resolve the host', async () => {
  // Mock sanity: the same host passes while the resolver answers, so the
  // assertion below comes from the catch and not from an offline resolver.
  lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }]
  assert.equal(await assertSafeUrl('https://no-such-host.invalid/x'), null)
  lookupImpl = async (host) => {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
  }
  assert.equal(await assertSafeUrl('https://no-such-host.invalid/x'), 'blocked URL (unresolvable host)')
})

test('fetchWithRedirects reports a redirect without a location', async () => {
  const result = await fetchWithRedirects('https://93.184.216.34/start', {
    requestFn: respond(nodeResponse({ status: 302 })),
  })
  assert.deepEqual(result, { res: null, error: 'redirect without location' })
})

test('fetchWithRedirects reports an unparseable redirect location', async () => {
  const result = await fetchWithRedirects('https://93.184.216.34/start', {
    requestFn: respond(nodeResponse({ status: 302, headers: { location: 'http://' } })),
  })
  assert.deepEqual(result, { res: null, error: 'invalid redirect URL' })
})

test('fetchWithRedirects stops after its hop budget', async () => {
  let hops = 0
  const requestFn = () => {
    hops++
    return respond(nodeResponse({ status: 302, headers: { location: '/again' } }))()
  }

  const result = await fetchWithRedirects('https://93.184.216.34/loop', { requestFn })

  assert.deepEqual(result, { res: null, error: 'too many redirects' })
  // maxHops 5: the initial request plus five followed redirects, then the hop
  // that would exceed the budget is refused.
  assert.equal(hops, 6)
})

test('fetchWithRedirects cancels the in-flight fetch when the caller aborts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const reason = new Error('stop download')
  let received = null
  let started = null
  const startedPromise = new Promise((resolve) => { started = resolve })
  const requestFn = (parsed, opts) => {
    received = opts.signal
    return {
      on() { return this },
      end() { started() },
    }
  }

  const promise = fetchWithRedirects('https://93.184.216.34/a.png', { timeoutMs: 30_000, signal: controller.signal, requestFn })
  await startedPromise
  controller.abort(reason)
  // Once the abort is propagated the transport's own timer is cleared, so
  // ticking past it only matters when the signal never reached the transport.
  t.mock.timers.tick(30_000)

  assert.deepEqual(await promise, { res: null, error: 'stop download' })
  assert.equal(received.aborted, true)
})

test('fetchWithRedirects rejects an already-aborted signal before the transport starts', { timeout: 5000 }, async () => {
  const controller = new AbortController()
  const reason = new Error('already stopped')
  controller.abort(reason)
  let calls = 0
  const requestFn = () => {
    calls++
    return respond(nodeResponse({ status: 200 }))()
  }

  const result = await fetchWithRedirects('https://93.184.216.34/a.png', { signal: controller.signal, requestFn })

  assert.equal(calls, 0)
  assert.deepEqual(result, { res: null, error: 'already stopped' })
})

test('generateImage cancels an in-flight image URL download when the caller aborts', { timeout: 5000 }, async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    data: [{ url: 'https://93.184.216.34/img.png', media_type: 'image/png' }],
    usage: { cost: 0.01 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const controller = new AbortController()
  const reason = new Error('stop download')
  const transport = holdTransport()

  const promise = generateImage({ apiKey: 'key', model: 'qwen/qwen-image-3', prompt: 'p', signal: controller.signal, requestFn: transport.requestFn })
  await transport.started
  controller.abort(reason)

  await assert.rejects(promise, (err) => err === reason)
  assert.equal(transport.state.signal?.aborted, true)
})

test('produceParts cancels an in-flight artifact download when the caller aborts', { timeout: 5000 }, async () => {
  const controller = new AbortController()
  const reason = new Error('stop download')
  const transport = holdTransport()
  const url = 'https://93.184.216.34/artifact.png'

  const promise = produceParts([{ type: 'image_url', image_url: { url } }], {
    sessionId: null,
    imageOutputSupported: true,
    fullText: '',
    requestFn: transport.requestFn,
    signal: controller.signal,
  })
  await transport.started
  controller.abort(reason)

  const { results } = await promise
  assert.equal(results[0].error, 'stop download')
  assert.equal(results[0].part.image_url.url, url)
  assert.equal(transport.state.signal?.aborted, true)
})
