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
