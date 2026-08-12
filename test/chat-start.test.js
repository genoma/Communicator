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

let nonInteractiveSelection = null
let findImageModelResult = null
let findImageModelCalls = 0
mock.module(new URL('../src/model-selection.js', import.meta.url).href, {
  namedExports: {
    selectModelAndEndpoint: async () => { throw new Error('unexpected picker') },
    selectModelNonInteractive: async () => {
      if (nonInteractiveSelection === null) throw new Error('no selection mocked')
      return nonInteractiveSelection
    },
    findImageModel: async () => {
      findImageModelCalls++
      return findImageModelResult
    },
  },
})

const imageSessionCalls = []
let imageSessionResult = null
mock.module(new URL('../src/commands/image-session.js', import.meta.url).href, {
  namedExports: {
    startImageSession: async (opts) => {
      imageSessionCalls.push(opts)
      return imageSessionResult
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
    providerName: 'ProviderX',
    providerType: 'openrouter',
    reasoningEffort: 'low',
    temperature: 0.9,
    budget: 5,
    webSearch: 'off',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    contextLength: 128000,
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
    e2ee: undefined,
    zdr: undefined,
    image: undefined,
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

function withVeniceApiKey(t, value = 'venice-key') {
  const previous = process.env.VENICE_API_KEY
  process.env.VENICE_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.VENICE_API_KEY
    else process.env.VENICE_API_KEY = previous
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
  assert.equal(call.opts.contextLength, 128000)
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

test('chatStart resume branch forwards the persisted scrape count for cost tracking', async (t) => {
  resumeResult = resumeSession({ scrapes: 2 })
  withApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'openrouter' })
  assert.equal(startChatCalls[startChatCalls.length - 1].opts.scrapes, 2)

  resumeResult = resumeSession()
  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'openrouter' })
  assert.equal(startChatCalls[startChatCalls.length - 1].opts.scrapes, 0)
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

test('chatStart resume skips the image catalog when the session marker says text', async (t) => {
  resumeResult = resumeSession({ isImageModel: false })
  findImageModelCalls = 0
  findImageModelResult = null
  withApiKey(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x' }), prefs: {}, systemPrompt: null, providerType: 'openrouter' })

  assert.equal(findImageModelCalls, 0)
})

test('chatStart resume routes marked image sessions without the catalog fetch', async (t) => {
  resumeResult = resumeSession({ isImageModel: true })
  findImageModelCalls = 0
  findImageModelResult = null
  imageSessionCalls.length = 0
  withApiKey(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x' }), prefs: {}, systemPrompt: null, providerType: 'venice' })

  assert.equal(findImageModelCalls, 0)
  assert.equal(imageSessionCalls.length, 1)
  assert.equal(imageSessionCalls[0].imageModelId, 'test/model')
})

test('chatStart resume falls back to the catalog for legacy sessions without the marker', async (t) => {
  resumeResult = resumeSession()
  findImageModelCalls = 0
  findImageModelResult = true
  imageSessionCalls.length = 0
  withApiKey(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x' }), prefs: {}, systemPrompt: null, providerType: 'venice' })

  assert.equal(findImageModelCalls, 1)
  assert.equal(imageSessionCalls.length, 1)
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

test('chatStart rejects --e2ee resume of an unencrypted session', async (t) => {
  resumeResult = resumeSession({ e2ee: false })
  withApiKey(t)
  t.mock.method(console, 'log', () => {})

  await assert.rejects(
    chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x', e2ee: true }), prefs: {}, systemPrompt: null, providerType: 'venice' }),
    (err) => err instanceof Error && /not created with --e2ee; refusing to resume it unencrypted/.test(err.message)
  )
})

test('chatStart rejects resuming an e2ee session without --e2ee', async (t) => {
  resumeResult = resumeSession({ e2ee: true })
  withApiKey(t)
  t.mock.method(console, 'log', () => {})

  await assert.rejects(
    chatStart({ apiKey: 'k', opts: baseOpts({ resume: 'x' }), prefs: {}, systemPrompt: null, providerType: 'venice' }),
    (err) => err instanceof Error && /was created with --e2ee; resume it with --e2ee/.test(err.message)
  )
})

test('chatStart resumes an e2ee session with --e2ee and keeps the marker', async (t) => {
  resumeResult = resumeSession({ e2ee: true, isImageModel: false, providerType: 'venice', providerName: 'venice' })
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'ignored', opts: baseOpts({ resume: 'x', e2ee: true, config: configFile }), prefs: {}, systemPrompt: null, providerType: 'venice' })

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.opts.e2ee, true)
  assert.equal(call.opts.webSearch, 'off')
  assert.equal(call.opts.webResults, null)
})

test('chatStart non-resume branch builds the context from selection and prefs', async (t) => {
  resumeResult = null
  nonInteractiveSelection = {
    modelId: 'test/model',
    endpointProviderName: 'ProviderX',
    reasoningEffort: 'medium',
    webSearchSupported: true,
    visionSupported: undefined,
    fileSupported: true,
    pricing: { prompt: 1e-6, completion: 2e-6 },
    contextLength: 64000,
    supportsReasoning: true,
    modelReasoning: null,
  }

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
  assert.equal(call.opts.contextLength, 64000)
  assert.match(call.opts.sessionId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/)
  assert.ok(call.opts.createdAt)
})

test('chatStart routes a resumed venice image session into the image session', async (t) => {
  resumeResult = resumeSession({
    providerType: 'venice',
    modelId: 'venice-sd35',
    providerName: 'venice',
    reasoningEffort: 'auto',
  })
  findImageModelResult = { id: 'venice-sd35', name: 'SD 3.5' }
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})
  const chatCallsBefore = startChatCalls.length
  const imageCallsBefore = imageSessionCalls.length

  const { chatStart: fresh } = await import(`../src/commands/chat-start.js?t=${Date.now()}`)
  await fresh({ apiKey: 'k', opts: baseOpts({ resume: '2026-01-01', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'venice' })

  assert.equal(startChatCalls.length, chatCallsBefore)
  assert.equal(imageSessionCalls.length, imageCallsBefore + 1)
  const call = imageSessionCalls[imageSessionCalls.length - 1]
  assert.equal(call.imageModelId, 'venice-sd35')
  assert.equal(call.sessionId, '2026-01-01T00-00-00')
  assert.equal(call.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(call.initialMessages.length, 3)
  assert.equal(call.configPath, configFile)
})

test('chatStart resumes venice text sessions into the chat as before', async (t) => {
  resumeResult = resumeSession({
    providerType: 'venice',
    modelId: 'venice/llama',
    providerName: 'venice',
  })
  findImageModelResult = null
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})
  const chatCallsBefore = startChatCalls.length
  const imageCallsBefore = imageSessionCalls.length

  const { chatStart: fresh } = await import(`../src/commands/chat-start.js?t=${Date.now()}`)
  await fresh({ apiKey: 'k', opts: baseOpts({ resume: '2026-01-01', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'venice' })

  assert.equal(startChatCalls.length, chatCallsBefore + 1)
  assert.equal(imageSessionCalls.length, imageCallsBefore)
  assert.equal(startChatCalls[startChatCalls.length - 1].model, 'venice/llama')
})

test('chatStart routes a picked image model into the image session', async (t) => {
  resumeResult = null
  nonInteractiveSelection = {
    modelId: 'venice-sd35',
    isImageModel: true,
    endpointProviderName: 'venice',
    reasoningEffort: null,
    webSearchSupported: false,
    visionSupported: false,
    fileSupported: false,
    pricing: { perImage: 0.02 },
    contextLength: null,
    supportsReasoning: false,
    modelReasoning: null,
  }
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})
  const chatCallsBefore = startChatCalls.length
  const imageCallsBefore = imageSessionCalls.length

  const { chatStart: fresh } = await import(`../src/commands/chat-start.js?t=${Date.now()}`)
  await fresh({ apiKey: 'k', opts: baseOpts({ model: 'venice-sd35', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'venice' })

  assert.equal(startChatCalls.length, chatCallsBefore)
  assert.equal(imageSessionCalls.length, imageCallsBefore + 1)
  const call = imageSessionCalls[imageSessionCalls.length - 1]
  assert.equal(call.imageModelId, 'venice-sd35')
  assert.deepEqual(call.initialMessages, [])
  assert.match(call.sessionId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/)
  assert.ok(call.createdAt)
  assert.equal(call.configPath, configFile)
})

test('chatStart hands an image session /model text pick into startChat with the same session', async (t) => {
  resumeResult = resumeSession({ isImageModel: true, providerType: 'venice' })
  imageSessionCalls.length = 0
  startChatCalls.length = 0
  imageSessionResult = {
    switchToChat: {
      selection: {
        modelId: 'openrouter/auto',
        endpointProviderName: 'OpenAI',
        reasoningEffort: null,
        supportsReasoning: true,
        modelReasoning: null,
        contextLength: 128000,
        webSearchSupported: true,
        visionSupported: false,
        fileSupported: true,
        imageOutputSupported: undefined,
        pricing: { prompt: 0.000001, completion: 0.000002 },
      },
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'draw a cat' },
        { role: 'assistant', content: [{ type: 'text', text: '[generated image]' }] },
      ],
      sessionId: '2026-01-01T00-00-00',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  }
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(console, 'log', () => {})

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: '2026-01-01', config: configFile }), prefs: {}, systemPrompt: null, providerType: 'venice' })

  assert.equal(startChatCalls.length, 1)
  const call = startChatCalls[0]
  assert.equal(call.model, 'openrouter/auto')
  assert.equal(call.endpointProviderName, 'OpenAI')
  assert.equal(call.reasoningEffort, null)
  assert.equal(call.temperature, 0.7)
  assert.equal(call.opts.sessionId, '2026-01-01T00-00-00')
  assert.equal(call.opts.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(call.opts.initialMessages.length, 3)
  assert.equal(call.opts.initialMessages[2].content[0].text, '[generated image]')
  assert.equal(call.opts.budget, null)
  assert.equal(call.opts.webSearch, 'off')
  assert.equal(call.opts.webResults, null)
  assert.equal(call.opts.zdr, false)
  assert.equal(call.opts.contextLength, 128000)
  assert.equal(call.opts.visionSupported, false)
  assert.equal(call.opts.supportsReasoning, true)
  assert.equal(call.opts.smoothStreaming, true)

  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.lastModel, 'openrouter/auto')
  imageSessionResult = null
})
