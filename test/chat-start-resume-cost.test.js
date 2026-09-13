import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

let resumeResult = null
mock.module(new URL('../src/commands/resume.js', import.meta.url).href, {
  namedExports: {
    resumeCmd: async () => resumeResult,
  },
})

const startChatCalls = []
mock.module(new URL('../src/chat.js', import.meta.url).href, {
  namedExports: {
    startChat: async (apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, provider, opts) => {
      startChatCalls.push({ opts })
      return {
        sessionId: opts.sessionId,
        createdAt: opts.createdAt,
        modelId: model,
        endpointProviderName,
        providerType: provider.meta.name,
        reasoningEffort,
        temperature,
        pricing,
        messages: opts.initialMessages,
      }
    },
  },
})

const { chatStart } = await import('../src/commands/chat-start.js')

const persistedSummary = {
  promptTokens: 120,
  completionTokens: 30,
  totalTokens: 150,
  requests: 2,
  scrapes: 2,
  cacheHits: 3,
  cachedTokens: 40,
  cost: 0.0002,
}

function resumeSession(overrides = {}) {
  return {
    modelId: 'test/model',
    providerName: 'ProviderX',
    providerType: 'openrouter',
    reasoningEffort: 'low',
    temperature: 0.9,
    topP: 0.8,
    budget: 5,
    webSearch: 'off',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    contextLength: 128000,
    isImageModel: false,
    initialMessages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
    ],
    sessionId: '2026-01-01T00-00-00',
    sessionCreatedAt: '2026-01-01T00:00:00.000Z',
    costSummary: persistedSummary,
    ...overrides,
  }
}

function baseOpts(overrides = {}) {
  return {
    attach: [],
    smoothStreaming: true,
    config: undefined,
    resume: undefined,
    ...overrides,
  }
}

function withApiKey(t, value = 'test-key') {
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  })
}

test('chatStart forwards the persisted cost summary to startChat as resumeCostSummary', async (t) => {
  resumeResult = resumeSession()
  withApiKey(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  t.mock.method(console, 'log', () => {})

  await chatStart({
    apiKey: 'ignored',
    opts: baseOpts({ resume: '2026-01-01', config: join(dir, 'config.json') }),
    prefs: {},
    systemPrompt: null,
    providerType: 'openrouter',
  })

  assert.equal(startChatCalls.length, 1)
  // startChat renders the 'Previous session' line from this option, preferring
  // it over the summary replayed from the stored turns, so the persisted file
  // summary must arrive untouched.
  assert.equal(startChatCalls[0].opts.resumeCostSummary, resumeResult.costSummary)
  assert.deepEqual(startChatCalls[0].opts.resumeCostSummary, persistedSummary)
})
