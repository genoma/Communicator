import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectModelNonInteractive, findImageModel } from '../src/model-selection.js'
import { CliError } from '../src/errors.js'

function fakeProvider(overrides = {}) {
  return {
    meta: { name: 'venice', hasEndpoints: false },
    async fetchModels() {
      return [
        {
          id: 'auto-reasoner',
          reasoning: { supported: true, supportsEffort: false },
          pricing: { prompt: 0.000002, completion: 0.000004 },
          contextLength: 32000,
        },
        {
          id: 'effort-model',
          reasoning: { supported: true, supportsEffort: true, default_effort: 'low' },
          pricing: { prompt: 0.000002, completion: 0.000004 },
          contextLength: 32000,
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

test('non-interactive selection resolves alias rows to the canonical model id for prefs', async () => {
  const provider = fakeProvider({
    async fetchModels() {
      return [
        { id: 'test/model-a', aliasTarget: null, reasoning: { supported: true, supportsEffort: true, default_effort: 'low' }, pricing: { prompt: 1e-6, completion: 2e-6 }, contextLength: 128000 },
        { id: '~test/model-a-latest', aliasTarget: 'test/model-a', reasoning: { supported: true, supportsEffort: true, default_effort: 'low' }, pricing: { prompt: 1e-6, completion: 2e-6 }, contextLength: 128000 },
      ]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: { reasoningEffort: { 'test/model-a': 'high' } }, modelId: '~test/model-a-latest' })
  assert.equal(sel.modelId, 'test/model-a')
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

test('selection reports E2EE support from venice capabilities', async () => {
  const provider = fakeProvider({
    async fetchModels() {
      return [
        { id: 'e2ee-model', reasoning: null, pricing: null, capabilities: { supportsE2EE: true } },
        { id: 'plain-model', reasoning: null, pricing: null, capabilities: { supportsE2EE: false } },
      ]
    },
  })
  const e2eeSel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'e2ee-model' })
  const plainSel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'plain-model' })
  assert.equal(e2eeSel.supportsE2EE, true)
  assert.equal(plainSel.supportsE2EE, false)
})

test('selection leaves E2EE support undefined for openrouter models', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchModels() {
      return [{ id: 'm', reasoning: null, pricing: null, capabilities: { supportsE2EE: true } }]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'm' })
  assert.equal(sel.supportsE2EE, undefined)
})

test('--e2ee rejects models without E2EE support', async () => {
  const provider = fakeProvider({
    async fetchModels() {
      return [
        { id: 'e2ee-model', reasoning: null, pricing: null, capabilities: { supportsE2EE: true } },
        { id: 'plain-model', reasoning: null, pricing: null, capabilities: {} },
      ]
    },
  })
  const e2eeSel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'e2ee-model', e2ee: true })
  assert.equal(e2eeSel.supportsE2EE, true)
  await assert.rejects(
    selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'plain-model', e2ee: true }),
    (err) => err instanceof CliError && /does not support E2EE/.test(err.message)
  )
})

test('--e2ee rejects unknown models without falling back to image models', async () => {
  const provider = fakeProvider({
    async fetchModels() {
      return [{ id: 'e2ee-model', reasoning: null, pricing: null, capabilities: { supportsE2EE: true } }]
    },
  })
  await assert.rejects(
    selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'some-image', e2ee: true }),
    (err) => err instanceof CliError && /not an E2EE-capable model/.test(err.message)
  )
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

test('selection carries the context length from model data', async () => {
  const sel = await selectModelNonInteractive({ provider: fakeProvider(), apiKey: '', prefs: {}, modelId: 'auto-reasoner' })
  assert.equal(sel.contextLength, 32000)
})

test('selection prefers the endpoint context length over model data', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchEndpoints() {
      return [{ providerName: 'P', pricing: null, supportedParameters: {}, contextLength: 64000 }]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'effort-model' })
  assert.equal(sel.contextLength, 64000)
})

