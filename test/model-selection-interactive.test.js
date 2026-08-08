import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const chosen = { providerName: 'SecondProvider', pricing: { prompt: 2e-6, completion: 4e-6 }, supportedParameters: { supportsReasoningEffort: true } }
const zdrChosen = { providerName: 'ZDR Provider', pricing: { prompt: 2e-6, completion: 4e-6 }, supportedParameters: {}, zdr: true }
let searchQueue = []
let searchMessages = []
let searchChoices = []
let selectQueue = []
let selectMessages = []
let selectChoices = []
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async (opts) => {
      searchMessages.push(opts?.message)
      searchChoices.push(await opts.source(''))
      return searchQueue.shift()
    },
    select: async (opts) => {
      selectMessages.push(opts?.message)
      selectChoices.push(opts?.choices)
      return selectQueue.length ? selectQueue.shift() : 'medium'
    },
    checkbox: async () => { throw new Error('unexpected checkbox') },
  },
})

const { cheapestEndpoint, selectModelAndEndpoint } = await import('../src/model-selection.js')
const { BACK_SENTINEL } = await import('../src/prompts.js')

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

test('interactive selection with zdr shows only zero-retention models and endpoints', async (t) => {
  searchQueue = [{ id: 'org/zdr-model', name: 'ZDR Model' }, zdrChosen]
  searchMessages = []
  searchChoices = []
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true, supportsZdr: true },
    isZdrIndexDegraded: async () => false,
    async fetchModels() {
      return [
        { id: 'org/zdr-model', name: 'ZDR Model', zdr: true, contextLength: 1000, reasoning: { supported: true, supportsEffort: false }, architecture: { input_modalities: [] }, supportedParameters: [] },
        { id: 'org/plain-model', name: 'Plain Model', contextLength: 1000, reasoning: { supported: true, supportsEffort: false }, architecture: { input_modalities: [] }, supportedParameters: [] },
      ]
    },
    async fetchEndpoints() {
      return [
        { providerName: 'PlainProvider', pricing: { prompt: 1e-9, completion: 1e-9 }, supportedParameters: {}, zdr: false },
        { providerName: 'ZDR Provider 2', pricing: { prompt: 1e-5, completion: 2e-5 }, supportedParameters: {}, zdr: true },
        zdrChosen,
      ]
    },
  }

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined, zdr: true })

  assert.equal(sel.modelId, 'org/zdr-model')
  assert.equal(sel.endpointProviderName, 'ZDR Provider')
  assert.deepEqual(searchChoices[0].map((c) => c.value.id), ['org/zdr-model'])
  const providerChoices = searchChoices[1].filter((c) => c.value?.providerName)
  assert.deepEqual(providerChoices.map((c) => c.value.providerName), ['ZDR Provider 2', 'ZDR Provider'])
  assert.ok(providerChoices.every((c) => c.value.zdr === true))
  assert.deepEqual(searchMessages[0], 'Select a model (ZDR-capable only)')
  assert.equal(searchMessages[1], 'Select a provider (2 available, ZDR only)')
})

test('interactive selection with zdr loops back when the picked model has no zero-retention endpoints', async (t) => {
  searchQueue = [{ id: 'org/plain', name: 'Plain' }, { id: 'org/zdr', name: 'ZDR' }, zdrChosen]
  searchMessages = []
  searchChoices = []
  const errorSpy = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true, supportsZdr: true },
    isZdrIndexDegraded: async () => false,
    async fetchModels() {
      return [
        { id: 'org/plain', name: 'Plain', zdr: true, contextLength: 1000, reasoning: { supported: true, supportsEffort: false }, architecture: { input_modalities: [] }, supportedParameters: [] },
        { id: 'org/zdr', name: 'ZDR', zdr: true, contextLength: 1000, reasoning: { supported: true, supportsEffort: false }, architecture: { input_modalities: [] }, supportedParameters: [] },
      ]
    },
    async fetchEndpoints(apiKey, modelId) {
      if (modelId === 'org/plain') {
        return [{ providerName: 'PlainProvider', pricing: { prompt: 1e-9, completion: 1e-9 }, supportedParameters: {}, zdr: false }]
      }
      return [
        { providerName: 'ZDR Provider 2', pricing: { prompt: 1e-5, completion: 2e-5 }, supportedParameters: {}, zdr: true },
        zdrChosen,
      ]
    },
  }

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined, zdr: true })

  assert.equal(sel.modelId, 'org/zdr')
  assert.equal(sel.endpointProviderName, 'ZDR Provider')
  assert.equal(searchChoices.length, 3)
  assert.ok(errorSpy.mock.calls.some((c) => String(c.arguments[0]).includes('No zero-retention providers found for model: org/plain')))
})

