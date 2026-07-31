import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTemperatureFlag, validateTemperature } from '../src/prompts.js'

test('resolveTemperatureFlag parses string and number values', () => {
  assert.equal(resolveTemperatureFlag({ temperature: '0.5' }), 0.5)
  assert.equal(resolveTemperatureFlag({ temperature: '2' }), 2)
  assert.equal(resolveTemperatureFlag({ temperature: 0 }), 0)
  assert.equal(resolveTemperatureFlag({ temperature: '0' }), 0)
})

test('resolveTemperatureFlag returns undefined when unset', () => {
  assert.equal(resolveTemperatureFlag({}), undefined)
  assert.equal(resolveTemperatureFlag(), undefined)
  assert.equal(resolveTemperatureFlag({ temperature: undefined }), undefined)
  assert.equal(resolveTemperatureFlag({ temperature: null }), undefined)
  assert.equal(resolveTemperatureFlag({ temperature: '' }), undefined)
})

test('resolveTemperatureFlag rejects out-of-range and non-finite values', () => {
  assert.throws(() => resolveTemperatureFlag({ temperature: '2.5' }), /between 0 and 2/)
  assert.throws(() => resolveTemperatureFlag({ temperature: '-0.1' }), /between 0 and 2/)
  assert.throws(() => resolveTemperatureFlag({ temperature: 'abc' }), /between 0 and 2/)
  assert.throws(() => resolveTemperatureFlag({ temperature: NaN }), /between 0 and 2/)
  assert.throws(() => resolveTemperatureFlag({ temperature: Infinity }), /between 0 and 2/)
})

test('validateTemperature accepts finite values within bounds', () => {
  assert.equal(validateTemperature(0.7), true)
  assert.equal(validateTemperature(0), true)
  assert.equal(validateTemperature(2), true)
  assert.equal(validateTemperature(2.1), false)
  assert.equal(validateTemperature(-0.1), false)
  assert.equal(validateTemperature(NaN), false)
  assert.equal(validateTemperature(Infinity), false)
  assert.equal(validateTemperature('0.7'), false)
})
