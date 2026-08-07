import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let fetchModelsImpl = async () => []
let fetchEndpointsImpl = async () => []
const saveCalls = []
mock.module('../src/providers/index.js', {
  namedExports: {
    getProvider: () => ({
      meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true },
      fetchModels: async () => fetchModelsImpl(),
      fetchEndpoints: async () => fetchEndpointsImpl(),
    }),
  },
})
mock.module('../src/config.js', {
  namedExports: {
    applyPreferenceUpdates: (prefs, updates) => ({ ...prefs, ...updates }),
    savePreferences: async (prefs, path) => { saveCalls.push({ prefs, path }) },
  },
})

const { configSetCmd } = await import('../src/commands/config-set.js')

function opts(overrides = {}) {
  return {
    model: undefined,
    temperature: undefined,
    budget: undefined,
    reasoningEffort: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothSpeed: undefined,
    smoothStreaming: true,
    watermark: true,
    outputDir: undefined,
    aspectRatio: undefined,
    imageFormat: undefined,
    config: undefined,
    ...overrides,
  }
}

test('configSetCmd reports automatic reasoning for models without effort control', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  fetchModelsImpl = async () => [
    { id: 'org/m', name: 'M', contextLength: 1000, reasoning: { supported: true, supportsEffort: false } },
  ]
  fetchEndpointsImpl = async () => [
    { providerName: 'ProviderX', pricing: { prompt: 1e-6, completion: 2e-6 }, supportedParameters: {} },
  ]

  await configSetCmd({ opts: opts({ model: 'org/m' }), prefs: {}, providerType: 'openrouter', apiKey: 'k' })

  assert.ok(logs.some((l) => l.includes('Reasoning: automatic')))
  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].prefs.lastModel, 'org/m')
})

test('configSetCmd reports effort control for models that support it', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  fetchModelsImpl = async () => [
    { id: 'org/m', name: 'M', contextLength: 1000, reasoning: { supported: true, supportsEffort: true } },
  ]
  fetchEndpointsImpl = async () => [
    { providerName: 'ProviderX', pricing: { prompt: 1e-6, completion: 2e-6 }, supportedParameters: {} },
  ]

  await configSetCmd({ opts: opts({ model: 'org/m' }), prefs: {}, providerType: 'openrouter', apiKey: 'k' })

  assert.ok(logs.some((l) => l.includes('Reasoning: effort control supported')))
})

test('configSetCmd with --no-watermark persists hideWatermark and prints the confirmation', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  saveCalls.length = 0

  await configSetCmd({ opts: opts({ watermark: false }), prefs: {}, providerType: 'openrouter', apiKey: 'k' })

  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].prefs.hideWatermark, true)
  assert.ok(logs.some((l) => l.includes('Venice watermark disabled')))
})

test('configSetCmd without --no-watermark does not add the hideWatermark key', async () => {
  saveCalls.length = 0

  await configSetCmd({ opts: opts(), prefs: {}, providerType: 'openrouter', apiKey: 'k' })

  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].prefs.hideWatermark, undefined)
})

test('configSetCmd with --no-safe-mode persists safeMode and prints the confirmation', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  saveCalls.length = 0

  await configSetCmd({ opts: opts({ safeMode: false }), prefs: {}, providerType: 'openrouter', apiKey: 'k' })

  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].prefs.safeMode, false)
  assert.ok(logs.some((l) => l.includes('Venice safe mode disabled')))
})

test('configSetCmd without --no-safe-mode does not add the safeMode key', async () => {
  saveCalls.length = 0

  await configSetCmd({ opts: opts(), prefs: {}, providerType: 'openrouter', apiKey: 'k' })

  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].prefs.safeMode, undefined)
})

test('configSetCmd writes per-provider image defaults and prints confirmations', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  saveCalls.length = 0

  await configSetCmd({ opts: opts({ aspectRatio: '16:9', imageFormat: 'png' }), prefs: {}, providerType: 'venice', apiKey: 'k' })

  assert.equal(saveCalls.length, 1)
  assert.deepEqual(saveCalls[0].prefs.imageDefaults, { venice: { aspectRatio: '16:9', format: 'png' } })
  assert.ok(logs.some((l) => l.includes('Aspect ratio set to 16:9 (venice image defaults)')))
  assert.ok(logs.some((l) => l.includes('Image format set to png (venice image defaults)')))
})

test('configSetCmd merges existing provider defaults instead of replacing them', async () => {
  saveCalls.length = 0

  await configSetCmd({
    opts: opts({ aspectRatio: '3:2' }),
    prefs: { imageDefaults: { venice: { aspectRatio: '1:1', format: 'webp' } } },
    providerType: 'venice',
    apiKey: 'k',
  })

  assert.deepEqual(saveCalls[0].prefs.imageDefaults, { venice: { aspectRatio: '3:2', format: 'webp' } })
})

test('configSetCmd without image flags adds no imageDefaults key', async () => {
  saveCalls.length = 0

  await configSetCmd({ opts: opts(), prefs: {}, providerType: 'venice', apiKey: 'k' })

  assert.equal(saveCalls[0].prefs.imageDefaults, undefined)
})
