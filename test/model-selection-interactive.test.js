import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const chosen = { providerName: 'SecondProvider', pricing: { prompt: 2e-6, completion: 4e-6 }, supportedParameters: { supportsReasoningEffort: true } }
let searchQueue = []
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async () => searchQueue.shift(),
    select: async () => 'medium',
  },
})

const { cheapestEndpoint, selectModelAndEndpoint } = await import('../src/model-selection.js')

test('cheapestEndpoint picks the endpoint with the lowest combined price', () => {
  const endpoints = [
    { providerName: 'Expensive', pricing: { prompt: 0.00001, completion: 0.00002 } },
    { providerName: 'Cheap', pricing: { prompt: 0.000001, completion: 0.000002 } },
    { providerName: 'Mid', pricing: { prompt: 0.000005, completion: 0.000006 } },
  ]
  assert.equal(cheapestEndpoint(endpoints).providerName, 'Cheap')
})

test('cheapestEndpoint skips endpoints without pricing', () => {
  const endpoints = [
    { providerName: 'NoPrice', pricing: null },
    { providerName: 'Cheap', pricing: { prompt: 0.000001, completion: 0.000002 } },
    { providerName: 'Partial', pricing: { prompt: 0.000001, completion: null } },
  ]
  assert.equal(cheapestEndpoint(endpoints).providerName, 'Cheap')
})

test('cheapestEndpoint returns the first endpoint when nothing is priced', () => {
  const endpoints = [
    { providerName: 'First', pricing: null },
    { providerName: 'Second', pricing: { prompt: null, completion: null } },
  ]
  assert.equal(cheapestEndpoint(endpoints).providerName, 'First')
})

test('cheapestEndpoint returns undefined for an empty list', () => {
  assert.equal(cheapestEndpoint([]), undefined)
})

test('interactive selection picks a provider among multiple endpoints', async (t) => {
  searchQueue = [{ id: 'org/multi', name: 'Multi' }, chosen]
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true },
    async fetchModels() {
      return [{
        id: 'org/multi',
        name: 'Multi',
        contextLength: 1000,
        reasoning: { supported: true, supportsEffort: false },
        architecture: { input_modalities: [] },
        supportedParameters: [],
      }]
    },
    async fetchEndpoints() {
      return [
        { providerName: 'FirstProvider', pricing: { prompt: 1e-6, completion: 2e-6 }, supportedParameters: {} },
        chosen,
      ]
    },
  }

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.modelId, 'org/multi')
  assert.equal(sel.endpointProviderName, 'SecondProvider')
  assert.equal(sel.reasoningEffort, undefined)
  assert.equal(sel.supportsReasoning, true)
  assert.deepEqual(sel.pricing, chosen.pricing)
})
