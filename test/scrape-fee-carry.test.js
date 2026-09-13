import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatCommands } from '../src/commands/chat/index.js'
import { ChatState } from '../src/chat-state.js'
import { UsageTracker, trackerCostSummary } from '../src/tracker.js'
import { SCRAPE_COST_USD } from '../src/constants.js'

const PRICING = { prompt: 0.000001, completion: 0.000002 }
const TURN_ONE = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
const TURN_TWO = { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 }
const TURN_ONE_COST = 100 * PRICING.prompt + 50 * PRICING.completion

function veniceProvider(scraped) {
  return {
    meta: { name: 'venice' },
    async fetchModels() {
      return []
    },
    async fetchEndpoints() {
      return []
    },
    async scrapePage({ url }) {
      scraped.push(url)
      return { url, content: `# ${url}\n\nPage body for ${url}`, format: 'markdown' }
    },
  }
}

function makeCtx() {
  const state = new ChatState({
    modelId: 'org/model',
    endpointProviderName: 'Provider',
    reasoningEffort: 'high',
    temperature: 0.7,
    budget: null,
    pricing: PRICING,
    supportsReasoning: true,
    webSearch: false,
    webResults: null,
    webSearchSupported: true,
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelReasoning: null,
  })
  const tracker = new UsageTracker()
  const scraped = []
  const persisted = []
  const ctx = {
    state,
    tracker,
    provider: veniceProvider(scraped),
    apiKey: 'test-key',
    prefs: {},
    systemContent: 'You are a helpful assistant.',
    // Mirror chat.js saveCurrentSession: stamp the persisted cost summary from
    // the live tracker so the saved summary can be asserted, not just the
    // in-memory tracker.
    saveSession: async () => {
      state.costSummary = trackerCostSummary(tracker)
      persisted.push(state.costSummary)
    },
    savePrefs: async () => {},
    runTurn: async () => {},
    render: { markdown: true, smooth: true, smoothCharsPerTick: 40 },
    newSessionId: async () => '2026-01-02T00-00-00',
    copyText: async () => ({ ok: true }),
    onResizeRepaint: null,
    selectModelAndEndpoint: undefined,
    selectReasoningEffort: undefined,
  }
  return { ctx, scraped, persisted }
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
}

// /cost prints the tracker summary beside a dimmed label; return the summary
// row itself instead of pinning a call index that earlier notices can shift.
async function printedSummary(ctx) {
  await chatCommands['/cost'](ctx)
  return console.log.mock.calls.map((call) => call.arguments[0]).find((arg) => typeof arg === 'string' && arg.includes('request(s)'))
}

async function addTurn(ctx, usage, question, answer) {
  ctx.state.appendUser(question)
  ctx.state.appendAssistant({ role: 'assistant', content: answer, usage })
  ctx.tracker.record(usage, ctx.state.pricing)
}

test('copyMetricsFrom carries the scrape count, flat fee and peak context onto the live tracker', () => {
  const source = new UsageTracker()
  source.record(TURN_ONE, PRICING)
  source.addScrapeCost(SCRAPE_COST_USD, 2)

  const target = new UsageTracker()
  target.record(TURN_TWO, PRICING)
  target.copyMetricsFrom(source)

  assert.equal(target.scrapes, 2)
  assert.equal(target.peakContext, 150)
  assert.equal(target.requests, 1)
  assert.equal(target.totalTokens, 150)
  assert.ok(Math.abs(target.cost - source.cost) < 1e-9)
})

test('/edit keeps a scrape fee and count in the tracker, /cost and the persisted summary', async (t) => {
  mockConsole(t)
  const { ctx, persisted } = makeCtx()
  ctx.readInput = async () => ({ value: 'edited prompt' })

  await chatCommands['/scrape']({ ...ctx, args: 'https://example.com/article' })
  await addTurn(ctx, TURN_ONE, 'first question', 'first answer')
  await addTurn(ctx, TURN_TWO, 'second question', 'second answer')
  assert.ok(Math.abs(ctx.tracker.cost - (SCRAPE_COST_USD + TURN_ONE_COST + 500 * PRICING.prompt + 100 * PRICING.completion)) < 1e-9)

  await chatCommands['/edit'](ctx)

  // The stale second answer was dropped and the rerun recorded no usage: the
  // recompute must carry the paid scrape once, on top of the surviving turn.
  assert.equal(ctx.state.scrapes, 1)
  assert.equal(ctx.tracker.scrapes, 1)
  assert.equal(ctx.tracker.requests, 1)
  assert.ok(Math.abs(ctx.tracker.cost - (SCRAPE_COST_USD + TURN_ONE_COST)) < 1e-9)
  assert.ok(ctx.state.messages.some((m) => m.role === 'user' && String(m.content).startsWith('Scraped from https://example.com/article:')))

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].scrapes, 1)
  assert.ok(Math.abs(persisted[0].cost - (SCRAPE_COST_USD + TURN_ONE_COST)) < 1e-9)

  const line = await printedSummary(ctx)
  assert.match(line, /1 scrape/)
  assert.match(line, /\$0\.010200 cost/)
})

test('/delete keeps a scrape fee and count and recomputes the surviving peak context', async (t) => {
  mockConsole(t)
  const { ctx, persisted } = makeCtx()

  await chatCommands['/scrape']({ ...ctx, args: 'https://example.com/first' })
  await addTurn(ctx, TURN_ONE, 'first question', 'first answer')
  await addTurn(ctx, TURN_TWO, 'second question', 'second answer')
  assert.equal(ctx.tracker.peakContext, 600)

  const outcome = await chatCommands['/delete'](ctx)

  assert.deepEqual(outcome, { resetBudgetWarning: true })
  assert.equal(ctx.state.scrapes, 1)
  assert.equal(ctx.tracker.scrapes, 1)
  assert.equal(ctx.tracker.requests, 1)
  assert.equal(ctx.tracker.peakContext, 150)
  assert.ok(Math.abs(ctx.tracker.cost - (SCRAPE_COST_USD + TURN_ONE_COST)) < 1e-9)

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].scrapes, 1)
  assert.ok(Math.abs(persisted[0].cost - (SCRAPE_COST_USD + TURN_ONE_COST)) < 1e-9)

  const line = await printedSummary(ctx)
  assert.match(line, /1 scrape/)
  assert.match(line, /\$0\.010200 cost/)
})

test('/delete of the scrape context turn keeps the paid fee and count in the tracker and the persisted summary', async (t) => {
  mockConsole(t)
  const { ctx, persisted } = makeCtx()

  await chatCommands['/scrape']({ ...ctx, args: 'https://example.com/only' })

  await chatCommands['/delete'](ctx)

  // The scrape is a paid flat fee, not a turn: removing its context message
  // leaves state.scrapes (the session counter) and the fee untouched.
  assert.equal(ctx.state.messages.length, 1)
  assert.equal(ctx.state.scrapes, 1)
  assert.equal(ctx.tracker.scrapes, 1)
  assert.equal(ctx.tracker.requests, 0)
  assert.ok(Math.abs(ctx.tracker.cost - SCRAPE_COST_USD) < 1e-9)

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].scrapes, 1)
  assert.ok(Math.abs(persisted[0].cost - SCRAPE_COST_USD) < 1e-9)

  const line = await printedSummary(ctx)
  assert.match(line, /1 scrape/)
  assert.match(line, /\$0\.010000 cost/)
})
