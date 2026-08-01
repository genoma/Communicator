import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffortDefault, isWebSearchSupported } from '../src/reasoning.js'

test('resolveEffortDefault: forced effort wins over prefs and model defaults', () => {
  const reasoning = { supported: true, supportsEffort: true, default_effort: 'medium' }
  assert.equal(
    resolveEffortDefault({ reasoning, forcedEffort: 'high', prefs: { reasoningEffort: { m: 'low' } }, modelId: 'm' }),
    'high'
  )
})

test('resolveEffortDefault: forced none normalizes to null', () => {
  const reasoning = { supported: true, supportsEffort: true, default_effort: 'medium' }
  assert.equal(resolveEffortDefault({ reasoning, forcedEffort: 'none', prefs: {}, modelId: 'm' }), null)
})

test('resolveEffortDefault: models without effort control stay undefined (auto)', () => {
  const reasoning = { supported: true, supportsEffort: false }
  assert.equal(resolveEffortDefault({ reasoning, forcedEffort: undefined, prefs: {}, modelId: 'm' }), undefined)
  assert.equal(resolveEffortDefault({ reasoning, forcedEffort: 'high', prefs: {}, modelId: 'm' }), 'high')
})

test('resolveEffortDefault: saved pref beats default_enabled false and default effort', () => {
  const reasoning = { supported: true, supportsEffort: true, default_enabled: false, default_effort: 'high' }
  assert.equal(
    resolveEffortDefault({ reasoning, forcedEffort: undefined, prefs: { reasoningEffort: { m: 'low' } }, modelId: 'm' }),
    'low'
  )
})

test('resolveEffortDefault: default_enabled false resolves to null', () => {
  const reasoning = { supported: true, supportsEffort: true, default_enabled: false, default_effort: 'high' }
  assert.equal(resolveEffortDefault({ reasoning, forcedEffort: undefined, prefs: {}, modelId: 'm' }), null)
})

test('resolveEffortDefault: falls back to the model default effort', () => {
  const reasoning = { supported: true, supportsEffort: true, default_effort: 'low' }
  assert.equal(resolveEffortDefault({ reasoning, forcedEffort: undefined, prefs: {}, modelId: 'm' }), 'low')
})

test('resolveEffortDefault: saved pref none normalizes to null', () => {
  const reasoning = { supported: true, supportsEffort: true, default_effort: 'medium' }
  assert.equal(
    resolveEffortDefault({ reasoning, forcedEffort: undefined, prefs: { reasoningEffort: { m: 'none' } }, modelId: 'm' }),
    null
  )
})

test('resolveEffortDefault: no reasoning metadata yields undefined', () => {
  assert.equal(resolveEffortDefault({ reasoning: null, forcedEffort: undefined, prefs: {}, modelId: 'm' }), undefined)
  assert.equal(resolveEffortDefault({ reasoning: undefined, forcedEffort: undefined, prefs: {}, modelId: 'm' }), undefined)
})

test('resolveEffortDefault: model without default effort yields undefined', () => {
  const reasoning = { supported: true, supportsEffort: true }
  assert.equal(resolveEffortDefault({ reasoning, forcedEffort: undefined, prefs: {}, modelId: 'm' }), undefined)
})

test('isWebSearchSupported: provider meta flag applies to all models', () => {
  assert.equal(isWebSearchSupported({ supportsWebSearchOnAll: true }, {}), true)
  assert.equal(isWebSearchSupported({ supportsWebSearchOnAll: true }, { capabilities: { supportsWebSearch: false } }), true)
})

test('isWebSearchSupported: model capabilities flag enables support', () => {
  assert.equal(isWebSearchSupported({}, { capabilities: { supportsWebSearch: true } }), true)
  assert.equal(isWebSearchSupported({ supportsWebSearchOnAll: false }, { capabilities: { supportsWebSearch: true } }), true)
})

test('isWebSearchSupported: both false or undefined yields false', () => {
  assert.equal(isWebSearchSupported({}, {}), false)
  assert.equal(isWebSearchSupported({}, { capabilities: { supportsWebSearch: false } }), false)
  assert.equal(isWebSearchSupported(undefined, undefined), false)
  assert.equal(isWebSearchSupported(null, null), false)
})
