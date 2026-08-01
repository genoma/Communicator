import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTemperatureFlag, resolveWebResultsFlag, resolveWebSearchFlag, validateTemperature, resolveBudget } from '../src/flags.js'

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

test('resolveWebResultsFlag parses positive integer values', () => {
  assert.equal(resolveWebResultsFlag({ webResults: '5' }), 5)
  assert.equal(resolveWebResultsFlag({ webResults: 3 }), 3)
  assert.equal(resolveWebResultsFlag({ webResults: '10' }), 10)
})

test('resolveWebResultsFlag returns undefined when unset', () => {
  assert.equal(resolveWebResultsFlag({}), undefined)
  assert.equal(resolveWebResultsFlag(), undefined)
  assert.equal(resolveWebResultsFlag({ webResults: undefined }), undefined)
  assert.equal(resolveWebResultsFlag({ webResults: null }), undefined)
  assert.equal(resolveWebResultsFlag({ webResults: '' }), undefined)
})

test('resolveWebResultsFlag rejects non-positive and non-integer values', () => {
  assert.throws(() => resolveWebResultsFlag({ webResults: '0' }), /positive integer/)
  assert.throws(() => resolveWebResultsFlag({ webResults: '-1' }), /positive integer/)
  assert.throws(() => resolveWebResultsFlag({ webResults: '2.5' }), /positive integer/)
  assert.throws(() => resolveWebResultsFlag({ webResults: 'abc' }), /positive integer/)
  assert.throws(() => resolveWebResultsFlag({ webResults: NaN }), /positive integer/)
  assert.throws(() => resolveWebResultsFlag({ webResults: Infinity }), /positive integer/)
})

test('resolveWebSearchFlag: CLI flag wins over the saved pref', () => {
  assert.equal(resolveWebSearchFlag({ webSearch: true, prefValue: false }), true)
  assert.equal(resolveWebSearchFlag({ webSearch: true, prefValue: true }), true)
})

test('resolveWebSearchFlag: --web-results implies web search on regardless of pref', () => {
  assert.equal(resolveWebSearchFlag({ webResults: 5, prefValue: false }), true)
  assert.equal(resolveWebSearchFlag({ webSearch: false, webResults: 3, prefValue: false }), true)
})

test('resolveWebSearchFlag: pref wins over the default off when no flag is passed', () => {
  assert.equal(resolveWebSearchFlag({ webSearch: undefined, prefValue: true }), true)
  assert.equal(resolveWebSearchFlag({ webSearch: undefined, prefValue: false }), false)
  assert.equal(resolveWebSearchFlag({ webSearch: undefined, prefValue: undefined }), false)
  assert.equal(resolveWebSearchFlag({}), false)
})

test('resolveBudget returns null for empty values', () => {
  assert.equal(resolveBudget(undefined), null)
  assert.equal(resolveBudget(null), null)
  assert.equal(resolveBudget(''), null)
})

test('resolveBudget parses valid decimals', () => {
  assert.equal(resolveBudget('5'), 5)
  assert.equal(resolveBudget('0.5'), 0.5)
  assert.equal(resolveBudget('2.75'), 2.75)
  assert.equal(resolveBudget(1), 1)
})

test('resolveBudget throws for non-positive and non-finite values', () => {
  assert.throws(() => resolveBudget('0'), /positive number \(USD\)/)
  assert.throws(() => resolveBudget('-1'), /positive number \(USD\)/)
  assert.throws(() => resolveBudget('abc'), /positive number \(USD\)/)
  assert.throws(() => resolveBudget(NaN), /positive number \(USD\)/)
  assert.throws(() => resolveBudget(Infinity), /positive number \(USD\)/)
})
