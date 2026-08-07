import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCost, formatSmoothSpeed, cpsToCharsPerTick } from '../src/constants.js'

test('formatCost formats finite values and masks non-finite ones', () => {
  assert.equal(formatCost(null), 'N/A')
  assert.equal(formatCost(undefined), 'N/A')
  assert.equal(formatCost(NaN), 'N/A')
  assert.equal(formatCost(Infinity), 'N/A')
  assert.equal(formatCost(0), '$0.000000')
  assert.equal(formatCost(0.0000042), '$0.000004')
  assert.equal(formatCost(0.000123456), '$0.000123')
  assert.equal(formatCost(1.5), '$1.500000')
})

test('formatSmoothSpeed labels presets and raw cps', () => {
  assert.equal(formatSmoothSpeed(2000), 'normal, ~2000 chars/s')
  assert.equal(formatSmoothSpeed(1234), '1234 chars/s')
})

test('cpsToCharsPerTick floors to at least one char per tick', () => {
  assert.equal(cpsToCharsPerTick(2000), 40)
  assert.equal(cpsToCharsPerTick(10), 1)
  assert.equal(cpsToCharsPerTick(1), 1)
})
