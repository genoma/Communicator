import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/errors.js'
import * as venice from '../src/providers/venice.js'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const IMAGE_MODEL = {
  id: 'flux-1-1',
  model_spec: {
    name: 'Flux 1.1',
    privacy: 'anonymized',
    description: 'Fast diffusion model',
    supportsStyleReferences: true,
    offline: false,
    constraints: {
      aspectRatios: ['1:1', '16:9', '9:16'],
      defaultAspectRatio: '1:1',
      resolutions: ['1K', '2K'],
      defaultResolution: '1K',
      qualities: ['low', 'medium', 'high'],
      defaultQuality: 'high',
      promptCharacterLimit: 2048,
      steps: { default: 25, max: 50 },
      widthHeightDivisor: 8,
      maxStyleReferences: 3,
      supportsStyleReferenceStrength: true,
    },
  },
}

test('fetchImageModels requests ?type=image and normalizes constraints', async (t) => {
  const requested = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url))
    return jsonResponse({ data: [IMAGE_MODEL] })
  })

  const models = await venice.fetchImageModels('key')

  assert.ok(requested[0].endsWith('/models?type=image'), requested[0])
  assert.equal(models.length, 1)
  const m = models[0]
  assert.equal(m.id, 'flux-1-1')
  assert.equal(m.name, 'Flux 1.1')
  assert.equal(m.provider, 'venice')
  assert.equal(m.privacy, 'anonymized')
  assert.equal(m.offline, false)
  assert.deepEqual(m.constraints.aspectRatios, ['1:1', '16:9', '9:16'])
  assert.deepEqual(m.constraints.resolutions, ['1K', '2K'])
  assert.deepEqual(m.constraints.qualities, ['low', 'medium', 'high'])
  assert.equal(m.constraints.widthHeightDivisor, 8)
  assert.ok(m.description.includes('Fast diffusion model'))
})

test('fetchImageModels falls back to the id for the name and defaults optional fields', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [{ id: 'no-name-model', model_spec: { constraints: {} } }],
  }))

  const models = await venice.fetchImageModels('key')

  assert.equal(models[0].name, 'no-name-model')
  assert.equal(models[0].privacy, null)
  assert.equal(models[0].offline, false)
  assert.equal(models[0].constraints.aspectRatios, null)
  assert.equal(models[0].description, '?')
})

test('normalizeImagePricing handles flat, resolutions and quality shapes', () => {
  assert.deepEqual(
    venice.normalizeImagePricing({ generation: { usd: 0.01, diem: 0.01 } }),
    { perImage: 0.01, byResolution: null, byQuality: null }
  )
  assert.deepEqual(
    venice.normalizeImagePricing({ resolutions: { '1K': { usd: 0.18 }, '2K': { usd: 0.24 } } }),
    { perImage: null, byResolution: { '1K': 0.18, '2K': 0.24 }, byQuality: null }
  )
  assert.deepEqual(
    venice.normalizeImagePricing({
      resolutions: { '1K': { usd: 0.18 } },
      quality: {
        '1K': { low: { usd: 0.02 }, high: { usd: 0.26 } },
        '2K': { low: { usd: 0.03 }, high: { usd: 0.5 } },
      },
    }),
    {
      perImage: null,
      byResolution: { '1K': 0.18 },
      byQuality: { '1K': { low: 0.02, high: 0.26 }, '2K': { low: 0.03, high: 0.5 } },
    }
  )
})

test('normalizeImagePricing returns nulls for missing pricing', () => {
  assert.deepEqual(venice.normalizeImagePricing(null), { perImage: null, byResolution: null, byQuality: null })
  assert.deepEqual(venice.normalizeImagePricing({}), { perImage: null, byResolution: null, byQuality: null })
  assert.deepEqual(venice.normalizeImagePricing({ generation: {} }), { perImage: null, byResolution: null, byQuality: null })
})

test('fetchModels still requests ?type=text', async (t) => {
  const requested = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url))
    return jsonResponse({ data: [] })
  })

  await venice.fetchModels('key')

  assert.ok(requested[0].endsWith('/models?type=text'), requested[0])
})

test('fetchModelsByType works without an api key', async (t) => {
  let calledWith
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calledWith = opts
    return jsonResponse({ data: [] })
  })

  await venice.fetchModelsByType('', 'image')
  assert.equal(calledWith.headers.Authorization, undefined)
})

test('fetchImageModels maps non-200 responses through handleHttpError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 401 }))

  await assert.rejects(
    venice.fetchImageModels('bad-key'),
    (err) => err instanceof ApiError && err.status === 401 && err.message.includes('Invalid API key')
  )
  assert.equal(globalThis.fetch.mock.calls.length, 1)
})

test('fetchImageModels 429 is retried then throws the rate-limit message', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response('slow down', { status: 429 })
  })

  await assert.rejects(
    venice.fetchImageModels('key'),
    (err) => err instanceof ApiError && err.status === 429 && err.message.includes('Rate limited by Venice')
  )
  assert.equal(calls, 3)
})
