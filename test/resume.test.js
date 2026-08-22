import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let matchedId = '2026-01-01T00-00-00'
let sessionData = null
mock.module(new URL('../src/sessions.js', import.meta.url).href, {
  namedExports: {
    ensureSessionsDir: async () => '/fake/sessions',
    resolveSessionInteractive: async () => matchedId,
    loadSession: async () => sessionData,
  },
})

const { resumeCmd } = await import('../src/commands/resume.js')

function session(overrides = {}) {
  return {
    model: 'org/model',
    providerName: 'ProviderX',
    providerType: 'openrouter',
    reasoningEffort: 'high',
    temperature: 0.9,
    topP: 0.8,
    budget: 5,
    webSearch: 'auto',
    webResults: 3,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    contextLength: 128000,
    supportsReasoning: false,
    webSearchSupported: false,
    isImageModel: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ],
    ...overrides,
  }
}

test('resumeCmd maps the session payload with normalized values', async () => {
  sessionData = session()
  const result = await resumeCmd('2026')

  assert.equal(result.modelId, 'org/model')
  assert.equal(result.providerName, 'ProviderX')
  assert.equal(result.providerType, 'openrouter')
  assert.equal(result.reasoningEffort, 'high')
  assert.equal(result.temperature, 0.9)
  assert.equal(result.topP, 0.8)
  assert.equal(result.budget, 5)
  assert.equal(result.webSearch, 'auto')
  assert.equal(result.webResults, 3)
  assert.deepEqual(result.pricing, { prompt: 0.000001, completion: 0.000002 })
  assert.equal(result.contextLength, 128000)
  assert.equal(result.supportsReasoning, false)
  assert.equal(result.webSearchSupported, false)
  assert.equal(result.isImageModel, false)
  assert.equal(result.sessionId, '2026-01-01T00-00-00')
  assert.equal(result.sessionCreatedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(result.initialMessages.length, 3)
})

test('resumeCmd defaults temperature, leaves topP unset and normalizes legacy values', async () => {
  sessionData = session({ temperature: undefined, topP: undefined, webSearch: true, contextLength: null, webResults: null })
  const result = await resumeCmd('2026')

  assert.equal(result.temperature, 0.7)
  assert.equal(result.topP, undefined)
  assert.equal(result.webSearch, 'auto')
  assert.equal(result.webResults, null)
  assert.equal(result.contextLength, null)
})

test('resumeCmd passes budget through raw for the caller to sanitize', async () => {
  sessionData = session({ budget: 'nope' })
  const result = await resumeCmd('2026')
  assert.equal(result.budget, 'nope')
})

test('resumeCmd keeps missing capability fields at their safe defaults', async () => {
  sessionData = session({ supportsReasoning: undefined, webSearchSupported: undefined, isImageModel: undefined, scrapes: undefined })
  const result = await resumeCmd('2026')

  assert.equal(result.supportsReasoning, true)
  assert.equal(result.webSearchSupported, undefined)
  assert.equal(result.isImageModel, false)
  assert.equal(result.scrapes, 0)
})

test('resumeCmd restores the scraped page count for cost tracking', async () => {
  sessionData = session({ scrapes: 3 })
  const result = await resumeCmd('2026')
  assert.equal(result.scrapes, 3)
})

test('resumeCmd marks image sessions and maps legacy on web search to auto', async () => {
  sessionData = session({ isImageModel: true, webSearch: 'on' })
  const result = await resumeCmd('2026')

  assert.equal(result.isImageModel, true)
  assert.equal(result.webSearch, 'auto')
})

test('resumeCmd returns null when the picker resolves nothing', async () => {
  matchedId = null
  const result = await resumeCmd('2026')
  assert.equal(result, null)
})
