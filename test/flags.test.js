import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTemperatureFlag, resolveWebResultsFlag, resolveWebSearchFlag, normalizeWebSearchMode, validateTemperature, resolveBudget } from '../src/flags.js'

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

test('normalizeWebSearchMode maps legacy on/true to auto', () => {
  assert.equal(normalizeWebSearchMode(true), 'auto')
  assert.equal(normalizeWebSearchMode('on'), 'auto')
})

test('normalizeWebSearchMode passes the three explicit modes through', () => {
  assert.equal(normalizeWebSearchMode('auto'), 'auto')
  assert.equal(normalizeWebSearchMode('always'), 'always')
  assert.equal(normalizeWebSearchMode('off'), 'off')
})

test('normalizeWebSearchMode falls back to off for missing and unknown values', () => {
  assert.equal(normalizeWebSearchMode(undefined), 'off')
  assert.equal(normalizeWebSearchMode(null), 'off')
  assert.equal(normalizeWebSearchMode(false), 'off')
  assert.equal(normalizeWebSearchMode(''), 'off')
  assert.equal(normalizeWebSearchMode('bogus'), 'off')
})

test('resolveWebSearchFlag: CLI flag wins over the saved pref', () => {
  assert.equal(resolveWebSearchFlag({ webSearch: true, prefValue: false }), 'auto')
  assert.equal(resolveWebSearchFlag({ webSearch: true, prefValue: 'always' }), 'auto')
  assert.equal(resolveWebSearchFlag({ webSearch: 'always', prefValue: 'off' }), 'always')
  assert.equal(resolveWebSearchFlag({ webSearch: 'off', prefValue: 'always' }), 'off')
})

test('resolveWebSearchFlag: --web-results implies auto regardless of pref', () => {
  assert.equal(resolveWebSearchFlag({ webResults: 5, prefValue: false }), 'auto')
  assert.equal(resolveWebSearchFlag({ webSearch: 'off', webResults: 3, prefValue: false }), 'auto')
})

test('resolveWebSearchFlag: pref wins over the default off when no flag is passed', () => {
  assert.equal(resolveWebSearchFlag({ webSearch: undefined, prefValue: true }), 'auto')
  assert.equal(resolveWebSearchFlag({ webSearch: undefined, prefValue: 'always' }), 'always')
  assert.equal(resolveWebSearchFlag({ webSearch: undefined, prefValue: false }), 'off')
  assert.equal(resolveWebSearchFlag({ webSearch: undefined, prefValue: undefined }), 'off')
  assert.equal(resolveWebSearchFlag({}), 'off')
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
