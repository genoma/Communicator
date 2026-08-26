import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatState } from '../src/chat-state.js'

function makeState(overrides = {}) {
  return new ChatState({
    modelId: 'org/model',
    endpointProviderName: 'Provider',
    reasoningEffort: 'high',
    temperature: 1.1,
    budget: 5,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    supportsReasoning: true,
    webSearch: 'auto',
    webResults: 3,
    webSearchSupported: true,
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelReasoning: { supported: true },
    ...overrides,
  })
}

test('constructor keeps parity with the old state literal fields', () => {
  const s = makeState()
  assert.deepEqual(
    Object.keys(s).sort(),
    ['budget', 'compactThinking', 'contextLength', 'createdAt', 'e2ee', 'e2eeContext', 'endpointProviderName', 'fileSupported', 'imageOutputSupported', 'markdown', 'messages', 'modelId', 'modelReasoning', 'pendingAttachments', 'pricing', 'reasoningEffort', 'reasoningMandatory', 'retryTurn', 'scrapes', 'sessionId', 'smoothSpeed', 'smoothStreaming', 'supportsReasoning', 'systemContent', 'temperature', 'topP', 'updatedAt', 'visionSupported', 'webResults', 'webSearch', 'webSearchSupported', 'zdr']
  )
  assert.equal(s.modelId, 'org/model')
  assert.equal(s.endpointProviderName, 'Provider')
  assert.equal(s.reasoningEffort, 'high')
  assert.equal(s.reasoningMandatory, false)
  assert.equal(s.temperature, 1.1)
  assert.equal(s.topP, undefined)
  assert.equal(s.budget, 5)
  assert.deepEqual(s.pricing, { prompt: 0.000001, completion: 0.000002 })
  assert.equal(s.supportsReasoning, true)
  assert.equal(s.webSearch, 'auto')
  assert.equal(s.webResults, 3)
  assert.equal(s.webSearchSupported, true)
  assert.equal(s.visionSupported, undefined)
  assert.equal(s.fileSupported, undefined)
  assert.deepEqual(s.pendingAttachments, [])
  assert.equal(s.sessionId, '2026-01-01T00-00-00')
  assert.equal(s.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(s.updatedAt, null)
  assert.deepEqual(s.modelReasoning, { supported: true })
  assert.equal(s.markdown, true)
  assert.equal(s.smoothStreaming, true)
  assert.equal(s.compactThinking, false)
  assert.equal(s.smoothSpeed, 2000)
  assert.deepEqual(s.messages, [{ role: 'system', content: 'You are a helpful assistant.' }])
})

test('constructor accepts vision and file capability flags', () => {
  const s = makeState({ visionSupported: true, fileSupported: false })
  assert.equal(s.visionSupported, true)
  assert.equal(s.fileSupported, false)
})

test('constructor builds default system message from systemContent', () => {
  const s = new ChatState({ modelId: 'm', systemContent: 'Custom prompt.' })
  assert.deepEqual(s.messages, [{ role: 'system', content: 'Custom prompt.' }])
})

test('constructor keeps provided messages untouched', () => {
  const messages = [{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }]
  const s = new ChatState({ modelId: 'm', messages })
  assert.equal(s.messages, messages)
})

test('toFinalState returns exactly the old finalState field list', () => {
  const s = makeState({ messages: [{ role: 'user', content: 'hi' }] })
  const state = s.toFinalState('openrouter')

  assert.deepEqual(Object.keys(state).sort(), [
    'budget',
    'contextLength',
    'createdAt',
    'e2ee',
    'endpointProviderName',
    'fileSupported',
    'imageOutputSupported',
    'messages',
    'modelId',
    'pricing',
    'providerType',
    'reasoningEffort',
    'reasoningMandatory',
    'scrapes',
    'sessionId',
    'supportsReasoning',
    'temperature',
    'topP',
    'updatedAt',
    'visionSupported',
    'webResults',
    'webSearch',
    'webSearchSupported',
  ])
  assert.equal(state.messages, s.messages)
  assert.equal(state.sessionId, '2026-01-01T00-00-00')
  assert.equal(state.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(state.updatedAt, null)
  assert.equal(state.modelId, 'org/model')
  assert.equal(state.endpointProviderName, 'Provider')
  assert.equal(state.reasoningEffort, 'high')
  assert.equal(state.temperature, 1.1)
  assert.equal(state.topP, undefined)
  assert.equal(state.budget, 5)
  assert.equal(state.webSearch, 'auto')
  assert.equal(state.webResults, 3)
  assert.deepEqual(state.pricing, { prompt: 0.000001, completion: 0.000002 })
  assert.equal(state.providerType, 'openrouter')
})

test('resetForNewSession clears messages, budget, webResults and returns the reset marker', () => {
  const s = makeState({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }] })
  s.pendingAttachments.push({ kind: 'image', filename: 'a.png', size: 1 })
  const marker = s.resetForNewSession('Fresh prompt.')

  assert.equal(marker, true)
  assert.deepEqual(s.messages, [{ role: 'system', content: 'Fresh prompt.' }])
  assert.equal(s.budget, null)
  assert.equal(s.webResults, null)
  assert.deepEqual(s.pendingAttachments, [])
  assert.equal(s.temperature, 1.1)
  assert.equal(s.webSearch, 'auto')
  assert.equal(s.sessionId, '2026-01-01T00-00-00')
})

