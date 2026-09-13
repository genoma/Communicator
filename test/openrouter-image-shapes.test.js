import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchImageModelEndpoints, resetImageModelCaches, generateImage } from '../src/providers/openrouter.js'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const LEGACY_B64 = Buffer.from('legacy-bytes').toString('base64')
const PREFERRED_B64 = Buffer.from('preferred-bytes').toString('base64')

const ENDPOINT = {
  provider_name: 'Alibaba Cloud Int.',
  provider_slug: 'alibaba',
  provider_tag: 'alibaba',
  pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.03 }],
}
const MAPPED_ENDPOINT = {
  providerName: 'Alibaba Cloud Int.',
  slug: 'alibaba',
  tag: 'alibaba',
  pricing: { perImage: 0.03, perToken: null, byResolution: null, byQuality: null },
}

function stubEndpointsPayload(t, payload) {
  resetImageModelCaches()
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).endsWith('/images/models/qwen/qwen-image-3/endpoints'), String(url))
    return jsonResponse(payload)
  })
}

test('generateImage decodes the legacy b64 field when b64_json is absent', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [{ b64: LEGACY_B64, media_type: 'image/png' }],
    usage: { cost: 0.02 },
  }))

  const result = await generateImage({ apiKey: 'key', model: 'org/image-model', prompt: 'p' })

  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].bytes.toString(), 'legacy-bytes')
  assert.equal(result.images[0].dataUrl, `data:image/png;base64,${LEGACY_B64}`)
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(result.images[0].ext, 'png')
})

test('generateImage prefers b64_json over the legacy b64 field', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [{ b64_json: PREFERRED_B64, b64: LEGACY_B64, media_type: 'image/png' }],
    usage: { cost: 0.02 },
  }))

  const result = await generateImage({ apiKey: 'key', model: 'org/image-model', prompt: 'p' })

  assert.equal(result.images[0].bytes.toString(), 'preferred-bytes')
  assert.equal(result.images[0].dataUrl, `data:image/png;base64,${PREFERRED_B64}`)
})

test('generateImage defaults the mime type to png and honors an explicit format when media_type is absent', async (t) => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    bodies.push(JSON.parse(opts.body))
    return jsonResponse({ data: [{ b64_json: LEGACY_B64 }], usage: { cost: 0.02 } })
  })

  const fallback = await generateImage({ apiKey: 'key', model: 'org/image-model', prompt: 'p' })
  const explicit = await generateImage({ apiKey: 'key', model: 'org/image-model', prompt: 'p', format: 'jpeg' })

  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].output_format, undefined)
  assert.equal(fallback.images[0].mime, 'image/png')
  assert.equal(fallback.images[0].ext, 'png')
  assert.equal(explicit.images[0].mime, 'image/jpeg')
  assert.equal(explicit.images[0].ext, 'jpg')
  assert.equal(explicit.images[0].dataUrl, `data:image/jpeg;base64,${LEGACY_B64}`)
})

test('fetchImageModelEndpoints reads the array form of parsed.data', async (t) => {
  stubEndpointsPayload(t, { data: [ENDPOINT] })

  const endpoints = await fetchImageModelEndpoints('key', 'qwen/qwen-image-3')

  assert.deepEqual(endpoints, [MAPPED_ENDPOINT])
})

test('fetchImageModelEndpoints reads a nested data.endpoints array', async (t) => {
  stubEndpointsPayload(t, { data: { endpoints: [ENDPOINT] } })

  const endpoints = await fetchImageModelEndpoints('key', 'qwen/qwen-image-3')

  assert.deepEqual(endpoints, [MAPPED_ENDPOINT])
})
