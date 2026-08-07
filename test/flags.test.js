import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTemperatureFlag, resolveWebResultsFlag, resolveWebSearchFlag, normalizeWebSearchMode, webSearchGate, resolveBudget, resolveSmoothSpeed, normalizeSmoothSpeed, resolvePrefOrNull } from '../src/flags.js'

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

test('webSearchGate blocks auto/always on unsupported models', () => {
  assert.equal(webSearchGate('auto', false), 'The selected model does not support web search.')
  assert.equal(webSearchGate('always', false), 'The selected model does not support web search.')
})

test('webSearchGate allows off, supported models, and unknown support', () => {
  assert.equal(webSearchGate('off', false), null)
  assert.equal(webSearchGate('auto', true), null)
  assert.equal(webSearchGate('auto', undefined), null)
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
  assert.throws(() => resolveWebResultsFlag({ webResults: '101' }), /at most 100/)
  assert.equal(resolveWebResultsFlag({ webResults: '100' }), 100)
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

test('resolveWebSearchFlag: --web-results implies auto unless an explicit mode is given', () => {
  assert.equal(resolveWebSearchFlag({ webResults: 5, prefValue: false }), 'auto')
  assert.equal(resolveWebSearchFlag({ webSearch: 'off', webResults: 3, prefValue: false }), 'off')
  assert.equal(resolveWebSearchFlag({ webSearch: 'always', webResults: 5, prefValue: 'off' }), 'always')
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

test('resolveSmoothSpeed maps presets to chars per second', () => {
  assert.equal(resolveSmoothSpeed('slow'), 500)
  assert.equal(resolveSmoothSpeed('normal'), 2000)
  assert.equal(resolveSmoothSpeed('fast'), 8000)
})

test('resolveSmoothSpeed parses numeric chars per second', () => {
  assert.equal(resolveSmoothSpeed('1500'), 1500)
  assert.equal(resolveSmoothSpeed(1500), 1500)
  assert.equal(resolveSmoothSpeed('0.5'), 0.5)
})

test('resolveSmoothSpeed returns undefined when unset', () => {
  assert.equal(resolveSmoothSpeed(undefined), undefined)
  assert.equal(resolveSmoothSpeed(null), undefined)
  assert.equal(resolveSmoothSpeed(''), undefined)
})

test('resolveSmoothSpeed rejects invalid values', () => {
  assert.throws(() => resolveSmoothSpeed('bogus'), /slow.*normal.*fast/)
  assert.throws(() => resolveSmoothSpeed('0'), /positive number of chars per second/)
  assert.throws(() => resolveSmoothSpeed('-5'), /positive number of chars per second/)
  assert.throws(() => resolveSmoothSpeed(NaN), /positive number of chars per second/)
  assert.throws(() => resolveSmoothSpeed(Infinity), /positive number of chars per second/)
})

test('normalizeSmoothSpeed falls back to the normal preset', () => {
  assert.equal(normalizeSmoothSpeed(undefined), 2000)
  assert.equal(normalizeSmoothSpeed('fast'), 8000)
  assert.equal(normalizeSmoothSpeed('1500'), 1500)
  assert.equal(normalizeSmoothSpeed('bogus'), 2000)
  assert.equal(normalizeSmoothSpeed(0), 2000)
})

test('resolvePrefOrNull returns valid values and null for invalid ones', () => {
  assert.equal(resolvePrefOrNull(resolveBudget, 2.5), 2.5)
  assert.equal(resolvePrefOrNull(resolveBudget, 'abc'), null)
  assert.equal(resolvePrefOrNull(resolveBudget, 0), null)
  assert.equal(resolvePrefOrNull(resolveBudget, -1), null)
  assert.equal(resolvePrefOrNull((v) => resolveWebResultsFlag({ webResults: v }), 0), null)
  assert.equal(resolvePrefOrNull((v) => resolveWebResultsFlag({ webResults: v }), 5), 5)
})
