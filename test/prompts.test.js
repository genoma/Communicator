// assertions intentionally match ANSI-rendered output
/* eslint-disable no-control-regex */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let selectMessages = []
let selectChoices = []
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async () => undefined,
    select: async (opts) => {
      selectMessages.push(opts?.message)
      selectChoices.push(opts?.choices)
      return opts?.default
    },
  },
})

const { pickerTheme, BACK_SENTINEL, getEffortLabel, orderModelChoices, filterModelChoices, formatEndpointLabel, formatEndpointDescription, selectReasoningEffort } = await import('../src/prompts.js')

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

test('orderModelChoices tags vision-capable models', () => {
  const ordered = orderModelChoices([
    { id: 'eye', name: 'Eye', visionSupported: true },
    { id: 'ear', name: 'Ear', visionSupported: false },
    { id: 'plain', name: 'Plain' },
  ])
  assert.equal(ordered[0].name, 'Eye  (eye)  [vision]')
  assert.equal(ordered[1].name, 'Ear  (ear)')
  assert.equal(ordered[2].name, 'Plain  (plain)')
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

const EFFORT_REASONING = { supported: true, supportsEffort: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' }

test('selectReasoningEffort offers no back choice by default', async () => {
  selectMessages = []
  selectChoices = []
  const answer = await selectReasoningEffort(EFFORT_REASONING, undefined)
  assert.equal(answer, 'medium')
  assert.deepEqual(selectMessages, ['Select reasoning effort:'])
  assert.equal(selectChoices[0][0].name, 'Disabled')
  assert.equal(selectChoices[0][0].value, null)
  assert.ok(!selectChoices[0].some((c) => c.value === BACK_SENTINEL))
})

test('selectReasoningEffort puts the back choice first when withBack is set', async () => {
  selectMessages = []
  selectChoices = []
  const answer = await selectReasoningEffort(EFFORT_REASONING, undefined, { withBack: true })
  assert.equal(answer, 'medium')
  assert.equal(selectChoices[0][0].name, '← Back to model selection')
  assert.equal(selectChoices[0][0].value, BACK_SENTINEL)
  assert.equal(selectChoices[0][1].type, 'separator')
  assert.equal(selectChoices[0][2].name, 'Disabled')
})