test('transitions mutate only their own fields', () => {
  const s = makeState()
  s.setTemperature(0.5)
  s.setTopP(0.8)
  s.setBudget(2)
  s.setWebSearch(false)
  s.setWebResults(7)
  s.setReasoningEffort('low')
  s.toggleMarkdown()
  s.setSmoothStreaming(false)
  s.setSmoothSpeed('fast')

  assert.equal(s.temperature, 0.5)
  assert.equal(s.topP, 0.8)
  assert.equal(s.budget, 2)
  assert.equal(s.webSearch, 'off')
  assert.equal(s.webResults, 7)
  assert.equal(s.reasoningEffort, 'low')
  assert.equal(s.markdown, false)
  assert.equal(s.smoothStreaming, false)
  assert.equal(s.smoothSpeed, 8000)

  assert.equal(s.modelId, 'org/model')
  assert.equal(s.endpointProviderName, 'Provider')
  assert.equal(s.supportsReasoning, true)
  assert.deepEqual(s.pricing, { prompt: 0.000001, completion: 0.000002 })
  assert.equal(s.webSearchSupported, true)
  assert.deepEqual(s.messages, [{ role: 'system', content: 'You are a helpful assistant.' }])
})

test('applyModelSelection switches model and reads per-model prefs', () => {
  const s = makeState()
  const sel = {
    modelId: 'other/model',
    endpointProviderName: 'OtherProvider',
    pricing: { prompt: 0.000002, completion: 0.000003 },
    contextLength: 128000,
    reasoningEffort: 'medium',
    supportsReasoning: true,
    modelReasoning: { supported: true, supportsEffort: true },
    webSearchSupported: true,
    visionSupported: true,
    fileSupported: false,
  }
  const prefs = {
    temperature: { 'other/model': 0.3 },
    topP: { 'other/model': 0.6 },
    webSearch: { 'other/model': true },
  }
  s.applyModelSelection(sel, prefs)

  assert.equal(s.modelId, 'other/model')
  assert.equal(s.endpointProviderName, 'OtherProvider')
  assert.deepEqual(s.pricing, { prompt: 0.000002, completion: 0.000003 })
  assert.equal(s.contextLength, 128000)
  assert.equal(s.reasoningEffort, 'medium')
  assert.equal(s.supportsReasoning, true)
  assert.deepEqual(s.modelReasoning, { supported: true, supportsEffort: true })
  assert.equal(s.temperature, 0.3)
  assert.equal(s.topP, 0.6)
  assert.equal(s.webSearch, 'auto')
  assert.equal(s.webSearchSupported, true)
  assert.equal(s.visionSupported, true)
  assert.equal(s.fileSupported, false)
})

test('applyModelSelection leaves temperature unset without a pref', () => {
  const s = makeState()
  s.applyModelSelection(
    { modelId: 'm', endpointProviderName: 'P', pricing: null, reasoningEffort: null, supportsReasoning: false, modelReasoning: null, webSearchSupported: true },
    { temperature: {}, topP: {}, webSearch: { m: true } }
  )
  assert.equal(s.temperature, undefined)
  assert.equal(s.topP, undefined)
  assert.equal(s.webSearch, 'auto')
})

