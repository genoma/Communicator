import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { ApiError } from '../src/errors.js'
import { fetchImageModels, resetImageModelCaches, generateImage, fetchImageModelEndpoints } from '../src/providers/openrouter.js'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const IMAGE_MODEL = {
  id: 'openai/gpt-image-1-mini',
  name: 'GPT Image 1 Mini',
  description: 'Small fast image model',
  supported_parameters: {
    aspect_ratio: { type: 'enum', values: ['1:1', '3:2', '2:3', 'auto'] },
    output_format: { type: 'enum', values: ['png', 'jpeg'] },
    resolution: { type: 'enum', values: ['1024x1024', '2048x2048'] },
    quality: { type: 'enum', values: ['low', 'high'] },
    n: { type: 'range', min: 1, max: 10 },
    seed: { type: 'boolean' },
  },
}

const NO_PARAM_MODEL = {
  id: 'openai/gpt-image-1',
  name: 'GPT Image 1',
  description: 'No structured params',
  supported_parameters: { seed: { boolean: true } },
}

test('fetchImageModelEndpoints percent-encodes reserved characters in the model id path', async (t) => {
  resetImageModelCaches()
  const requested = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url))
    return jsonResponse({ data: { endpoints: [{ provider_name: 'P', pricing: [] }] } })
  })

  await fetchImageModelEndpoints('key', 'org/model?#sp ace')

  assert.ok(requested[0].includes('/images/models/org/model%3F%23sp%20ace/endpoints'), requested[0])
})

test('fetchImageModelEndpoints rejects model ids with dot segments', async (t) => {
  resetImageModelCaches()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: { endpoints: [] } }))

  await assert.rejects(fetchImageModelEndpoints('key', 'org/../etc'), /Invalid model id/)
})

test('fetchImageModels normalizes typed descriptors into constraints', async (t) => {
  resetImageModelCaches()
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).endsWith('/images/models'), String(url))
    return jsonResponse({ data: [IMAGE_MODEL, NO_PARAM_MODEL] })
  })

  const models = await fetchImageModels('key')

  assert.equal(models.length, 2)
  const m = models[0]
  assert.equal(m.id, 'openai/gpt-image-1-mini')
  assert.equal(m.name, 'GPT Image 1 Mini')
  assert.equal(m.provider, 'openai')
  assert.deepEqual(m.constraints.aspectRatios, ['1:1', '3:2', '2:3', 'auto'])
  assert.deepEqual(m.constraints.formats, ['png', 'jpeg'])
  assert.deepEqual(m.constraints.resolutions, ['1024x1024', '2048x2048'])
  assert.deepEqual(m.constraints.qualities, ['low', 'high'])
  assert.equal(m.constraints.maxN, 10)
  assert.equal(m.constraints.widthHeightDivisor, null)
  assert.equal(m.constraints.defaultAspectRatio, null)
  assert.equal(m.pricing, null)
  assert.equal(m.offline, false)

  const none = models[1]
  assert.equal(none.constraints.aspectRatios, null)
  assert.equal(none.constraints.formats, null)
  assert.equal(none.constraints.maxN, null)
})

test('fetchImageModels does not fetch per-model pricing by default', async (t) => {
  resetImageModelCaches()
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    return jsonResponse({ data: [IMAGE_MODEL] })
  })

  await fetchImageModels('key')

  assert.equal(calls.length, 1)
  assert.ok(calls[0].endsWith('/images/models'))
})

test('fetchImageModels with pricing fetches endpoints and takes the minimum', async (t) => {
  resetImageModelCaches()
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    if (String(url).includes('/endpoints')) {
      return jsonResponse({
        id: 'openai/gpt-image-1-mini',
        endpoints: [
          { name: 'A', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.02 }, { billable: 'output_image', unit: 'image', cost_usd: 0.01, variant: '1024x1024' }] },
          { name: 'B', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.015 }] },
          { name: 'C', pricing: [{ billable: 'input_tokens', unit: 'token', cost_usd: 0.0001 }] },
        ],
      })
    }
    return jsonResponse({ data: [IMAGE_MODEL] })
  })

  const models = await fetchImageModels('key', { withPricing: true })

  assert.equal(calls.length, 2)
  assert.ok(calls[1].endsWith('/images/models/openai/gpt-image-1-mini/endpoints'), calls[1])
  assert.deepEqual(models[0].pricing, { perImage: 0.015, perToken: null, byResolution: null, byQuality: null })
})

