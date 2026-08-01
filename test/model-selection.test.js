import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectModelNonInteractive } from '../src/model-selection.js'

function fakeProvider(overrides = {}) {
  return {
    meta: { name: 'venice', hasEndpoints: false },
    async fetchModels() {
      return [
        {
          id: 'auto-reasoner',
          reasoning: { supported: true, supportsEffort: false },
          pricing: { prompt: 0.000002, completion: 0.000004 },
        },
        {
          id: 'effort-model',
          reasoning: { supported: true, supportsEffort: true, default_effort: 'low' },
          pricing: { prompt: 0.000002, completion: 0.000004 },
        },
      ]
    },
    async fetchEndpoints() {
      return [{
        providerName: 'venice',
        pricing: { prompt: 0.000002, completion: 0.000004 },
        supportedParameters: { supportsReasoningEffort: true },
      }]
    },
    ...overrides,
  }
}

test('non-interactive selection keeps auto-reasoning models undefined', async () => {
  const sel = await selectModelNonInteractive({ provider: fakeProvider(), apiKey: '', prefs: {}, modelId: 'auto-reasoner' })
  assert.equal(sel.reasoningEffort, undefined)
  assert.equal(sel.endpointProviderName, 'venice')
})

test('non-interactive selection uses saved pref before model default', async () => {
  const sel = await selectModelNonInteractive({
    provider: fakeProvider(),
    apiKey: '',
    prefs: { reasoningEffort: { 'effort-model': 'high' } },
    modelId: 'effort-model',
  })
  assert.equal(sel.reasoningEffort, 'high')
})

test('non-interactive selection falls back to model default effort', async () => {
  const sel = await selectModelNonInteractive({ provider: fakeProvider(), apiKey: '', prefs: {}, modelId: 'effort-model' })
  assert.equal(sel.reasoningEffort, 'low')
})

test('non-interactive selection defaults to null when model reasoning is disabled by default', async () => {
  const provider = fakeProvider({
    async fetchModels() {
      return [
        {
          id: 'off-by-default',
          reasoning: { supported: true, supportsEffort: true, default_enabled: false, default_effort: 'high' },
          pricing: { prompt: 0.000002, completion: 0.000004 },
        },
      ]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'off-by-default' })
  assert.equal(sel.reasoningEffort, null)
})

test('forced effort flag wins over prefs', async () => {
  const sel = await selectModelNonInteractive({
    provider: fakeProvider(),
    apiKey: '',
    prefs: { reasoningEffort: { 'effort-model': 'high' } },
    modelId: 'effort-model',
    forcedEffort: null,
  })
  assert.equal(sel.reasoningEffort, null)
})

test('openrouter selects cheapest endpoint when multiple available', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchEndpoints() {
      return [
        { providerName: 'Expensive', pricing: { prompt: 0.00001, completion: 0.00002 }, supportedParameters: {} },
        { providerName: 'Cheap', pricing: { prompt: 0.000001, completion: 0.000002 }, supportedParameters: {} },
        { providerName: 'NoPrice', pricing: null, supportedParameters: {} },
      ]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'effort-model' })
  assert.equal(sel.endpointProviderName, 'Cheap')
})

test('non-interactive selection reports web search supported for openrouter via meta flag', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true },
    async fetchModels() {
      return [{ id: 'm', reasoning: null, pricing: null, capabilities: {} }]
    },
    async fetchEndpoints() {
      return [{ providerName: 'P', pricing: null, supportedParameters: {} }]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'm' })
  assert.equal(sel.webSearchSupported, true)
})

test('non-interactive selection reports web search support from venice capabilities', async () => {
  const provider = fakeProvider({
    async fetchModels() {
      return [
        { id: 'm', reasoning: null, pricing: null, capabilities: { supportsWebSearch: true } },
        { id: 'n', reasoning: null, pricing: null, capabilities: { supportsWebSearch: false } },
      ]
    },
  })
  const supported = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'm' })
  const unsupported = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'n' })
  assert.equal(supported.webSearchSupported, true)
  assert.equal(unsupported.webSearchSupported, false)
})

test('non-interactive selection defaults web search unsupported without meta or capabilities', async () => {
  const sel = await selectModelNonInteractive({ provider: fakeProvider(), apiKey: '', prefs: {}, modelId: 'auto-reasoner' })
  assert.equal(sel.webSearchSupported, false)
})

test('non-interactive selection keeps forced string effort over saved pref', async () => {
  const sel = await selectModelNonInteractive({
    provider: fakeProvider(),
    apiKey: '',
    prefs: { reasoningEffort: { 'effort-model': 'low' } },
    modelId: 'effort-model',
    forcedEffort: 'high',
  })
  assert.equal(sel.reasoningEffort, 'high')
  assert.equal(sel.endpointProviderName, 'venice')
  assert.equal(sel.supportsReasoning, true)
  assert.equal(sel.modelReasoning.supportsEffort, true)
  assert.equal(sel.webSearchSupported, false)
})

test('non-interactive selection normalizes a none model default to null', async () => {
  const provider = fakeProvider({
    async fetchModels() {
      return [
        {
          id: 'none-default',
          reasoning: { supported: true, supportsEffort: true, default_effort: 'none' },
          pricing: { prompt: 0.000002, completion: 0.000004 },
        },
      ]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'none-default' })
  assert.equal(sel.reasoningEffort, null)
})
