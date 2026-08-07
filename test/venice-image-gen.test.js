import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, TimeoutError } from '../src/errors.js'
import * as venice from '../src/providers/venice.js'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const PNG = Buffer.from('fake png bytes').toString('base64')
const PNG2 = Buffer.from('second image bytes').toString('base64')

function mockGenerate(t, bodyCapture, { response = { id: 'gen-1', images: [PNG], timing: {} }, headers = {} } = {}) {
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    bodyCapture.push({ url: String(url), body: JSON.parse(opts.body), headers: opts.headers, signal: opts.signal })
    return jsonResponse(response, 200, headers)
  })
}

// Mirrors real fetch: a request aborted by the timeout controller rejects
// with an AbortError. A promise that never settles would hang the request.
function hangingFetch() {
  return (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
}

test('generateImage sends required fields and explicit defaults', async (t) => {
  const calls = []
  mockGenerate(t, calls, { response: { id: 'gen-1', images: [PNG], timing: {} } })

  await venice.generateImage({ apiKey: 'key', model: 'flux-1-1', prompt: 'a red cat' })

  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.endsWith('/image/generate'), calls[0].url)
  assert.deepEqual(calls[0].body, {
    model: 'flux-1-1',
    prompt: 'a red cat',
    format: 'webp',
    variants: 1,
    safe_mode: true,
  })
  assert.equal(calls[0].headers.Authorization, 'Bearer key')
})

test('generateImage passes through optional sizing and generation fields', async (t) => {
  const calls = []
  mockGenerate(t, calls)

  await venice.generateImage({
    apiKey: 'key',
    model: 'gpt-image-2',
    prompt: 'x',
    format: 'png',
    variants: 3,
    safeMode: false,
    resolution: '2K',
    quality: 'high',
    seed: 42,
    width: 1024,
    height: 1024,
  })

  const body = calls[0].body
  assert.equal(body.format, 'png')
  assert.equal(body.variants, 3)
  assert.equal(body.safe_mode, false)
  assert.equal(body.resolution, '2K')
  assert.equal(body.quality, 'high')
  assert.equal(body.seed, 42)
  assert.equal(body.width, 1024)
  assert.equal(body.height, 1024)
  assert.deepEqual(Object.keys(body).sort(), [
    'format', 'height', 'model', 'prompt', 'quality', 'resolution', 'safe_mode', 'seed', 'variants', 'width',
  ])
})

test('generateImage passes aspect_ratio through without width or height', async (t) => {
  const calls = []
  mockGenerate(t, calls)

  await venice.generateImage({
    apiKey: 'key',
    model: 'm',
    prompt: 'x',
    aspectRatio: '16:9',
  })

  assert.equal(calls[0].body.aspect_ratio, '16:9')
  assert.equal(calls[0].body.width, undefined)
  assert.equal(calls[0].body.height, undefined)
  assert.deepEqual(Object.keys(calls[0].body).sort(), [
    'aspect_ratio', 'format', 'model', 'prompt', 'safe_mode', 'variants',
  ])
})

test('generateImage never sends width or height with aspect_ratio', async (t) => {
  const calls = []
  mockGenerate(t, calls)

  await venice.generateImage({
    apiKey: 'key',
    model: 'm',
    prompt: 'x',
    aspectRatio: '1:1',
    width: 1024,
    height: 1024,
  })

  assert.equal(calls[0].body.aspect_ratio, '1:1')
  assert.equal(calls[0].body.width, undefined)
  assert.equal(calls[0].body.height, undefined)
})

test('generateImage decodes base64 images with the requested format mime and ext', async (t) => {
  const calls = []
  mockGenerate(t, calls, { response: { id: 'gen-1', images: [PNG, PNG2], timing: {} } })

  const result = await venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x', format: 'png' })

  assert.equal(result.id, 'gen-1')
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].bytes.toString('utf-8'), 'fake png bytes')
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(result.images[0].ext, 'png')
  assert.equal(result.images[0].dataUrl, `data:image/png;base64,${PNG}`)
  assert.equal(result.images[1].bytes.toString('utf-8'), 'second image bytes')
})

test('generateImage maps jpeg format to the image/jpeg mime and jpg ext', async (t) => {
  const calls = []
  mockGenerate(t, calls, { response: { id: 'gen-1', images: [PNG], timing: {} } })

  const result = await venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x', format: 'jpeg' })

  assert.equal(result.images[0].mime, 'image/jpeg')
  assert.equal(result.images[0].ext, 'jpg')
})

test('generateImage surfaces the blur header as a string compare', async (t) => {
  const calls = []
  let callCount = 0
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body), signal: opts.signal })
    const headers = callCount++ === 0 ? { 'x-venice-is-blurred': 'true' } : {}
    return jsonResponse({ id: 'gen-1', images: [PNG], timing: {} }, 200, headers)
  })

  const blurred = await venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x' })
  assert.equal(blurred.blurred, true)

  const notBlurred = await venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x' })
  assert.equal(notBlurred.blurred, false)
  assert.equal(calls.length, 2)
})

test('generateImage throws ApiError on an empty images array', async (t) => {
  const calls = []
  mockGenerate(t, calls, { response: { id: 'gen-1', images: [], timing: {} } })

  await assert.rejects(
    venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x' }),
    (err) => err instanceof ApiError && err.message.includes('returned no images')
  )
})

test('generateImage throws ApiError when the images key is missing entirely', async (t) => {
  const calls = []
  mockGenerate(t, calls, { response: { id: 'gen-1' } })

  await assert.rejects(
    venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x' }),
    (err) => err instanceof ApiError && err.message.includes('returned no images')
  )
})

test('generateImage rejects with TimeoutError when the request exceeds timeoutMs', async (t) => {
  t.mock.method(globalThis, 'fetch', hangingFetch())

  await assert.rejects(
    venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x', timeoutMs: 10 }),
    (err) => err instanceof TimeoutError && err.message.includes('timed out')
  )
})

test('generateImage defaults to IMAGE_GEN_TIMEOUT_MS without timeoutMs', async (t) => {
  const calls = []
  mockGenerate(t, calls)

  const result = await venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x' })

  assert.equal(venice.IMAGE_GEN_TIMEOUT_MS, 600_000)
  assert.equal(result.images.length, 1)
})

test('generateImage passes an explicit timeoutMs through to the request', async (t) => {
  t.mock.method(globalThis, 'fetch', hangingFetch())

  await assert.rejects(
    venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x', timeoutMs: 500 }),
    (err) => err instanceof TimeoutError && err.message.includes('after 1s')
  )
})

test('generateImage maps non-200 responses through handleHttpError', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response('slow down', { status: 429 })
  })

  await assert.rejects(
    venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x' }),
    (err) => err instanceof ApiError && err.status === 429 && err.message.includes('Rate limited by Venice')
  )
  assert.equal(calls, 3)
})

test('generateImage forwards the abort signal to the request', async (t) => {
  const calls = []
  const controller = new AbortController()
  mockGenerate(t, calls)

  await venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x', signal: controller.signal })

  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.equal(calls[0].signal.aborted, false)
})

test('generateImage computes cost from pricing when a resolution is requested', async (t) => {
  const calls = []
  mockGenerate(t, calls, { response: { id: 'gen-1', images: [PNG, PNG], timing: {} } })

  const pricing = { perImage: null, byResolution: { '1K': 0.18, '2K': 0.24 }, byQuality: null }
  const result = await venice.generateImage({ apiKey: 'key', model: 'm', prompt: 'x', resolution: '2K', pricing })

  assert.equal(result.cost, 0.24)
})
