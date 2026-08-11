import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, formatError } from '../src/errors.js'
import { resolveReasoningFlag } from '../src/flags.js'
import { formatModelPrice, formatPricePerM } from '../src/ui/format.js'
import { normalizePricing as normalizeVenice } from '../src/providers/venice.js'

test('ApiError carries status, provider, and retryable', () => {
  const err = new ApiError('boom', { status: 429, provider: 'openrouter', retryable: true })
  assert.equal(err.message, 'boom')
  assert.equal(err.status, 429)
  assert.equal(err.provider, 'openrouter')
  assert.equal(err.retryable, true)
  assert.equal(err.name, 'ApiError')
  assert.ok(err instanceof Error)
})

test('formatError returns ApiError message and falls back gracefully', () => {
  assert.equal(formatError(new ApiError('rate limited', {})), 'rate limited')
  assert.equal(formatError(new Error('plain')), 'plain')
  assert.equal(formatError('string error'), 'string error')
})

test('resolveReasoningFlag normalizes effort semantics', () => {
  assert.equal(resolveReasoningFlag({ reasoningEffort: 'none' }), null)
  assert.equal(resolveReasoningFlag({ reasoningEffort: 'high' }), 'high')
  assert.equal(resolveReasoningFlag({ reasoningEffort: 'max' }), 'max')
  assert.equal(resolveReasoningFlag({ reasoningEffort: undefined }), undefined)
  assert.equal(resolveReasoningFlag({ reasoningEffort: null }), undefined)
  assert.equal(resolveReasoningFlag({ reasoningEffort: '' }), undefined)
})

test('resolveReasoningFlag rejects unknown levels', () => {
  assert.throws(() => resolveReasoningFlag({ reasoningEffort: 'bogus' }), /must be one of: max, xhigh, high, medium, low, minimal, none/)
  assert.throws(() => resolveReasoningFlag({ reasoningEffort: 'auto' }), /must be one of/)
})

test('formatModelPrice renders per-1M prices with fallbacks', () => {
  assert.equal(formatModelPrice(0.0000025, 0.00001), 'in $2.50 / out $10.00/M')
  assert.equal(formatModelPrice(0.0000025, null), 'in $2.50 / out ?/M')
  assert.equal(formatModelPrice(null, null), '?')
  assert.equal(formatModelPrice('0.0000025', '0.00001'), 'in $2.50 / out $10.00/M')
})

test('formatPricePerM renders per-1M prices with fallbacks', () => {
  assert.equal(formatPricePerM({ prompt: 0.0000027, completion: 0.00000805 }), 'in $2.70 / out $8.05 per 1M')
  assert.equal(formatPricePerM({ prompt: null, completion: null }), '?')
  assert.equal(formatPricePerM(null), '?')
})

test('venice normalizePricing converts per-1M to per-token', () => {
  assert.equal(normalizeVenice({ input: { usd: 2.7 }, output: { usd: 8.05 } }).prompt, 0.0000027)
  assert.equal(normalizeVenice({ input: { usd: 2.7 }, output: { usd: 8.05 } }).completion, 8.05 / 1_000_000)
  assert.deepEqual(normalizeVenice({}), { prompt: null, completion: null })
  assert.deepEqual(normalizeVenice(null), { prompt: null, completion: null })
})
