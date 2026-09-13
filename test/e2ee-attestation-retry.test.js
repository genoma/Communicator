import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH } from 'node:crypto'
import { fetchModelPubKey } from '../src/e2ee.js'
import { ApiError } from '../src/errors.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(t, impl) {
  t.mock.method(globalThis, 'fetch', impl)
}

function serverKeypair() {
  const key = createECDH('secp256k1')
  return { key, pubKeyHex: key.generateKeys('hex') }
}

// One macrotask turn lets the response-body read chain progress far enough to
// register the retry sleep timer; each tick then advances a full retry window
// under the mocked clock, so the 500 ms and 1000 ms delays both fire. Ticks
// without the macrotask yield would leave the sleep pending forever.
async function settleRetries(t, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(1000)
  }
}

test('fetchModelPubKey retries 503 attestation responses and succeeds on the third attempt', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const model = serverKeypair()
  let calls = 0
  mockFetch(t, async (url) => {
    calls++
    if (calls < 3) return new Response('upstream unavailable', { status: 503 })
    return jsonResponse({
      verified: true,
      nonce: new URL(String(url)).searchParams.get('nonce'),
      signing_key: model.pubKeyHex,
    })
  })

  const promise = fetchModelPubKey({ apiKey: 'k', modelId: 'm' })
  await settleRetries(t)

  assert.equal(await promise, model.pubKeyHex)
  assert.equal(calls, 3)
})

test('fetchModelPubKey does not retry a 401 attestation response', { timeout: 5000 }, async (t) => {
  let calls = 0
  mockFetch(t, async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
  })

  await assert.rejects(
    fetchModelPubKey({ apiKey: 'bad', modelId: 'm' }),
    (err) => err instanceof ApiError && err.retryable === false && err.message === 'TEE attestation request failed: invalid api key'
  )
  assert.equal(calls, 1)
})

test('fetchModelPubKey falls back to the generic message for a non-JSON error body', { timeout: 5000 }, async (t) => {
  mockFetch(t, async () => new Response('<html>bad request</html>', { status: 400 }))

  await assert.rejects(
    fetchModelPubKey({ apiKey: 'k', modelId: 'm' }),
    (err) => err instanceof ApiError
      && err.message === 'TEE attestation request failed (HTTP 400).'
      && err.retryable === false
  )
})
