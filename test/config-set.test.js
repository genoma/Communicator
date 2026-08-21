import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfigValues } from '../src/commands/config-set.js'

test('resolveConfigValues resolves a bare web-search flag to auto and flags needsModel', () => {
  const v = resolveConfigValues({ webSearch: true })
  assert.equal(v.webSearch, 'auto')
  assert.equal(v.needsModel, true)
})

test('resolveConfigValues resolves web-search modes and flags needsModel', () => {
  assert.equal(resolveConfigValues({ webSearch: 'always' }).webSearch, 'always')
  assert.equal(resolveConfigValues({ webSearch: 'off' }).webSearch, 'off')
  assert.equal(resolveConfigValues({ webSearch: 'off' }).needsModel, true)
})

test('resolveConfigValues resolves temperature and flags needsModel', () => {
  const v = resolveConfigValues({ temperature: '0.5' })
  assert.equal(v.temperature, 0.5)
  assert.equal(v.needsModel, true)
})

test('resolveConfigValues maps reasoning-effort none to null and flags needsModel', () => {
  const v = resolveConfigValues({ reasoningEffort: 'none' })
  assert.equal(v.reasoningEffort, null)
  assert.equal(v.needsModel, true)
})

test('resolveConfigValues passes through reasoning-effort levels', () => {
  assert.equal(resolveConfigValues({ reasoningEffort: 'high' }).reasoningEffort, 'high')
})

test('resolveConfigValues resolves global setters without needsModel', () => {
  const v = resolveConfigValues({ budget: '2.5', webResults: '5', smoothSpeed: 'fast', outputDir: '/tmp/exports' })
  assert.equal(v.budget, 2.5)
  assert.equal(v.webResults, 5)
  assert.equal(v.smoothSpeed, 8000)
  assert.equal(v.outputDir, '/tmp/exports')
  assert.equal(v.needsModel, false)
})

test('resolveConfigValues maps --no-smooth-streaming to false', () => {
  const v = resolveConfigValues({ smoothStreaming: false })
  assert.equal(v.smoothStreaming, false)
  assert.equal(v.needsModel, false)
})

test('resolveConfigValues resolves per-provider image defaults without needsModel', () => {
  const v = resolveConfigValues({ aspectRatio: '16:9', imageFormat: 'png' })
  assert.equal(v.aspectRatio, '16:9')
  assert.equal(v.imageFormat, 'png')
  assert.equal(v.needsModel, false)
})

test('resolveConfigValues accepts auto aspect ratios', () => {
  assert.equal(resolveConfigValues({ aspectRatio: 'auto' }).aspectRatio, 'auto')
})

test('resolveConfigValues throws on invalid image default values', () => {
  assert.throws(() => resolveConfigValues({ aspectRatio: 'wide' }), /W:H/)
  assert.throws(() => resolveConfigValues({ imageFormat: 'gif' }), /png, jpeg, webp/)
})

test('resolveConfigValues leaves unset values undefined', () => {
  const v = resolveConfigValues({})
  assert.deepEqual(v, {
    temperature: undefined,
    topP: undefined,
    budget: undefined,
    webResults: undefined,
    smoothSpeed: undefined,
    reasoningEffort: undefined,
    webSearch: undefined,
    smoothStreaming: undefined,
    hideWatermark: undefined,
    safeMode: undefined,
    outputDir: undefined,
    aspectRatio: undefined,
    imageFormat: undefined,
    needsModel: false,
  })
})

test('resolveConfigValues throws on invalid values', () => {
  assert.throws(() => resolveConfigValues({ temperature: '3' }), /between 0 and 2/)
  assert.throws(() => resolveConfigValues({ topP: '2' }), /between 0 and 1/)
  assert.throws(() => resolveConfigValues({ budget: 'nope' }), /positive number/)
  assert.throws(() => resolveConfigValues({ webResults: '0' }), /positive integer/)
  assert.throws(() => resolveConfigValues({ smoothSpeed: 'insane' }), /Smooth speed/)
})