test('selection defaults the context length to null when unknown', async () => {
  const provider = fakeProvider({
    async fetchModels() {
      return [{ id: 'unknown-window', reasoning: null, pricing: null }]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'unknown-window' })
  assert.equal(sel.contextLength, null)
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

test('selection reports vision support from openrouter architecture modalities', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchModels() {
      return [{ id: 'vision', reasoning: null, pricing: null, architecture: { input_modalities: ['text', 'image'] }, supportedParameters: null }]
    },
    async fetchEndpoints() {
      return [{ providerName: 'P', pricing: null, supportedParameters: [] }]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'vision' })
  assert.equal(sel.visionSupported, true)
  assert.equal(sel.fileSupported, true)
})

test('selection reports image output support from openrouter output modalities', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchModels() {
      return [
        { id: 'image-maker', reasoning: null, pricing: null, architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] }, supportedParameters: null },
        { id: 'text-only', reasoning: null, pricing: null, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supportedParameters: null },
        { id: 'no-meta', reasoning: null, pricing: null },
      ]
    },
    async fetchEndpoints() {
      return [{ providerName: 'P', pricing: null, supportedParameters: [] }]
    },
  })
  const imageMaker = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'image-maker' })
  assert.equal(imageMaker.imageOutputSupported, true)
  const textOnly = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'text-only' })
  assert.equal(textOnly.imageOutputSupported, undefined)
  const noMeta = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'no-meta' })
  assert.equal(noMeta.imageOutputSupported, undefined)
})

test('selection reports no vision when modalities exclude image', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchModels() {
      return [{ id: 'text-only', reasoning: null, pricing: null, architecture: { input_modalities: ['text'] }, supportedParameters: null }]
    },
    async fetchEndpoints() {
      return [{ providerName: 'P', pricing: null, supportedParameters: [] }]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'text-only' })
  assert.equal(sel.visionSupported, false)
})

test('selection proves vision via endpoint supportedParameters', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchModels() {
      return [{ id: 'alias-model', reasoning: null, pricing: null, architecture: { input_modalities: [] }, supportedParameters: null }]
    },
    async fetchEndpoints() {
      return [{ providerName: 'P', pricing: null, supportedParameters: ['image_url', 'reasoning'] }]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'alias-model' })
  assert.equal(sel.visionSupported, true)
})

test('selection keeps vision unknown when no metadata is available', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchModels() {
      return [{ id: 'mystery', reasoning: null, pricing: null }]
    },
    async fetchEndpoints() {
      return [{ providerName: 'P', pricing: null, supportedParameters: undefined }]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'mystery' })
  assert.equal(sel.visionSupported, undefined)
  assert.equal(sel.fileSupported, true)
})

test('selection reads venice vision and file capabilities', async () => {
  const provider = fakeProvider({
    async fetchModels() {
      return [
        { id: 'vision', reasoning: null, pricing: null, capabilities: { supportsVision: true } },
        { id: 'no-vision', reasoning: null, pricing: null, capabilities: { supportsVision: false } },
        { id: 'no-files', reasoning: null, pricing: null, capabilities: { supportsFileInput: false } },
      ]
    },
  })
  const vision = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'vision' })
  assert.equal(vision.visionSupported, true)
  assert.equal(vision.fileSupported, true)
  const noVision = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'no-vision' })
  assert.equal(noVision.visionSupported, false)
  const noFiles = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'no-files' })
  assert.equal(noFiles.visionSupported, undefined)
  assert.equal(noFiles.fileSupported, false)
})

test('openrouter file support comes from the supported_parameters list', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchModels() {
      return [
        { id: 'files', reasoning: null, pricing: null, supportedParameters: ['file', 'image_url'] },
        { id: 'no-files', reasoning: null, pricing: null, supportedParameters: ['image_url'] },
      ]
    },
    async fetchEndpoints() {
      return [{ providerName: 'P', pricing: null, supportedParameters: [] }]
    },
  })
  const files = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'files' })
  assert.equal(files.fileSupported, true)
  const noFiles = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'no-files' })
  assert.equal(noFiles.fileSupported, false)
})

test('non-interactive selection with zdr picks the cheapest zero-retention endpoint', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true, supportsZdr: true },
    isZdrIndexDegraded: async () => false,
    async fetchEndpoints() {
      return [
        { providerName: 'NonZdrCheap', pricing: { prompt: 1e-9, completion: 1e-9 }, supportedParameters: {}, zdr: false },
        { providerName: 'ZdrCheap', pricing: { prompt: 1e-6, completion: 2e-6 }, supportedParameters: {}, zdr: true },
        { providerName: 'ZdrExpensive', pricing: { prompt: 1e-5, completion: 2e-5 }, supportedParameters: {}, zdr: true },
      ]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'effort-model', zdr: true })
  assert.equal(sel.endpointProviderName, 'ZdrCheap')
})

