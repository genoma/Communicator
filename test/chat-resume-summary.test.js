import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runChatSession } from '../src/chat.js'

function scriptedInput(values) {
  const queue = [...values]
  return async () => {
    if (queue.length === 0) return { cancelled: true }
    return { value: queue.shift() }
  }
}

function fakeProvider() {
  return {
    meta: { name: 'openrouter' },
    async chatCompletion(opts) {
      opts.onRequest?.({ model: opts.model, messages: opts.messages.slice(), stream: true, temperature: opts.temperature })
      return { content: 'Hello!', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
}

function fakeRenderer({ markdown }) {
  const render = () => {}
  render.markdown = markdown
  render.resetMessage = () => {}
  render.flush = () => {}
  return render
}

function makeDeps() {
  return {
    readInput: scriptedInput(['/quit']),
    renderer: fakeRenderer,
    stdout: { write() {} },
    exit: () => {},
    saveSession: async () => {},
    savePrefs: async () => {},
    newSessionId: async () => '2026-01-02T00-00-00',
    // Never construct the real platform spelling provider (osascript on darwin).
    createSpelling: () => null,
    onSignal: () => () => {},
  }
}

function baseCtx(provider, overrides = {}) {
  return {
    apiKey: 'test-key',
    model: 'org/model',
    endpointProviderName: 'Provider',
    reasoningEffort: 'high',
    temperature: 1.1,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    provider,
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function mockConsole(t) {
  const logs = []
  t.mock.method(console, 'log', (...args) => { logs.push(String(args[0] ?? '')) })
  t.mock.method(console, 'error', () => {})
  return logs
}

// The suite runs with NO_COLOR, but stripping the dim() styling keeps the
// exact-line assertions independent of the caller's color environment.
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '') // eslint-disable-line no-control-regex

const storedTurn = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'old question' },
  { role: 'assistant', content: 'old answer', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
]

function previousSessionLines(logs) {
  return logs.map((line) => plain(line)).filter((line) => line.includes('Previous session:'))
}

test('a resumed session renders the persisted cost summary as the Previous session line', async (t) => {
  const logs = mockConsole(t)
  const provider = fakeProvider()

  await runChatSession(baseCtx(provider, {
    // The stored turn would replay to a different summary (5/5 prompt,
    // 10 total, 1 request), so the exact line proves the persisted summary
    // is preferred over the replay calculation.
    initialMessages: storedTurn,
    resumeCostSummary: {
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      requests: 2,
      scrapes: 2,
      cacheHits: 3,
      cachedTokens: 40,
      cost: 0.0002,
    },
  }), makeDeps())

  assert.deepEqual(previousSessionLines(logs), [
    'Previous session: ↑ 120 prompt  ↓ 30 completion  = 150 total  |  2 request(s)  |  2 scrapes  |  3 cache hit(s) [40 cached tokens]  |  $0.000200 cost\n',
  ])
})

test('a malformed persisted cost summary renders zeros instead of throwing', async (t) => {
  const logs = mockConsole(t)
  const provider = fakeProvider()

  await runChatSession(baseCtx(provider, {
    initialMessages: storedTurn,
    resumeCostSummary: {
      promptTokens: 'x',
      completionTokens: null,
      totalTokens: 'x',
      requests: NaN,
      cost: NaN,
      scrapes: 'x',
      cacheHits: 'x',
      cachedTokens: undefined,
    },
  }), makeDeps())

  assert.deepEqual(previousSessionLines(logs), [
    'Previous session: ↑ 0 prompt  ↓ 0 completion  = 0 total  |  0 request(s)\n',
  ])
})

test('a persisted cost summary without totalTokens falls back to prompt plus completion', async (t) => {
  const logs = mockConsole(t)
  const provider = fakeProvider()

  await runChatSession(baseCtx(provider, {
    initialMessages: storedTurn,
    resumeCostSummary: {
      promptTokens: 40,
      completionTokens: 2,
      requests: 1,
    },
  }), makeDeps())

  assert.deepEqual(previousSessionLines(logs), [
    'Previous session: ↑ 40 prompt  ↓ 2 completion  = 42 total  |  1 request(s)\n',
  ])
})
