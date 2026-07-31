import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UsageTracker, computeTurnCost } from '../src/tracker.js'

const PRICING = { prompt: 0.0000015, completion: 0.000006 }

test('computeTurnCost uses per-token prices and handles string pricing', () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 500 }
  assert.equal(computeTurnCost(usage, PRICING), 1000 * 0.0000015 + 500 * 0.000006)
  assert.equal(computeTurnCost(usage, { prompt: '0.0000015', completion: '0.000006' }), 1000 * 0.0000015 + 500 * 0.000006)
  assert.equal(computeTurnCost(usage, { prompt: null, completion: null }), 0)
  assert.equal(computeTurnCost(null, PRICING), 0)
})

test('record accumulates tokens, cost, and request count', () => {
  const tracker = new UsageTracker()
  tracker.record({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, PRICING)
  tracker.record({ prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }, PRICING)

  assert.equal(tracker.promptTokens, 300)
  assert.equal(tracker.completionTokens, 150)
  assert.equal(tracker.totalTokens, 450)
  assert.equal(tracker.requests, 2)
  assert.equal(tracker.cost, 100 * 0.0000015 + 50 * 0.000006 + 200 * 0.0000015 + 100 * 0.000006)
  assert.equal(tracker.cacheHits, 0)
  assert.equal(tracker.cachedTokens, 0)
})

test('detects cache hits via cacheHit flag and cached tokens', () => {
  const tracker = new UsageTracker()
  tracker.record({ prompt_tokens: 0, completion_tokens: 10, cacheHit: true }, PRICING)
  tracker.record({ prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30 } }, PRICING)

  assert.equal(tracker.cacheHits, 2)
  assert.equal(tracker.cachedTokens, 30)
})

test('summary includes cost only when pricing produced a cost', () => {
  const tracker = new UsageTracker()
  tracker.record({ prompt_tokens: 100, completion_tokens: 50 }, PRICING)
  const s = tracker.summary()
  assert.match(s, /100 prompt/)
  assert.match(s, /50 completion/)
  assert.match(s, /150 total/)
  assert.match(s, /1 request\(s\)/)
  assert.match(s, /\$0\.000450 cost/)

  const noPricing = new UsageTracker()
  noPricing.record({ prompt_tokens: 10, completion_tokens: 5 })
  assert.doesNotMatch(noPricing.summary(), /cost/)
})
