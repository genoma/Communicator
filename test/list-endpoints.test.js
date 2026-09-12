import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listEndpointsCmd, matchModelId } from '../src/commands/list-endpoints.js'

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  return {
    allLogs: () => [...console.log.mock.calls, ...console.error.mock.calls].map((c) => String(c.arguments[0])),
  }
}

const models = [
  { id: 'deepseek/deepseek-v4-flash-0731' },
  { id: 'deepseek/deepseek-chat' },
  { id: 'deepseek/deepseek-r1' },
  { id: 'openai/gpt-4o' },
]

test('matchModelId resolves an exact id', () => {
  const { model, candidates } = matchModelId(models, 'deepseek/deepseek-chat')
  assert.equal(model.id, 'deepseek/deepseek-chat')
  assert.deepEqual(candidates, [])
})

test('matchModelId resolves a unique prefix', () => {
  const { model } = matchModelId(models, 'deepseek/deepseek-r1')
  assert.equal(model.id, 'deepseek/deepseek-r1')
})

test('matchModelId resolves a unique substring', () => {
  const { model } = matchModelId(models, 'v4-flash')
  assert.equal(model.id, 'deepseek/deepseek-v4-flash-0731')
})

test('matchModelId returns candidates for ambiguous matches, prefix-first', () => {
  const { model, candidates } = matchModelId(models, 'deepseek/deepseek')
  assert.equal(model, null)
  assert.deepEqual(candidates.map((m) => m.id), [
    'deepseek/deepseek-v4-flash-0731',
    'deepseek/deepseek-chat',
    'deepseek/deepseek-r1',
  ])
})

test('matchModelId is case-insensitive', () => {
  const { model } = matchModelId(models, 'GPT-4O')
  assert.equal(model.id, 'openai/gpt-4o')
})

test('matchModelId returns empty candidates for no match', () => {
  const { model, candidates } = matchModelId(models, 'anthropic/claude')
  assert.equal(model, null)
  assert.deepEqual(candidates, [])
})

test('matchModelId does not duplicate matches', () => {
  const modelsWithDup = [...models, { id: 'deepseek/deepseek-chat' }]
  const { candidates } = matchModelId(modelsWithDup, 'deepseek')
  const ids = candidates.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length)
})

function endpointProvider({ textModels, imageModels, endpoints = [], hasEndpoints = true, imageError = null }) {
  const requested = []
  return {
    requested,
    provider: {
      meta: { hasEndpoints },
      async fetchModels() {
        return textModels
      },
      async fetchImageModels() {
        if (imageError) throw imageError
        return imageModels
      },
      async fetchEndpoints(apiKey, modelId) {
        requested.push(modelId)
        return endpoints
      },
    },
  }
}

const IMAGE_ONLY = { id: 'microsoft/mai-image-2.6', name: 'MAI-Image-2.6' }
const AZURE_ENDPOINT = { providerName: 'Azure', tag: 'azure', uptime30m: null, pricing: { prompt: 5e-6, completion: 0 } }

test('listEndpointsCmd resolves an image-only id from the image catalog', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider, requested } = endpointProvider({
    textModels: [{ id: 'openai/gpt-4o' }],
    imageModels: [IMAGE_ONLY],
    endpoints: [AZURE_ENDPOINT],
  })

  await listEndpointsCmd(provider, 'key', 'microsoft/mai-image-2.6', {})

  assert.deepEqual(requested, ['microsoft/mai-image-2.6'])
  assert.match(consoleSpy.allLogs().join('\n'), /1 provider\(s\) for microsoft\/mai-image-2\.6/)
})

test('listEndpointsCmd resolves an image-only id from a partial id', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider, requested } = endpointProvider({
    textModels: [{ id: 'openai/gpt-4o' }],
    imageModels: [IMAGE_ONLY],
    endpoints: [AZURE_ENDPOINT],
  })

  await listEndpointsCmd(provider, 'key', 'mai-image', {})

  assert.deepEqual(requested, ['microsoft/mai-image-2.6'])
  assert.match(consoleSpy.allLogs().join('\n'), /1 provider\(s\) for microsoft\/mai-image-2\.6/)
})

test('listEndpointsCmd reports an image-only id as Venice-direct when endpoints are unavailable', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider, requested } = endpointProvider({
    textModels: [{ id: 'venice/llama' }],
    imageModels: [{ id: 'venice-sd35', name: 'Venice SD35' }],
    hasEndpoints: false,
  })

  await listEndpointsCmd(provider, 'key', 'venice-sd35', {})

  assert.deepEqual(requested, ['venice-sd35'])
  assert.match(consoleSpy.allLogs().join('\n'), /venice-sd35 is directly available on Venice \(no multi-provider routing\)/)
})

test('listEndpointsCmd still resolves text ids when the image catalog fails', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider, requested } = endpointProvider({
    textModels: [{ id: 'openai/gpt-4o' }],
    imageError: new Error('image catalog unavailable'),
    endpoints: [AZURE_ENDPOINT],
  })

  await listEndpointsCmd(provider, 'key', 'openai/gpt-4o', {})

  assert.deepEqual(requested, ['openai/gpt-4o'])
  assert.match(consoleSpy.allLogs().join('\n'), /1 provider\(s\) for openai\/gpt-4o/)
  assert.match(consoleSpy.allLogs().join('\n'), /Warning: could not load image models; showing text models only\./)
  assert.match(consoleSpy.allLogs().join('\n'), /image catalog unavailable/)
})

test('listEndpointsCmd names both catalogs in the not-found hint', async () => {
  const { provider } = endpointProvider({
    textModels: [{ id: 'openai/gpt-4o' }],
    imageModels: [{ id: 'flux-1-1' }],
  })

  await assert.rejects(
    listEndpointsCmd(provider, 'key', 'nope', {}),
    (err) => /Use --list-models for text models or --list-image-models for image models\./.test(err.message)
  )
})

test('listEndpointsCmd skips the image catalog for a provider without one', async (t) => {
  const consoleSpy = mockConsole(t)
  const requested = []
  const provider = {
    meta: { hasEndpoints: true },
    async fetchModels() {
      return [{ id: 'openai/gpt-4o' }]
    },
    async fetchEndpoints(apiKey, modelId) {
      requested.push(modelId)
      return [AZURE_ENDPOINT]
    },
  }

  await listEndpointsCmd(provider, 'key', 'openai/gpt-4o', {})

  assert.deepEqual(requested, ['openai/gpt-4o'])
  assert.match(consoleSpy.allLogs().join('\n'), /1 provider\(s\) for openai\/gpt-4o/)
})

test('listEndpointsCmd lists both candidates when a partial matches a text and an image model', async () => {
  const { provider } = endpointProvider({
    textModels: [{ id: 'openai/gpt-image-text' }],
    imageModels: [{ id: 'openai/gpt-image-2' }],
  })

  await assert.rejects(
    listEndpointsCmd(provider, 'key', 'gpt-image', {}),
    (err) => /matches 2 models/.test(err.message)
      && /openai\/gpt-image-text/.test(err.message)
      && /openai\/gpt-image-2/.test(err.message)
  )
})

test('listEndpointsCmd counts an id present in both catalogs only once', async () => {
  const { provider } = endpointProvider({
    textModels: [{ id: 'openai/gpt-image-shared' }],
    imageModels: [{ id: 'openai/gpt-image-shared' }, { id: 'openai/gpt-image-only' }],
  })

  await assert.rejects(
    listEndpointsCmd(provider, 'key', 'gpt-image', {}),
    (err) => /matches 2 models/.test(err.message)
  )
})
