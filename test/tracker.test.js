// assertions intentionally match ANSI-rendered output
/* eslint-disable no-control-regex, no-regex-spaces */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UsageTracker, budgetLine, budgetStatus, computeTurnCost } from '../src/tracker.js'
import { green, cyan } from '../src/ui/style.js'

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

test('budgetStatus computes pct and remaining with 80/100 boundaries', () => {
  const low = budgetStatus(0.4, 1)
  assert.ok(Math.abs(low.pct - 40) < 1e-9)
  assert.ok(Math.abs(low.remaining - 0.6) < 1e-9)

  const eighty = budgetStatus(0.8, 1)
  assert.ok(Math.abs(eighty.pct - 80) < 1e-9)
  assert.ok(Math.abs(eighty.remaining - 0.2) < 1e-9)

  const at = budgetStatus(1, 1)
  assert.equal(at.pct, 100)
  assert.equal(at.remaining, 0)

  const over = budgetStatus(2, 1)
  assert.equal(over.pct, 100)
  assert.equal(over.remaining, 0)
})

test('budgetStatus returns null for unset or invalid budgets', () => {
  assert.equal(budgetStatus(0, null), null)
  assert.equal(budgetStatus(0, undefined), null)
  assert.equal(budgetStatus(0, 0), null)
  assert.equal(budgetStatus(0, -1), null)
})

test('budgetLine warns at 80% and omits below', () => {
  assert.equal(budgetLine(0.5, 1), null)
  assert.match(budgetLine(0.9, 1), /90% used/)
  assert.match(budgetLine(0.9, 1), /\$0\.9000 of \$1\.0000/)
  assert.match(budgetLine(0.9, 1), /█████████░/)
  assert.match(budgetLine(1.2, 1), /100% used/)
  assert.match(budgetLine(1.2, 1), /██████████/)
  assert.equal(budgetLine(0.5, null), null)
})

test('budgetLine formats small budgets with four decimals', () => {
  const line = budgetLine(0.0005, 0.0006)
  assert.match(line, /\$0\.0005 of \$0\.0006/)
  assert.match(line, /\$0\.0001 remaining/)
})

test('printTurn aligns labels and shows cache hits with ratio', (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })

  const tracker = new UsageTracker()
  tracker.record(
    { prompt_tokens: 200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 } },
    PRICING
  )
  tracker.printTurn(
    { prompt_tokens: 200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 } },
    PRICING
  )

  const plain = logs.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(plain, /^  Tokens ↑ 200 prompt  ↓ 50 completion  = 250 total$/m)
  assert.match(plain, /^  Cache  ⚡ 100 cached tokens \(50% of prompt\)$/m)
  assert.match(plain, /^  Cost   \$0\.000600 this turn  \|  \$0\.000600 session$/m)
  const greenCache = logs.find((l) => l.includes('⚡'))
  assert.equal(greenCache, green('  Cache  ⚡ 100 cached tokens (50% of prompt)'))
  const costLine = logs.find((l) => l.includes('Cost'))
  assert.equal(costLine, cyan('  Cost   $0.000600 this turn  |  $0.000600 session'))
})

test('printTurn omits the cache line on a miss', (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })

  new UsageTracker().printTurn({ prompt_tokens: 200, completion_tokens: 50 }, PRICING)

  const plain = logs.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
  assert.doesNotMatch(plain, /Cache/)
  assert.match(plain, /^  Tokens ↑ 200 prompt  ↓ 50 completion  = 250 total$/m)
})