test('interactive selection with zdr and a degraded index keeps the full picker and warns', async (t) => {
  searchQueue = [{ id: 'org/plain-model', name: 'Plain Model' }, { providerName: 'NonZdr', pricing: { prompt: 1e-9, completion: 1e-9 }, supportedParameters: {} }]
  searchMessages = []
  searchChoices = []
  const errorSpy = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true, supportsZdr: true },
    isZdrIndexDegraded: async () => true,
    async fetchModels() {
      return [
        { id: 'org/plain-model', name: 'Plain Model', contextLength: 1000, reasoning: { supported: true, supportsEffort: false }, architecture: { input_modalities: [] }, supportedParameters: [] },
      ]
    },
    async fetchEndpoints() {
      return [{ providerName: 'NonZdr', pricing: { prompt: 1e-9, completion: 1e-9 }, supportedParameters: {} }]
    },
  }

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined, zdr: true })

  assert.equal(sel.modelId, 'org/plain-model')
  assert.equal(sel.endpointProviderName, 'NonZdr')
  assert.equal(searchMessages[0], 'Select a model')
  assert.ok(errorSpy.mock.calls.some((c) => String(c.arguments[0]).includes('--zdr filtering disabled')))
})

test('interactive selection loops back to the model picker when the provider picker returns the back sentinel', async (t) => {
  const model = { id: 'org/multi', name: 'Multi', contextLength: 1000, reasoning: { supported: true, supportsEffort: false }, architecture: { input_modalities: [] }, supportedParameters: [] }
  const other = { providerName: 'ThirdProvider', pricing: { prompt: 3e-6, completion: 5e-6 }, supportedParameters: {} }
  searchQueue = [model, BACK_SENTINEL, model, chosen]
  searchMessages = []
  searchChoices = []
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true },
    async fetchModels() { return [model] },
    async fetchEndpoints() { return [chosen, other] },
  }

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.modelId, 'org/multi')
  assert.equal(sel.endpointProviderName, 'SecondProvider')
  assert.equal(searchMessages[0], 'Select a model')
  assert.equal(searchMessages[1], 'Select a provider (2 available)')
  assert.equal(searchMessages[2], 'Select a model')
})

test('interactive selection asks for the reasoning effort when the model supports effort control', async (t) => {
  const model = { id: 'org/effort', name: 'Effort', contextLength: 1000, reasoning: { supported: true, supportsEffort: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' }, architecture: { input_modalities: [] }, supportedParameters: [] }
  searchQueue = [model, chosen]
  selectMessages = []
  selectChoices = []
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true },
    async fetchModels() { return [model] },
    async fetchEndpoints() { return [chosen] },
  }

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.reasoningEffort, 'medium')
  assert.equal(sel.modelReasoning.supportsEffort, true)
  assert.deepEqual(selectMessages, ['Select reasoning effort:'])
  assert.equal(selectChoices[0][0].name, '← Back to model selection')
  assert.equal(selectChoices[0][0].value, BACK_SENTINEL)
})