test('non-interactive selection with zdr rejects when no endpoint is zero-retention', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true, supportsZdr: true },
    isZdrIndexDegraded: async () => false,
    async fetchEndpoints() {
      return [
        { providerName: 'NonZdr', pricing: { prompt: 1e-6, completion: 2e-6 }, supportedParameters: {}, zdr: false },
      ]
    },
  })
  await assert.rejects(
    selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'effort-model', zdr: true }),
    (err) => err instanceof CliError && err.message.includes('no zero-retention providers')
  )
})

test('non-interactive selection with zdr and a degraded index skips filtering and warns', async (t) => {
  const warnSpy = t.mock.method(console, 'error', () => {})
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true, supportsZdr: true },
    isZdrIndexDegraded: async () => true,
    async fetchEndpoints() {
      return [
        { providerName: 'NonZdrCheap', pricing: { prompt: 1e-9, completion: 1e-9 }, supportedParameters: {}, zdr: false },
        { providerName: 'ZdrExpensive', pricing: { prompt: 1e-5, completion: 2e-5 }, supportedParameters: {}, zdr: true },
      ]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'effort-model', zdr: true })
  assert.equal(sel.endpointProviderName, 'NonZdrCheap')
  assert.ok(warnSpy.mock.calls.some((c) => String(c.arguments[0]).includes('--zdr filtering disabled')))
})

test('non-interactive selection with zdr ignores the flag for providers without supportsZdr', async () => {
  const sel = await selectModelNonInteractive({ provider: fakeProvider(), apiKey: '', prefs: {}, modelId: 'auto-reasoner', zdr: true })
  assert.equal(sel.endpointProviderName, 'venice')
})

test('findImageModel returns null when the provider has no image models', async () => {
  assert.equal(await findImageModel(fakeProvider(), 'k', 'venice-sd35'), null)
})

test('findImageModel finds an image model by id and null for unknown ids', async () => {
  const provider = fakeProvider({
    async fetchImageModels() {
      return [{ id: 'venice-sd35', name: 'SD 3.5' }, { id: 'flux-1-1', name: 'Flux' }]
    },
  })
  assert.equal((await findImageModel(provider, 'k', 'flux-1-1')).id, 'flux-1-1')
  assert.equal(await findImageModel(provider, 'k', 'missing'), null)
})

test('non-interactive selection falls back to the image shape for image model ids', async () => {
  const constraints = { aspectRatios: ['1:1', '16:9'], formats: ['png', 'webp'], widthHeightDivisor: null }
  const provider = fakeProvider({
    async fetchImageModels() {
      return [{ id: 'venice-sd35', name: 'SD 3.5', pricing: { perImage: 0.02 }, constraints }]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'venice-sd35' })
  assert.equal(sel.id, 'venice-sd35')
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
  assert.deepEqual(sel.constraints, constraints)
  assert.deepEqual(sel.pricing, { perImage: 0.02 })
})

test('non-interactive selection picks the cheapest image endpoint silently', async () => {
  const provider = fakeProvider({
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchModels() {
      return [{ id: 'openai/gpt-5-image', name: 'GPT-5 Image', contextLength: 400000, reasoning: null }]
    },
    async fetchImageModels() {
      return [{ id: 'image-only/foo', name: 'Image Only', pricing: null }]
    },
    async fetchImageModelEndpoints() {
      return [
        { providerName: 'Expensive', slug: 'exp', tag: 'exp', pricing: { perImage: 0.1 } },
        { providerName: 'Cheap', slug: 'cheap', tag: 'cheap', pricing: { perImage: 0.02 } },
      ]
    },
  })
  const sel = await selectModelNonInteractive({ provider, apiKey: 'k', prefs: {}, modelId: 'image-only/foo' })
  assert.equal(sel.isImageModel, true)
  assert.equal(sel.endpointProviderName, 'Cheap')
  assert.equal(sel.imageProvider, 'cheap')
  assert.deepEqual(sel.pricing, { perImage: 0.02 })
})

test('non-interactive selection does not fall back to image models under --zdr', async () => {
  const provider = fakeProvider({
    meta: { name: 'venice', hasEndpoints: false, supportsZdr: true },
    isZdrIndexDegraded: async () => false,
    async fetchImageModels() {
      return [{ id: 'venice-sd35', name: 'SD 3.5' }]
    },
  })
  await assert.rejects(
    selectModelNonInteractive({ provider, apiKey: '', prefs: {}, modelId: 'venice-sd35', zdr: true }),
    (err) => err instanceof CliError && err.message.includes('no zero-retention providers')
  )
})
