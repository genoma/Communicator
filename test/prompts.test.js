import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickerTheme, BACK_SENTINEL, getEffortLabel } from '../src/prompts.js'

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
