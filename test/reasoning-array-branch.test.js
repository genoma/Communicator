import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endpointSupportsReasoning } from '../src/reasoning.js'
import { selectModelNonInteractive } from '../src/model-selection.js'

function fakeProvider(endpoint) {
  return {
    meta: { name: 'openrouter', hasEndpoints: true },
    async fetchModels() {
      return [{ id: 'alias-model', reasoning: null, pricing: null, architecture: { input_modalities: [] }, supportedParameters: null }]
    },
    async fetchEndpoints() {
      return [{ providerName: 'P', pricing: null, ...endpoint }]
    },
  }
}

test('endpointSupportsReasoning: an OpenRouter parameter array carrying reasoning is supported', () => {
  assert.equal(endpointSupportsReasoning({ supportedParameters: ['image_url', 'reasoning'] }), true)
  assert.equal(endpointSupportsReasoning({ supportedParameters: ['reasoning'] }), true)
})

test('endpointSupportsReasoning: a parameter array without reasoning is unsupported', () => {
  assert.equal(endpointSupportsReasoning({ supportedParameters: ['image_url', 'temperature'] }), false)
  assert.equal(endpointSupportsReasoning({ supportedParameters: [] }), false)
})

test('endpointSupportsReasoning: the Venice capability object is honored', () => {
  assert.equal(endpointSupportsReasoning({ supportedParameters: { supportsReasoningEffort: true } }), true)
})

test('endpointSupportsReasoning: missing or false capabilities are unsupported', () => {
  assert.equal(endpointSupportsReasoning({ supportedParameters: { supportsReasoningEffort: false } }), false)
  assert.equal(endpointSupportsReasoning({ supportedParameters: {} }), false)
  assert.equal(endpointSupportsReasoning({ supportedParameters: undefined }), false)
  assert.equal(endpointSupportsReasoning(undefined), false)
})

test('selection reports reasoning support for an array-shaped endpoint', async () => {
  const sel = await selectModelNonInteractive({ provider: fakeProvider({ supportedParameters: ['image_url', 'reasoning'] }), apiKey: '', prefs: {}, modelId: 'alias-model' })

  assert.equal(sel.supportsReasoning, true)
  assert.equal(sel.visionSupported, true)
})

test('selection keeps reasoning unsupported for an array without reasoning', async () => {
  const sel = await selectModelNonInteractive({ provider: fakeProvider({ supportedParameters: ['image_url'] }), apiKey: '', prefs: {}, modelId: 'alias-model' })

  assert.equal(sel.supportsReasoning, false)
})