test('fetchImageModels pricing falls back to the variant-tier minimum when no flat entry exists', async (t) => {
  resetImageModelCaches()
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/endpoints')) {
      return jsonResponse({
        id: 'qwen/qwen-image-3',
        endpoints: [{ name: 'A', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.03, variant: '1k' }, { billable: 'output_image', unit: 'image', cost_usd: 0.04, variant: '2k' }] }],
      })
    }
    return jsonResponse({ data: [IMAGE_MODEL] })
  })

  const models = await fetchImageModels('key', { withPricing: true })

  assert.deepEqual(models[0].pricing, { perImage: 0.03, perToken: null, byResolution: null, byQuality: null })
})

test('fetchImageModels pricing captures token-billed output_image entries', async (t) => {
  resetImageModelCaches()
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/endpoints')) {
      return jsonResponse({
        id: 'microsoft/mai-image-2.5-pro',
        endpoints: [{ name: 'A', pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.000108 }] }],
      })
    }
    return jsonResponse({ data: [IMAGE_MODEL] })
  })

  const models = await fetchImageModels('key', { withPricing: true })

  assert.deepEqual(models[0].pricing, { perImage: null, perToken: 0.000108, byResolution: null, byQuality: null })
})

test('fetchImageModels pricing falls back to nulls when no output_image entries exist', async (t) => {
  resetImageModelCaches()
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/endpoints')) {
      return jsonResponse({ endpoints: [{ name: 'A', pricing: [{ billable: 'input_tokens', unit: 'token', cost_usd: 0.0001 }] }] })
    }
    return jsonResponse({ data: [IMAGE_MODEL] })
  })

  const models = await fetchImageModels('key', { withPricing: true })

  assert.deepEqual(models[0].pricing, { perImage: null, perToken: null, byResolution: null, byQuality: null })
})

test('fetchImageModelEndpoints maps provider names, tags and per-endpoint pricing', async (t) => {
  resetImageModelCaches()
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).endsWith('/images/models/qwen/qwen-image-3/endpoints'), String(url))
    return jsonResponse({
      id: 'qwen/qwen-image-3',
      endpoints: [
        { provider_name: 'Alibaba Cloud Int.', provider_slug: 'alibaba', provider_tag: 'alibaba', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.03 }, { billable: 'output_image', unit: 'image', cost_usd: 0.05, variant: '2k' }] },
        { provider_name: 'Another Host', provider_slug: 'another', provider_tag: 'another', pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.00004 }] },
      ],
    })
  })

  const { fetchImageModelEndpoints } = await import('../src/providers/openrouter.js')
  const endpoints = await fetchImageModelEndpoints('key', 'qwen/qwen-image-3')

  assert.deepEqual(endpoints, [
    { providerName: 'Alibaba Cloud Int.', slug: 'alibaba', tag: 'alibaba', pricing: { perImage: 0.03, perToken: null, byResolution: null, byQuality: null } },
    { providerName: 'Another Host', slug: 'another', tag: 'another', pricing: { perImage: null, perToken: 0.00004, byResolution: null, byQuality: null } },
  ])
})

test('fetchImageModels and fetchImageModelEndpoints dedupe within the cache TTL', async (t) => {
  resetImageModelCaches()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++
    if (String(url).includes('/endpoints')) {
      return jsonResponse({ endpoints: [{ name: 'A', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.02 }] }] })
    }
    return jsonResponse({ data: [IMAGE_MODEL] })
  })

  const { fetchImageModelEndpoints } = await import('../src/providers/openrouter.js')
  await fetchImageModels('key')
  await fetchImageModels('key')
  const first = await fetchImageModelEndpoints('key', IMAGE_MODEL.id)
  const second = await fetchImageModelEndpoints('key', IMAGE_MODEL.id)

  assert.equal(calls, 2)
  assert.deepEqual(first, second)
  assert.equal(first[0].pricing.perImage, 0.02)
})

test('generateImage routes through the chosen provider when one is given', async (t) => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    bodies.push(JSON.parse(opts.body))
    return jsonResponse({ data: [{ b64_json: Buffer.from('img').toString('base64'), media_type: 'image/png' }], usage: { cost: 0.01 } })
  })

  await generateImage({ apiKey: 'key', model: 'qwen/qwen-image-3', prompt: 'p', provider: 'Alibaba Cloud Int.' })
  await generateImage({ apiKey: 'key', model: 'qwen/qwen-image-3', prompt: 'p' })

  assert.deepEqual(bodies[0].provider, { order: ['Alibaba Cloud Int.'], allow_fallbacks: false })
  assert.equal(bodies[1].provider, undefined)
})