test('applyModelSelection reads an explicit mode string from prefs', () => {
  const s = makeState()
  s.applyModelSelection(
    { modelId: 'm', endpointProviderName: 'P', pricing: null, reasoningEffort: null, supportsReasoning: false, modelReasoning: null, webSearchSupported: true },
    { temperature: {}, webSearch: { m: 'always' } }
  )
  assert.equal(s.webSearch, 'always')
})

test('applyModelSelection gates web search off for unsupported models', () => {
  const s = makeState()
  s.applyModelSelection(
    { modelId: 'm', endpointProviderName: 'P', pricing: null, reasoningEffort: null, supportsReasoning: false, modelReasoning: null, webSearchSupported: false },
    { temperature: {}, webSearch: { m: true } }
  )
  assert.equal(s.webSearch, 'off')
})

test('constructor derives reasoningMandatory from the explicit field or the model reasoning metadata', () => {
  const explicit = makeState({ reasoningMandatory: true })
  assert.equal(explicit.reasoningMandatory, true)
  const derived = new ChatState({ modelId: 'm', modelReasoning: { mandatory: true } })
  assert.equal(derived.reasoningMandatory, true)
  const off = new ChatState({ modelId: 'm', modelReasoning: { mandatory: false } })
  assert.equal(off.reasoningMandatory, false)
})

test('applyModelSelection re-derives reasoningMandatory from the selection metadata', () => {
  const s = makeState({ reasoningMandatory: true })
  s.applyModelSelection(
    { modelId: 'm', endpointProviderName: 'P', pricing: null, reasoningEffort: null, supportsReasoning: false, modelReasoning: { mandatory: true }, webSearchSupported: true },
    { temperature: {}, webSearch: {} }
  )
  assert.equal(s.reasoningMandatory, true)
  s.applyModelSelection(
    { modelId: 'm', endpointProviderName: 'P', pricing: null, reasoningEffort: null, supportsReasoning: false, modelReasoning: null, webSearchSupported: true },
    { temperature: {}, webSearch: {} }
  )
  assert.equal(s.reasoningMandatory, false)
})

test('constructor defaults smoothSpeed to the normal preset and normalizes values', () => {
  const s = makeState()
  assert.equal(s.smoothSpeed, 2000)
  const fast = makeState({ smoothSpeed: 'fast' })
  assert.equal(fast.smoothSpeed, 8000)
  const numeric = makeState({ smoothSpeed: '1500' })
  assert.equal(numeric.smoothSpeed, 1500)
  const invalid = makeState({ smoothSpeed: 'bogus' })
  assert.equal(invalid.smoothSpeed, 2000)
})

test('setSmoothSpeed updates the speed and falls back for invalid values', () => {
  const s = makeState()
  s.setSmoothSpeed(1500)
  assert.equal(s.smoothSpeed, 1500)
  s.setSmoothSpeed('slow')
  assert.equal(s.smoothSpeed, 500)
  s.setSmoothSpeed('bogus')
  assert.equal(s.smoothSpeed, 2000)
  s.setSmoothSpeed(undefined)
  assert.equal(s.smoothSpeed, 2000)
})

test('appendUser stamps updatedAt and resetForNewSession clears it', () => {
  const s = makeState({ updatedAt: '2026-01-01T00:00:01.000Z', messages: [{ role: 'system', content: 'x' }] })
  assert.equal(s.updatedAt, '2026-01-01T00:00:01.000Z')

  s.appendUser('new question')
  assert.ok(Date.parse(s.updatedAt) > Date.parse('2026-01-01T00:00:01.000Z'))

  s.resetForNewSession()
  assert.equal(s.updatedAt, null)
})

test('appendAssistant, popLastMessage and lastAssistantMessage round-trip', () => {
  const s = makeState({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }] })
  s.appendUser('second question')
  const assistant = { role: 'assistant', content: 'answer', usage: { prompt_tokens: 1 } }
  s.appendAssistant(assistant)

  assert.equal(s.messages.length, 4)
  assert.equal(s.lastAssistantMessage, assistant)

  const popped = s.popLastMessage()
  assert.equal(popped, assistant)
  assert.equal(s.messages.length, 3)
  assert.equal(s.lastAssistantMessage, undefined)
})
