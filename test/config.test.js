import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPreferenceUpdates } from '../src/config.js'

test('applyPreferenceUpdates merges per-model maps by spread', () => {
  const prefs = {
    reasoningEffort: { 'model-a': 'high' },
    temperature: { 'model-a': 1.1 },
    webSearch: { 'model-a': true },
  }
  const updated = applyPreferenceUpdates(prefs, {
    modelId: 'model-a',
    reasoningEffort: 'low',
    temperature: 0.5,
    webSearch: false,
  })

  assert.deepEqual(updated.reasoningEffort, { 'model-a': 'low' })
  assert.deepEqual(updated.temperature, { 'model-a': 0.5 })
  assert.deepEqual(updated.webSearch, { 'model-a': false })
})

test('applyPreferenceUpdates keeps other per-model entries untouched', () => {
  const prefs = {
    temperature: { 'model-a': 1.1, 'model-b': 0.2 },
  }
  const updated = applyPreferenceUpdates(prefs, { modelId: 'model-b', temperature: 1.5 })

  assert.deepEqual(updated.temperature, { 'model-a': 1.1, 'model-b': 1.5 })
})

test('applyPreferenceUpdates sets lastModel and lastProvider', () => {
  const updated = applyPreferenceUpdates({}, {
    modelId: 'm',
    lastModel: 'm',
    lastProvider: 'openrouter',
  })

  assert.equal(updated.lastModel, 'm')
  assert.equal(updated.lastProvider, 'openrouter')
})

test('applyPreferenceUpdates skips undefined fields', () => {
  const updated = applyPreferenceUpdates(
    { temperature: { m: 0.5 } },
    { modelId: 'm', lastModel: 'm', reasoningEffort: undefined, temperature: undefined, webSearch: undefined }
  )

  assert.deepEqual(Object.keys(updated).sort(), ['lastModel', 'temperature'])
  assert.deepEqual(updated.temperature, { m: 0.5 })
})

test('applyPreferenceUpdates preserves unrelated prefs keys', () => {
  const prefs = { theme: 'dark', lastModel: 'old', custom: { a: 1 } }
  const updated = applyPreferenceUpdates(prefs, { modelId: 'm', lastModel: 'new' })

  assert.equal(updated.theme, 'dark')
  assert.deepEqual(updated.custom, { a: 1 })
  assert.equal(updated.lastModel, 'new')
})

test('applyPreferenceUpdates returns a shallow copy for empty changes', () => {
  const prefs = { theme: 'dark', temperature: { m: 0.5 } }
  const updated = applyPreferenceUpdates(prefs, {})

  assert.notEqual(updated, prefs)
  assert.deepEqual(updated, prefs)
})

test('applyPreferenceUpdates does not mutate the input prefs', () => {
  const prefs = { temperature: { m: 0.5 } }
  applyPreferenceUpdates(prefs, { modelId: 'm', temperature: 1.0 })
  assert.deepEqual(prefs.temperature, { m: 0.5 })
})

test('applyPreferenceUpdates merges the global smoothStreaming key', () => {
  const prefs = { lastModel: 'm' }
  const updated = applyPreferenceUpdates(prefs, { modelId: 'm', smoothStreaming: false })

  assert.equal(updated.smoothStreaming, false)
  assert.equal(prefs.smoothStreaming, undefined)
})

test('applyPreferenceUpdates skips undefined smoothStreaming', () => {
  const updated = applyPreferenceUpdates({ lastModel: 'm' }, { modelId: 'm', smoothStreaming: undefined })

  assert.deepEqual(Object.keys(updated).sort(), ['lastModel'])
})

test('applyPreferenceUpdates merges the global smoothSpeed key', () => {
  const prefs = { lastModel: 'm' }
  const updated = applyPreferenceUpdates(prefs, { modelId: 'm', smoothSpeed: 'fast' })

  assert.equal(updated.smoothSpeed, 'fast')
  assert.equal(prefs.smoothSpeed, undefined)
})

test('applyPreferenceUpdates skips undefined smoothSpeed', () => {
  const updated = applyPreferenceUpdates({ lastModel: 'm' }, { modelId: 'm', smoothSpeed: undefined })

  assert.deepEqual(Object.keys(updated).sort(), ['lastModel'])
})