test('generateImage downloads URL-only image responses', async (t) => {
  let fetchCount = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetchCount++
    assert.equal(String(url).endsWith('/images'), true)
    return jsonResponse({ data: [{ url: 'https://example.com/img.png', media_type: 'image/png' }], usage: { cost: 0.01 } })
  })
  const requestFn = (parsed) => {
    assert.equal(parsed.hostname, 'example.com')
    const res = Readable.from([Buffer.from('fetched-bytes')])
    res.statusCode = 200
    res.headers = { 'content-type': 'image/png' }
    return {
      on(event, listener) {
        if (event === 'response') queueMicrotask(() => listener(res))
        return this
      },
      end() {},
    }
  }

  const result = await generateImage({ apiKey: 'key', model: 'qwen/qwen-image-3', prompt: 'p', requestFn })
  assert.equal(fetchCount, 1)
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].dataUrl, `data:image/png;base64,${Buffer.from('fetched-bytes').toString('base64')}`)
})

test('generateImage throws when an image has neither base64 data nor a usable URL', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: [{ media_type: 'image/png' }], usage: { cost: 0.01 } }))
  await assert.rejects(
    generateImage({ apiKey: 'key', model: 'qwen/qwen-image-3', prompt: 'p' }),
    /without base64 data or a usable URL/
  )
})

test('fetchImageModels maps 400 bodies through handleHttpError with the message', async (t) => {
  resetImageModelCaches()
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Invalid model' } }), { status: 400 }))

  await assert.rejects(
    fetchImageModels('key'),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes('Invalid model')
  )
})

test('generateImage maps parameters onto the request body', async (t) => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.ok(String(url).endsWith('/images'))
    bodies.push(JSON.parse(opts.body))
    return jsonResponse({
      id: 'gen-1',
      data: [
        { b64_json: Buffer.from('img1').toString('base64'), media_type: 'image/png' },
        { b64_json: Buffer.from('img2').toString('base64'), media_type: 'image/jpeg' },
      ],
      usage: { cost: 0.03 },
    })
  })

  const result = await generateImage({
    apiKey: 'key',
    model: 'openai/gpt-image-1-mini',
    prompt: 'a red cat',
    format: 'png',
    variants: 2,
    aspectRatio: '3:2',
    resolution: '1024x1024',
    quality: 'high',
    seed: 7,
  })

  assert.deepEqual(bodies[0], {
    model: 'openai/gpt-image-1-mini',
    prompt: 'a red cat',
    n: 2,
    aspect_ratio: '3:2',
    output_format: 'png',
    resolution: '1024x1024',
    quality: 'high',
    seed: 7,
  })
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(result.images[0].ext, 'png')
  assert.equal(result.images[1].mime, 'image/jpeg')
  assert.equal(result.images[1].ext, 'jpg')
  assert.equal(result.cost, 0.015)
  assert.equal(result.blurred, false)
})

test('generateImage omits absent params and derives size from width/height', async (t) => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    bodies.push(JSON.parse(opts.body))
    return jsonResponse({ data: [{ b64_json: Buffer.from('img').toString('base64'), media_type: 'image/png' }], usage: { cost: 0.01 } })
  })

  await generateImage({
    apiKey: 'key',
    model: 'openai/gpt-image-1-mini',
    prompt: 'plain',
    width: 1024,
    height: 768,
  })

  assert.deepEqual(bodies[0], { model: 'openai/gpt-image-1-mini', prompt: 'plain', n: 1, size: '1024x768' })
})

test('generateImage skips size when aspectRatio is set', async (t) => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    bodies.push(JSON.parse(opts.body))
    return jsonResponse({ data: [{ b64_json: Buffer.from('img').toString('base64'), media_type: 'image/png' }], usage: { cost: 0.01 } })
  })

  await generateImage({ apiKey: 'key', model: 'm', prompt: 'p', aspectRatio: '16:9', width: 1024, height: 768 })

  assert.equal(bodies[0].size, undefined)
  assert.equal(bodies[0].aspect_ratio, '16:9')
})

test('generateImage reports an empty data array as an ApiError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: [] }))

  await assert.rejects(
    generateImage({ apiKey: 'key', model: 'm', prompt: 'p' }),
    (err) => err instanceof ApiError && err.message.includes('no images')
  )
})

test('generateImage surfaces provider-rejection 400s with the accepted-values message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ error: { message: 'No provider supports this parameter. Accepted: 1:1, 3:2, 2:3, auto' } }),
    { status: 400 }
  ))

  await assert.rejects(
    generateImage({ apiKey: 'key', model: 'm', prompt: 'p' }),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes('Accepted: 1:1, 3:2, 2:3, auto')
  )
})
