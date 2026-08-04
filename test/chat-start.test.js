import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
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
      startChatCalls.push({ apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, opts })
      return {
        sessionId: opts.sessionId,
        createdAt: opts.createdAt,
        modelId: model,
        endpointProviderName,
        providerType: provider.meta.name,
        reasoningEffort,
        temperature,
        budget: opts.budget,
        webSearch: opts.webSearch,
        webResults: opts.webResults,
        pricing,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
        ],
      }
    },
  },
})

const { chatStart } = await import('../src/commands/chat-start.js')

class ExitSignal {
  constructor(code) {
    this.code = code
  }
}

function resumeSession(overrides = {}) {
  return {
    modelId: 'test/model',
    modelName: 'test/model',
    providerName: 'ProviderX',
    providerType: 'openrouter',
    reasoningEffort: 'low',
    temperature: 0.9,
    budget: 5,
    webSearch: 'off',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    initialMessages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ],
    sessionId: '2026-01-01T00-00-00',
    sessionCreatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function baseOpts(overrides = {}) {
  return {
    model: undefined,
    temperature: undefined,
    budget: undefined,
    reasoningEffort: undefined,
    webSearch: undefined,
    webResults: undefined,
    attach: [],
    smoothStreaming: true,
    smoothSpeed: undefined,
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

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  const file = join(dir, 'config.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return file
}

test('chatStart resume branch restores the session context', async (t) => {
  resumeResult = resumeSession()
  withApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'ignored', opts: baseOpts({ resume: '2026-01-01', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'openrouter' })

  assert.equal(startChatCalls.length, 1)
  const call = startChatCalls[0]
  assert.equal(call.model, 'test/model')
  assert.equal(call.endpointProviderName, 'ProviderX')
  assert.equal(call.reasoningEffort, 'low')
  assert.equal(call.temperature, 0.9)
  assert.equal(call.pricing.prompt, 0.000001)
  assert.equal(call.opts.budget, 5)
  assert.equal(call.opts.webSearch, 'off')
  assert.equal(call.opts.webResults, null)
  assert.equal(call.opts.sessionId, '2026-01-01T00-00-00')
  assert.equal(call.opts.initialMessages.length, 3)
  assert.equal(call.opts.configPath, configFile)

  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.lastModel, 'test/model')
})

test('chatStart resume branch applies --reasoning-effort overrides', async (t) => {
  resumeResult = resumeSession()
  withApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x', reasoningEffort: 'high', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'openrouter' })
  assert.equal(startChatCalls[startChatCalls.length - 1].reasoningEffort, 'high')

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x', reasoningEffort: 'none', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'openrouter' })
  assert.equal(startChatCalls[startChatCalls.length - 1].reasoningEffort, null)
})

test('chatStart resume branch maps the auto marker back to undefined reasoning effort', async (t) => {
  resumeResult = resumeSession({ reasoningEffort: 'auto' })
  withApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'openrouter' })
  assert.equal(startChatCalls[startChatCalls.length - 1].reasoningEffort, undefined)
})

test('chatStart resume branch keeps disabled reasoning for sessions written pre-change', async (t) => {
  resumeResult = resumeSession({ reasoningEffort: null })
  withApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'openrouter' })
  assert.equal(startChatCalls[startChatCalls.length - 1].reasoningEffort, null)
})

test('chatStart resume branch applies --temperature, --budget and --web-search overrides', async (t) => {
  resumeResult = resumeSession()
  withApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x', temperature: '0.5', budget: '2', webSearch: 'always', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'openrouter' })

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.temperature, 0.5)
  assert.equal(call.opts.budget, 2)
  assert.equal(call.opts.webSearch, 'always')
})

test('chatStart exits 0 when the resumed session does not resolve', async (t) => {
  resumeResult = null
  withApiKey(t)
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })
  t.mock.method(console, 'log', () => {})

  await assert.rejects(
    chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'missing' }), prefs: {}, systemPrompt: null, providerType: 'openrouter' }),
    (e) => e instanceof ExitSignal && e.code === 0
  )
  assert.equal(exitCode, 0)
})

test('chatStart non-resume branch builds the context from selection and prefs', async (t) => {
  resumeResult = null
  const selection = {
    modelId: 'test/model',
    endpointProviderName: 'ProviderX',
    reasoningEffort: 'medium',
    webSearchSupported: true,
    visionSupported: undefined,
    fileSupported: true,
    pricing: { prompt: 1e-6, completion: 2e-6 },
    supportsReasoning: true,
    modelReasoning: null,
  }
  mock.module(new URL('../src/model-selection.js', import.meta.url).href, {
    namedExports: {
      selectModelAndEndpoint: async () => { throw new Error('unexpected picker') },
      selectModelNonInteractive: async () => selection,
    },
  })

  const { chatStart: chatStartFresh } = await import(`../src/commands/chat-start.js?t=${Date.now()}`)
  withApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})

  await chatStartFresh({ apiKey: 'k', opts: baseOpts({ model: 'test/model', temperature: '0.5', budget: '2', config: configFile }), prefs: { budget: 1 }, systemPrompt: null, providerType: 'openrouter' })

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.model, 'test/model')
  assert.equal(call.endpointProviderName, 'ProviderX')
  assert.equal(call.reasoningEffort, 'medium')
  assert.equal(call.temperature, 0.5)
  assert.equal(call.opts.budget, 2)
  assert.equal(call.opts.webSearch, 'off')
  assert.equal(call.opts.webSearchSupported, true)
  assert.match(call.opts.sessionId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/)
  assert.ok(call.opts.createdAt)
})
