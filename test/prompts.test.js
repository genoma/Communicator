import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickerTheme, BACK_SENTINEL, getEffortLabel, orderModelChoices, filterModelChoices, formatEndpointLabel, formatEndpointDescription } from '../src/prompts.js'

test('pickerTheme does not reuse the chat ❯ prefix', () => {
  assert.equal(pickerTheme.prefix, undefined)
})

test('pickerTheme help tip spaces the navigation arrows', () => {
  const tip = pickerTheme.style.keysHelpTip([
    ['↑↓', 'navigate'],
    ['⏎', 'select'],
  ])
  const plain = tip.replace(/\x1b\[[0-9;]*m/g, '')
  assert.equal(plain, '↑ ↓ navigate • ⏎ select')
})

test('BACK_SENTINEL and effort labels stay stable', () => {
  assert.equal(typeof BACK_SENTINEL, 'symbol')
  assert.equal(getEffortLabel('high'), 'High')
  assert.equal(getEffortLabel(null), 'Disabled')
})

const MODELS = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'last-model', name: 'Last Model' },
  { id: 'gamma', name: 'Gamma' },
]

test('orderModelChoices moves the last-used model first', () => {
  const ordered = orderModelChoices(MODELS, 'last-model')
  assert.deepEqual(ordered.map((c) => c.value.id), ['last-model', 'alpha', 'gamma'])
})

test('orderModelChoices keeps every model when a last model is set', () => {
  const ordered = orderModelChoices(MODELS, 'last-model')
  assert.deepEqual(new Set(ordered.map((c) => c.value.id)), new Set(MODELS.map((m) => m.id)))
})

test('orderModelChoices falls back to the original order when the last model is missing', () => {
  const ordered = orderModelChoices(MODELS, 'gone')
  assert.deepEqual(ordered.map((c) => c.value.id), ['alpha', 'last-model', 'gamma'])
})

test('filterModelChoices finds the last-used model after ordering', () => {
  const ordered = orderModelChoices(MODELS, 'last-model')
  assert.deepEqual(filterModelChoices(ordered, 'last').map((c) => c.value.id), ['last-model'])
})

test('filterModelChoices matches by name and id case-insensitively', () => {
  const ordered = orderModelChoices(MODELS)
  assert.deepEqual(filterModelChoices(ordered, 'ALPHA').map((c) => c.value.id), ['alpha'])
  assert.deepEqual(filterModelChoices(ordered, 'gamma').map((c) => c.value.id), ['gamma'])
  assert.deepEqual(filterModelChoices(ordered, 'zzz'), [])
})

const ENDPOINT = {
  providerName: 'Provider',
  uptime30m: 99.5,
  pricing: { prompt: 0.0000015, completion: 0.000006 },
}

test('formatEndpointLabel shows the zero-retention marker when zdr is set', () => {
  assert.equal(formatEndpointLabel(ENDPOINT), 'Provider  —  in $1.50 / out $6.00/M  100% uptime')
  assert.equal(
    formatEndpointLabel({ ...ENDPOINT, zdr: true }),
    'Provider  —  in $1.50 / out $6.00/M  100% uptime  [zero retention]'
  )
})

test('formatEndpointDescription shows the tag and a privacy-policy hyperlink when available', () => {
  assert.equal(formatEndpointDescription({ ...ENDPOINT, tag: 'novita/bf16' }), 'tag: novita/bf16')
  assert.equal(
    formatEndpointDescription({ ...ENDPOINT, tag: 'novita/bf16', privacyPolicyURL: 'https://example.com/privacy' }),
    'tag: novita/bf16 · \x1b]8;;https://example.com/privacy\x1b\\privacy policy\x1b]8;;\x1b\\'
  )
  assert.equal(formatEndpointDescription({ ...ENDPOINT, privacyPolicyURL: 'https://example.com/privacy' }),
    '\x1b]8;;https://example.com/privacy\x1b\\privacy policy\x1b]8;;\x1b\\')
  assert.equal(formatEndpointDescription(ENDPOINT), undefined)
})