test('interactive selection picks the provider before asking for the reasoning effort', async (t) => {
  const model = { id: 'org/flow', name: 'Flow', contextLength: 1000, reasoning: { supported: true, supportsEffort: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' }, architecture: { input_modalities: [] }, supportedParameters: [] }
  const other = { providerName: 'ThirdProvider', pricing: { prompt: 3e-6, completion: 5e-6 }, supportedParameters: {} }
  searchQueue = [model, chosen]
  searchMessages = []
  searchChoices = []
  selectMessages = []
  selectChoices = []
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true },
    async fetchModels() { return [model] },
    async fetchEndpoints() { return [chosen, other] },
  }

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.endpointProviderName, 'SecondProvider')
  assert.equal(sel.reasoningEffort, 'medium')
  assert.equal(searchMessages[0], 'Select a model')
  assert.equal(searchMessages[1], 'Select a provider (2 available)')
  assert.deepEqual(selectMessages, ['Select reasoning effort:'])
})

test('interactive selection loops back to the model picker when the reasoning picker returns the back sentinel', async (t) => {
  const model = { id: 'org/multi', name: 'Multi', contextLength: 1000, reasoning: { supported: true, supportsEffort: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' }, architecture: { input_modalities: [] }, supportedParameters: [] }
  const other = { providerName: 'ThirdProvider', pricing: { prompt: 3e-6, completion: 5e-6 }, supportedParameters: {} }
  searchQueue = [model, chosen, model, chosen]
  selectQueue = [BACK_SENTINEL, 'medium']
  searchMessages = []
  searchChoices = []
  selectMessages = []
  selectChoices = []
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true },
    async fetchModels() { return [model] },
    async fetchEndpoints() { return [chosen, other] },
  }

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.modelId, 'org/multi')
  assert.equal(sel.endpointProviderName, 'SecondProvider')
  assert.equal(sel.reasoningEffort, 'medium')
  assert.equal(searchMessages[0], 'Select a model')
  assert.equal(searchMessages[1], 'Select a provider (2 available)')
  assert.equal(searchMessages[2], 'Select a model')
  assert.equal(searchMessages[3], 'Select a provider (2 available)')
  assert.deepEqual(selectMessages, ['Select reasoning effort:', 'Select reasoning effort:'])
  assert.equal(selectChoices[0][0].value, BACK_SENTINEL)
})

test('interactive selection throws when a model has no providers', async (t) => {
  const model = { id: 'org/lonely', name: 'Lonely', contextLength: 1000, reasoning: null, architecture: { input_modalities: [] }, supportedParameters: [] }
  searchQueue = [model]
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true },
    async fetchModels() { return [model] },
    async fetchEndpoints() { return [] },
  }

  await assert.rejects(
    selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined }),
    (err) => err instanceof Error && /No providers found for model: org\/lonely/.test(err.message)
  )
})

test('interactive selection for endpointless providers returns the model route', async (t) => {
  const model = { id: 'venice/model', name: 'V', contextLength: 1000, reasoning: null, architecture: { input_modalities: [] }, capabilities: {} }
  searchQueue = [model]
  t.mock.method(console, 'log', () => {})

  const provider = {
    meta: { name: 'venice', hasEndpoints: false, supportsWebSearchOnAll: false },
    async fetchModels() { return [model] },
    async fetchEndpoints() {
      return [{ providerName: 'venice', pricing: { prompt: 1e-6, completion: 2e-6 }, supportedParameters: {} }]
    },
  }

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.modelId, 'venice/model')
  assert.equal(sel.endpointProviderName, 'venice')
  assert.equal(sel.supportsReasoning, false)
  assert.deepEqual(sel.pricing, { prompt: 1e-6, completion: 2e-6 })
})

function veniceImageProvider() {
  return {
    meta: { name: 'venice', hasEndpoints: false, supportsWebSearchOnAll: false },
    async fetchModels() {
      return [{ id: 'venice/llama', name: 'Llama', contextLength: 32000, reasoning: null, capabilities: {} }]
    },
    async fetchImageModels() {
      return [{ id: 'venice-sd35', name: 'SD 3.5', pricing: { perImage: 0.02 } }]
    },
    async fetchEndpoints() {
      return [{ providerName: 'venice', pricing: { prompt: 1e-6, completion: 2e-6 }, supportedParameters: {} }]
    },
  }
}

