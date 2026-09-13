import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { fetchSafeBytes } from '../src/http.js'

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

// A body that yields a couple of real chunks when read and stays open until
// cancelled: a skipped guard therefore returns bytes instead of null (and
// only the guard's own cancel invokes the spy, since the stream is still
// readable at that moment).
function cancelableBody() {
  const state = { cancelled: false }
  let pulls = 0
  const body = new ReadableStream({
    pull(controller) {
      pulls++
      if (pulls >= 3) controller.close()
      else controller.enqueue(new TextEncoder().encode('x'))
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { body, state }
}

test('fetchSafeBytes returns null and cancels the body on an HTTP 404', { timeout: 5000 }, async () => {
  const { body, state } = cancelableBody()
  const requestFn = respond(nodeResponse({ status: 404, body }))

  const result = await fetchSafeBytes('https://93.184.216.34/blob', { maxBytes: 1000, requestFn })

  assert.equal(result, null)
  assert.equal(state.cancelled, true)
})

test('fetchSafeBytes returns null and cancels the body when content-length exceeds maxBytes', { timeout: 5000 }, async () => {
  const { body, state } = cancelableBody()
  const requestFn = respond(nodeResponse({ status: 200, headers: { 'content-length': '2048' }, body }))

  const result = await fetchSafeBytes('https://93.184.216.34/blob', { maxBytes: 1024, requestFn })

  assert.equal(result, null)
  assert.equal(state.cancelled, true)
})