test('interactive selection with image models merges them into one picker and returns the image shape', async (t) => {
  searchQueue = [{ id: 'venice-sd35', name: 'SD 3.5' }]
  searchMessages = []
  searchChoices = []
  selectMessages = []
  t.mock.method(console, 'log', () => {})

  const sel = await selectModelAndEndpoint({ provider: veniceImageProvider(), apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.modelId, 'venice-sd35')
  assert.equal(sel.isImageModel, true)
  assert.equal(sel.endpointProviderName, 'venice')
  assert.equal(sel.reasoningEffort, null)
  assert.equal(sel.supportsReasoning, false)
  assert.equal(sel.modelReasoning, null)
  assert.equal(sel.webSearchSupported, false)
  assert.equal(sel.visionSupported, false)
  assert.equal(sel.fileSupported, false)
  assert.equal(sel.imageOutputSupported, undefined)
  assert.equal(sel.contextLength, null)
  assert.deepEqual(sel.pricing, { perImage: 0.02 })

  assert.equal(searchMessages.length, 1)
  assert.equal(searchMessages[0], 'Select a model')
  assert.equal(selectMessages.length, 0)
  const choices = searchChoices[0]
  assert.equal(choices[0].value.id, 'venice/llama')
  assert.equal(choices[1].separator, 'Image models')
  assert.equal(choices[2].value.id, 'venice-sd35')
  assert.equal(choices[2].name, 'SD 3.5  (venice-sd35)  [image]')
})

function openRouterImageProvider(endpoints) {
  return {
    meta: { name: 'openrouter', hasEndpoints: true, supportsWebSearchOnAll: true, supportsZdr: true },
    async fetchModels() {
      return [{ id: 'openai/gpt-5-image', name: 'GPT-5 Image', contextLength: 400000, reasoning: null, architecture: { input_modalities: ['text', 'image'] }, supportedParameters: ['image_url'] }]
    },
    async fetchImageModels() {
      return [{ id: 'openai/gpt-5-image', name: 'GPT-5 Image', pricing: { perImage: 0.05 }, constraints: null, privacy: null, offline: false }]
    },
    async fetchImageModelEndpoints() {
      return endpoints
    },
    async fetchEndpoints() {
      return []
    },
    async isZdrIndexDegraded() {
      return false
    },
  }
}

test('interactive selection asks for a provider when an image model has multiple endpoints', async (t) => {
  searchQueue = [{ id: 'openai/gpt-5-image', name: 'GPT-5 Image' }, { providerName: 'Google AI Studio', slug: 'google-ai-studio', tag: 'google-ai-studio', pricing: { perImage: 0.04 } }]
  searchMessages = []
  searchChoices = []
  t.mock.method(console, 'log', () => {})

  const sel = await selectModelAndEndpoint({ provider: openRouterImageProvider([
    { providerName: 'Google AI Studio', slug: 'google-ai-studio', tag: 'google-ai-studio', pricing: { perImage: 0.04 } },
    { providerName: 'Google Vertex', slug: 'google-vertex/global', tag: 'google-vertex/global', pricing: { perImage: 0.05 } },
  ]), apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.modelId, 'openai/gpt-5-image')
  assert.equal(sel.isImageModel, true)
  assert.equal(sel.endpointProviderName, 'Google AI Studio')
  assert.equal(sel.imageProvider, 'google-ai-studio')
  assert.deepEqual(sel.pricing, { perImage: 0.04 })
  assert.equal(searchMessages[1], 'Select a provider (2 available)')
})

test('interactive selection auto-uses the only image provider and prints its price', async (t) => {
  searchQueue = [{ id: 'openai/gpt-5-image', name: 'GPT-5 Image' }]
  searchMessages = []
  searchChoices = []
  const logged = []
  t.mock.method(console, 'log', (msg) => logged.push(msg))

  const sel = await selectModelAndEndpoint({ provider: openRouterImageProvider([
    { providerName: 'OpenAI', slug: 'openai', tag: 'openai', pricing: { perImage: null, perToken: 0.00004 } },
  ]), apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.endpointProviderName, 'OpenAI')
  assert.equal(sel.imageProvider, 'openai')
  assert.deepEqual(sel.pricing, { perImage: null, perToken: 0.00004 })
  assert.ok(logged.includes('Only one provider available: OpenAI ($40.00 per 1M tokens)'))
  assert.equal(searchMessages.length, 1)
})

test('interactive selection backs out of the image provider picker and re-prompts', async (t) => {
  searchQueue = [{ id: 'openai/gpt-5-image', name: 'GPT-5 Image' }, BACK_SENTINEL, { id: 'openai/gpt-5-image', name: 'GPT-5 Image' }, { providerName: 'Google Vertex', slug: 'google-vertex/global', tag: 'google-vertex/global', pricing: { perImage: 0.05 } }]
  searchMessages = []
  searchChoices = []
  t.mock.method(console, 'log', () => {})

  const sel = await selectModelAndEndpoint({ provider: openRouterImageProvider([
    { providerName: 'Google AI Studio', slug: 'google-ai-studio', tag: 'google-ai-studio', pricing: { perImage: 0.04 } },
    { providerName: 'Google Vertex', slug: 'google-vertex/global', tag: 'google-vertex/global', pricing: { perImage: 0.05 } },
  ]), apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.endpointProviderName, 'Google Vertex')
  assert.equal(sel.imageProvider, 'google-vertex/global')
  assert.equal(searchMessages.length, 4)
  assert.equal(searchMessages[1], 'Select a provider (2 available)')
  assert.equal(searchMessages[3], 'Select a provider (2 available)')
})

test('interactive selection with image models keeps the text flow for text picks', async (t) => {
  searchQueue = [{ id: 'venice/llama', name: 'Llama' }]
  searchMessages = []
  searchChoices = []
  t.mock.method(console, 'log', () => {})

  const sel = await selectModelAndEndpoint({ provider: veniceImageProvider(), apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.modelId, 'venice/llama')
  assert.equal(sel.isImageModel, undefined)
  assert.equal(sel.endpointProviderName, 'venice')
  assert.equal(searchMessages.length, 1)
})

test('interactive selection degrades to text-only when the image listing fails', async (t) => {
  const provider = veniceImageProvider()
  provider.fetchImageModels = async () => { throw new Error('image listing down') }
  searchQueue = [{ id: 'venice/llama', name: 'Llama' }]
  searchMessages = []
  searchChoices = []
  const errorSpy = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'log', () => {})

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined })

  assert.equal(sel.modelId, 'venice/llama')
  assert.equal(sel.isImageModel, undefined)
  assert.ok(errorSpy.mock.calls.some((c) => String(c.arguments[0]).includes('could not load image models')))
  assert.deepEqual(searchChoices[0].map((c) => c.value.id), ['venice/llama'])
})

test('interactive selection skips the image merge when zdr is active', async (t) => {
  const provider = veniceImageProvider()
  provider.meta = { ...provider.meta, supportsZdr: true }
  provider.isZdrIndexDegraded = async () => false
  provider.fetchModels = async () => [{ id: 'venice/llama', name: 'Llama', zdr: true, contextLength: 32000, reasoning: null, capabilities: {} }]
  provider.fetchEndpoints = async () => [{ providerName: 'venice', pricing: { prompt: 1e-6, completion: 2e-6 }, supportedParameters: {}, zdr: true }]
  searchQueue = [{ id: 'venice/llama', name: 'Llama' }]
  searchMessages = []
  searchChoices = []
  t.mock.method(console, 'log', () => {})

  const sel = await selectModelAndEndpoint({ provider, apiKey: 'k', prefs: {}, reasoningEffort: undefined, zdr: true })

  assert.equal(sel.modelId, 'venice/llama')
  assert.equal(sel.isImageModel, undefined)
  assert.deepEqual(searchChoices[0].map((c) => c.value.id), ['venice/llama'])
})
