import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs/promises'
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExitPromptError } from '@inquirer/core'
import { CliError } from '../src/errors.js'
import { styleText } from 'node:util'
import { resetMetadataCaches } from '../src/providers/openrouter-meta.js'

const dim = (text) => styleText('dim', text)

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async () => { throw new ExitPromptError() },
    select: async () => { throw new ExitPromptError() },
    checkbox: async () => { throw new ExitPromptError() },
  },
})

// Only `appendFile` is intercepted, and only while a test asks for it: the
// prompt log is written through it (src/rpg.js), and holding that one write open
// is what makes "the log is already there when the run returns" a deterministic
// assertion instead of a lucky timing. Everything else delegates to the real
// module.
let appendFileDelayMs = 0
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    appendFile: async (...args) => {
      if (appendFileDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, appendFileDelayMs))
      return realFs.appendFile(...args)
    },
  },
})

// Loaded after the @inquirer mock so the picker graph never loads the real
// module (a static import would bind it before mock.module applies).
const { saveSession, ensureSessionsDir } = await import('../src/sessions.js')
const { ensureRpgSessionsDir } = await import('../src/rpg.js')
// Loaded after the node:os mock so constants.js resolves the temp home.
const { resetModelCaches: resetOpenRouterModelCaches } = await import('../src/providers/openrouter.js')
const { resetModelCaches: resetVeniceModelCaches } = await import('../src/providers/venice.js')

class ExitSignal {
  constructor(code) {
    this.code = code
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function event(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

function mockOpenRouterStream(t, fetchCalls = [], bodies = []) {
  resetOpenRouterModelCaches()
  const models = [{ id: 'test/model-a', name: 'Model A', context_length: 1000, description: 'd', reasoning: null }]
  const endpoints = [{
    provider_name: 'ProviderX',
    tag: 't',
    status: 'available',
    uptime_last_30m: null,
    pricing: { prompt: 1e-6, completion: 2e-6 },
    context_length: 1000,
    max_completion_tokens: null,
    supported_parameters: {},
  }]
  // Usage is the top-level `parsed.usage` the SSE parser reads (matching the
  // real provider response); it must not be nested under choices/delta.
  const stream = [
    event({ choices: [{ delta: { content: 'Hello' } }] }),
    event({ choices: [{ delta: { content: ' world' } }] }),
    event({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    'data: [DONE]\n\n',
  ]
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls.push(String(url))
    if (String(url).includes('/chat/completions')) {
      if (opts?.body) bodies.push(JSON.parse(opts.body))
      return sseResponse(stream)
    }
    if (String(url).includes('/endpoints')) return jsonResponse({ data: { endpoints } })
    return jsonResponse({ data: models })
  })
}

// Notices route to stdout on a terminal and to stderr when stdout is piped
// (the piped one-shot emits only answer text there); every notice assertion
// pins the stream it expects instead of inheriting the runner's own TTY state.
function withStdoutTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original)
    else delete process.stdout.isTTY
  })
}

function captureConsole(t) {
  const logs = []
  const errors = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  return { logs, errors }
}

function withApiKey(t, value = 'test-key') {
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  })
}

function withoutApiKey(t) {
  const previous = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous
  })
}

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  const file = join(dir, 'config.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return file
}

const BASE_OPTS = {
  model: 'test/model-a',
  temperature: undefined,
  reasoningEffort: undefined,
  webSearch: undefined,
  webResults: undefined,
  attach: [],
  smoothStreaming: true,
  smoothSpeed: undefined,
  config: undefined,
}

function opts(overrides = {}) {
  return { ...BASE_OPTS, ...overrides }
}

function mockExit(t) {
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })
  return () => exitCode
}

// The piped one-shot writes the answer with process.stdout.write, which is also
// the test child's protocol channel: capturing those writes keeps application
// text off fd 1 (see test/runner-console-guard.test.js). The runner frames its
// results as buffers on that same channel, so they are forwarded untouched.
function mockPipedStdout(t) {
  const writes = []
  const forward = process.stdout.write.bind(process.stdout)
  t.mock.method(process.stdout, 'write', (chunk, ...rest) => {
    if (typeof chunk !== 'string') return forward(chunk, ...rest)
    writes.push(String(chunk))
    return true
  })
  return writes
}

async function runOneShot(t, { overrides = {}, prefs = {}, prompt = 'Hello', systemPrompt = null, rpgFirstMessage = null, rpgHistory = null, rpgPostHistoryInstruction = null, rpgResume = null, scraped = null } = {}) {
  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  try {
    await oneShotCmd({ apiKey: 'test-key', opts: opts(overrides), prefs, systemPrompt, rpgFirstMessage, rpgHistory, rpgPostHistoryInstruction, providerType: 'openrouter', prompt, rpgResume, scraped })
    return { exited: false }
  } catch (e) {
    if (e instanceof CliError) return { exited: true, exitCode: e.exitCode, message: e.message }
    throw e
  }
}

test('one-shot success path writes plain output, the session file and persisted prefs', async (t) => {
  mockOpenRouterStream(t)
  withApiKey(t)
  const file = await tempConfig(t)
  const writes = mockPipedStdout(t)
  const getExitCode = mockExit(t)

  const { exited } = await runOneShot(t, { overrides: { config: file }, prefs: { budget: 5 } })

  assert.equal(exited, false)
  assert.equal(getExitCode(), null)

  // Piped stdout streams content deltas as they arrive; assert the full
  // answer accumulates across writes, and the trailing newline is emitted.
  assert.ok(writes.join('').includes('Hello world'))
  assert.ok(writes.includes('Hello'), 'content is streamed, not buffered to the end')
  assert.ok(writes.some((w) => w === '\n'))

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  assert.equal(files.length, 1)
  const saved = JSON.parse(await readFile(join(sessionsDir, files[0]), 'utf-8'))
  assert.equal(saved.model, 'test/model-a')
  assert.equal(saved.providerName, 'ProviderX')
  assert.equal(saved.providerType, 'openrouter')
  assert.equal(saved.temperature, undefined)
  assert.equal(saved.topP, undefined)
  // A legacy prefs.budget is inert since 4.0.0: the session carries no cap.
  assert.equal(saved.budget, null)
  assert.equal(saved.webSearch, 'off')
  assert.equal(saved.messages.length, 3)
  assert.equal(saved.messages[2].content, 'Hello world')
  // The piped path records usage so the persisted cost summary is real (not
  // zeroed): resume/list/export prefer it, so a zeroed summary would
  // under-count the session forever.
  assert.ok(saved.costSummary)
  assert.equal(saved.costSummary.promptTokens, 10)
  assert.equal(saved.costSummary.completionTokens, 5)
  assert.equal(saved.costSummary.totalTokens, 15)
  assert.equal(saved.costSummary.requests, 1)
  assert.ok(saved.costSummary.cost > 0)

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastModel, 'test/model-a')
  assert.equal(prefs.lastProvider, 'ProviderX')
  assert.equal(prefs.temperature?.['test/model-a'], undefined)
  assert.equal(prefs.topP?.['test/model-a'], undefined)
  assert.equal(prefs.budget, 5)
})

test('one-shot piped stdout streams content but never reasoning', async (t) => {
  resetOpenRouterModelCaches()
  const models = [{ id: 'test/model-a', name: 'Model A', context_length: 1000, description: 'd', reasoning: null }]
  const endpoints = [{ provider_name: 'ProviderX', tag: 't', status: 'available', uptime_last_30m: null, pricing: { prompt: 1e-6, completion: 2e-6 }, context_length: 1000, max_completion_tokens: null, supported_parameters: {} }]
  const stream = [
    event({ choices: [{ delta: { reasoning_content: 'SECRET_SECRET' } }] }),
    event({ choices: [{ delta: { content: 'Hello' } }] }),
    event({ choices: [{ delta: { content: ' world' } }] }),
    event({ choices: [{ delta: {}, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }] }),
    'data: [DONE]\n\n',
  ]
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/chat/completions')) return sseResponse(stream)
    if (String(url).includes('/endpoints')) return jsonResponse({ data: { endpoints } })
    return jsonResponse({ data: models })
  })
  withApiKey(t)
  const file = await tempConfig(t)
  const writes = []
  t.mock.method(process.stdout, 'write', (chunk) => { writes.push(String(chunk)); return true })
  mockExit(t)

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await oneShotCmd({ apiKey: 'test-key', opts: opts({ config: file }), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: 'Hello' })

  assert.ok(writes.join('').includes('Hello world'), 'content accumulates to stdout')
  assert.ok(writes.includes('Hello') && writes.includes(' world'), 'content is streamed as deltas')
  assert.ok(!writes.join('').includes('SECRET_SECRET'), 'reasoning never reaches piped stdout')
  assert.ok(writes.some((w) => w === '\n'), 'trailing newline preserved')
})

test('one-shot with --web-search on persists the per-model webSearch pref', async (t) => {
  mockOpenRouterStream(t)
  withApiKey(t)
  mockPipedStdout(t)
  const file = await tempConfig(t)
  const getExitCode = mockExit(t)

  const { exited } = await runOneShot(t, { overrides: { config: file, webSearch: 'on' } })

  assert.equal(exited, false)
  assert.equal(getExitCode(), null)

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.webSearch['test/model-a'], 'auto')
})

test('one-shot sends the RPG first message as the opening assistant turn', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  const file = await tempConfig(t)
  t.mock.method(process.stdout, 'write', () => true)
  mockExit(t)

  const { exited } = await runOneShot(t, {
    overrides: { config: file },
    systemPrompt: 'RPG system prompt',
    rpgFirstMessage: 'The gate creaks open.',
  })

  assert.equal(exited, false)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].messages[0].role, 'system')
  assert.equal(bodies[0].messages[0].content, 'RPG system prompt')
  assert.deepEqual(bodies[0].messages[1], { role: 'assistant', content: 'The gate creaks open.' })
  assert.deepEqual(bodies[0].messages[2], { role: 'user', content: 'Hello' })
})

test('one-shot with a seeded RPG story saves the whole exchange as a chapter session', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  const file = await tempConfig(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  t.mock.method(process.stdout, 'write', () => true)
  mockExit(t)

  const { exited } = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir },
    systemPrompt: 'RPG system prompt',
    rpgHistory: [
      { role: 'assistant', content: 'The gate creaks open.' },
      { role: 'user', content: 'I step through.' },
      { role: 'assistant', content: 'Shadows shift ahead.' },
    ],
  })

  assert.equal(exited, false)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].messages[0].role, 'system')
  assert.deepEqual(bodies[0].messages[3], { role: 'assistant', content: 'Shadows shift ahead.' })
  assert.deepEqual(bodies[0].messages[4], { role: 'user', content: 'Hello' })

  // The whole exchange lands in one chapter session; history.json is no
  // longer written at all.
  const sessionsDir = join(rpgDir, 'sessions')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  assert.equal(files.length, 1)
  const saved = JSON.parse(await readFile(join(sessionsDir, files[0]), 'utf-8'))
  assert.deepEqual(saved.messages.map((m) => m.content), [
    'RPG system prompt',
    'The gate creaks open.',
    'I step through.',
    'Shadows shift ahead.',
    'Hello',
    'Hello world',
  ])
  await assert.rejects(readFile(join(rpgDir, 'history.json'), 'utf-8'), { code: 'ENOENT' })
})

test('one-shot refuses an e2ee mismatch when resuming an RPG chapter', async (t) => {
  // The key must be absent: the chapter's provider is OpenRouter, so with a key
  // in the environment the pre-guard code order would still surface the e2ee
  // refusal and the test would pass without pinning the ordering it is about.
  withoutApiKey(t)
  const file = await tempConfig(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  const rpgResume = {
    modelId: 'org/model',
    providerName: 'openrouter',
    providerType: 'openrouter',
    e2ee: false,
    sessionId: '2026-01-01T00-00-00',
    sessionCreatedAt: '2026-01-01T00:00:00.000Z',
    sessionUpdatedAt: null,
    turns: [{ role: 'user', content: 'Hello' }],
    rpgDir,
  }

  // --e2ee on a plaintext chapter must refuse (before any API call).
  const resumed = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir, resume: true, e2ee: true },
    systemPrompt: 'RPG system prompt',
    rpgHistory: [{ role: 'user', content: 'Hello' }],
    rpgResume,
  })
  assert.equal(resumed.exited, true)
  // The chapter's provider cannot run --e2ee at all, so that limitation is the
  // message the user must see.
  assert.match(resumed.message, /--e2ee is only available with --provider venice/)

  // The reverse direction too.
  const resumed2 = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir, resume: true },
    systemPrompt: 'RPG system prompt',
    rpgHistory: [{ role: 'user', content: 'Hello' }],
    rpgResume: { ...rpgResume, e2ee: true },
  })
  assert.equal(resumed2.exited, true)
  assert.match(resumed2.message, /created with --e2ee/)
})

test('one-shot refuses an --rpg chapter resumed with an image model selection', async (t) => {
  withApiKey(t)
  const file = await tempConfig(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))

  // A chapter payload marked as an image session must be refused before any
  // provider call (a global image session would silently drop the chapter).
  const resumed = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir, resume: true, model: undefined },
    systemPrompt: 'RPG system prompt',
    rpgHistory: [{ role: 'user', content: 'Hello' }],
    rpgResume: {
      modelId: 'org/model',
      providerName: null,
      providerType: 'openrouter',
      e2ee: false,
      isImageModel: true,
      sessionId: '2026-01-01T00-00-00',
      sessionCreatedAt: '2026-01-01T00:00:00.000Z',
      sessionUpdatedAt: null,
      turns: [{ role: 'user', content: 'Hello' }],
      rpgDir,
    },
  })
  assert.equal(resumed.exited, true)
  assert.match(resumed.message, /--rpg is for text chat models only/)
})

test('one-shot with --rpg --resume continues the resolved chapter session', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  const file = await tempConfig(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  t.mock.method(process.stdout, 'write', () => true)
  mockExit(t)

  const sessionsDir = await ensureRpgSessionsDir(rpgDir)
  await saveSession(sessionsDir, '2026-01-01T00-00-00', {
    model: 'org/model',
    providerName: 'openrouter',
    providerType: 'openrouter',
    reasoningEffort: 'medium',
    temperature: 0.9,
    topP: 0.8,
    budget: 5,
    webSearch: 'auto',
    webResults: null,
    pricing: { prompt: 1e-6, completion: 2e-6 },
    contextLength: 64000,
    supportsReasoning: true,
    webSearchSupported: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    messages: [
      { role: 'system', content: 'You are Kael.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'The gate creaks open.' },
    ],
  })

  const { exited } = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir, resume: true, model: undefined },
    systemPrompt: 'RPG system prompt',
    // cli-main resolves the chapter and passes its turns + identity through.
    rpgHistory: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'The gate creaks open.' },
    ],
    rpgResume: {
      modelId: 'org/model',
      providerName: 'openrouter',
      providerType: 'openrouter',
      reasoningEffort: 'medium',
      temperature: 0.9,
      topP: 0.8,
      budget: 5,
      webSearch: 'auto',
      webSearchSnapshot: 'auto',
      webResults: null,
      pricing: { prompt: 1e-6, completion: 2e-6 },
      contextLength: 64000,
      supportsReasoning: true,
      reasoningMandatory: false,
      webSearchSupported: true,
      visionSupported: false,
      fileSupported: true,
      imageOutputSupported: false,
      isImageModel: false,
      e2ee: false,
      scrapes: 3,
      costSummary: null,
      sessionId: '2026-01-01T00-00-00',
      sessionCreatedAt: '2026-01-01T00:00:00.000Z',
      sessionUpdatedAt: '2026-01-02T00:00:00.000Z',
      turns: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'The gate creaks open.' },
      ],
      rpgDir,
    },
  })

  assert.equal(exited, false)
  // No -m and no TTY picker: the chapter's own model is restored.
  assert.equal(bodies[0].model, 'org/model')
  assert.equal(bodies[0].temperature, 0.9)
  assert.deepEqual(bodies[0].messages.slice(1, 3), [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'The gate creaks open.' },
  ])

  // The chapter keeps its file: the same session id, extended in place.
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  assert.deepEqual(files, ['2026-01-01T00-00-00.json'])
  const saved = JSON.parse(await readFile(join(sessionsDir, '2026-01-01T00-00-00.json'), 'utf-8'))
  assert.equal(saved.createdAt, '2026-01-01T00:00:00.000Z')
  // The chapter got new turns, so the payload must stamp the save time, not
  // the chapter's own updatedAt.
  assert.notEqual(saved.updatedAt, '2026-01-02T00:00:00.000Z')
  assert.ok(Date.parse(saved.updatedAt) > Date.parse('2026-01-02T00:00:00.000Z'))
  assert.deepEqual(saved.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'assistant'])
  // A chapter resume rewrites its own file, so the persisted flat scrape
  // count must survive instead of being reset to this run's own count.
  assert.equal(saved.scrapes, 3)
})

test('one-shot chapter resume keeps the chapter cumulative cost summary', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  const file = await tempConfig(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  t.mock.method(process.stdout, 'write', () => true)
  mockExit(t)

  const pricing = { prompt: 1e-6, completion: 2e-6 }
  const storedUsage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
  const storedTurn = { role: 'assistant', content: 'The gate creaks open.', usage: storedUsage }
  const sessionsDir = await ensureRpgSessionsDir(rpgDir)
  await saveSession(sessionsDir, '2026-02-01T00-00-00', {
    model: 'org/model',
    providerName: 'openrouter',
    providerType: 'openrouter',
    pricing,
    contextLength: 64000,
    scrapes: 2,
    costSummary: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    messages: [
      { role: 'system', content: 'You are Kael.' },
      { role: 'user', content: 'Hello' },
      storedTurn,
    ],
  })

  const { exited } = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir, resume: true, model: undefined },
    systemPrompt: 'RPG system prompt',
    rpgHistory: [{ role: 'user', content: 'Hello' }, storedTurn],
    rpgResume: {
      modelId: 'org/model',
      providerName: 'openrouter',
      providerType: 'openrouter',
      pricing,
      contextLength: 64000,
      e2ee: false,
      scrapes: 2,
      costSummary: null,
      sessionId: '2026-02-01T00-00-00',
      sessionCreatedAt: '2026-02-01T00:00:00.000Z',
      sessionUpdatedAt: '2026-02-02T00:00:00.000Z',
      turns: [{ role: 'user', content: 'Hello' }, storedTurn],
      rpgDir,
    },
    // This run also scrapes a page: the chapter's two flat $0.01s must survive
    // the rewrite and the new one must be added on top.
    scraped: { url: 'https://example.com/article', content: '# Article body' },
  })

  assert.equal(exited, false)
  const saved = JSON.parse(await readFile(join(sessionsDir, '2026-02-01T00-00-00.json'), 'utf-8'))
  // The chapter's own usage and flat scrape cost stay in the totals instead of
  // being replaced by this run alone (the mocked stream reports 10/5/15).
  assert.equal(saved.costSummary.requests, 2)
  assert.equal(saved.costSummary.promptTokens, 1010)
  assert.equal(saved.costSummary.completionTokens, 505)
  assert.equal(saved.costSummary.totalTokens, 1515)
  assert.equal(saved.costSummary.scrapes, 3)
  // 0.002 stored + 0.00002 this turn + 0.03 for the three scrapes.
  assert.ok(Math.abs(saved.costSummary.cost - 0.03202) < 1e-9, `saw ${saved.costSummary.cost}`)
  // The flat count and its summary must agree: the divergence this fix removes.
  assert.equal(saved.scrapes, saved.costSummary.scrapes)
})

test('one-shot appends the RPG post-history instruction after the user message without persisting it', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  const file = await tempConfig(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  t.mock.method(process.stdout, 'write', () => true)
  mockExit(t)

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  let before = new Set()
  try {
    before = new Set((await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.')))
  } catch {
    // No sessions exist yet; the new one below is the only file.
  }

  const { exited } = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir },
    systemPrompt: 'RPG system prompt',
    rpgFirstMessage: 'The gate creaks open.',
    rpgPostHistoryInstruction: 'Stay in character.',
  })

  assert.equal(exited, false)
  assert.equal(bodies.length, 1)
  assert.deepEqual(bodies[0].messages[3], { role: 'system', content: 'Stay in character.' })

  // RPG chapters keep their own session store in the RPG folder; the global
  // sessions dir must not receive them, and history.json is never written.
  const rpgSessionsDir = join(rpgDir, 'sessions')
  const created = (await readdir(rpgSessionsDir))
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  assert.equal(created.length, 1)
  assert.equal(await readdir(sessionsDir).then((f) => f.filter((x) => x.endsWith('.json') && !x.startsWith('.') && !before.has(x)).length).catch(() => 0), 0)
  const saved = JSON.parse(await readFile(join(rpgSessionsDir, created[0]), 'utf-8'))
  assert.deepEqual(saved.messages.map((m) => m.content), [
    'RPG system prompt',
    'The gate creaks open.',
    'Hello',
    'Hello world',
  ])
  assert.deepEqual(saved.messages.map((m) => m.role), ['system', 'assistant', 'user', 'assistant'])
  assert.ok(!saved.messages.some((m) => m.role === 'system' && m.content === 'Stay in character.'))
})

test('one-shot sends no post-history message when none is provided', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  const file = await tempConfig(t)
  t.mock.method(process.stdout, 'write', () => true)
  mockExit(t)

  const { exited } = await runOneShot(t, {
    overrides: { config: file },
    systemPrompt: 'RPG system prompt',
    rpgFirstMessage: 'The gate creaks open.',
  })

  assert.equal(exited, false)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].messages.length, 3)
  assert.deepEqual(bodies[0].messages[2], { role: 'user', content: 'Hello' })
})

// The prompt log is an artifact the run was asked for, so the run must not
// return — and the process must not exit — before the append has landed: every
// exit path awaits the log chain (src/rpg.js `flushRpgPromptLog`). Holding that
// one append open past the whole run makes the assertion deterministic: a run
// that returned without flushing finds no file at all, not a file that a poll
// eventually sees.
test('one-shot --rpg --debug does not return before the prompt log has landed', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  const file = await tempConfig(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  mockPipedStdout(t)
  t.mock.method(console, 'error', () => {})
  mockExit(t)
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const { exited } = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir, debug: true },
    systemPrompt: 'RPG system prompt',
    rpgFirstMessage: 'The gate creaks open.',
  })

  assert.equal(exited, false)
  const lines = (await readFile(join(rpgDir, 'prompt-log.jsonl'), 'utf-8')).trim().split('\n')
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]).request, bodies[0])
})

test('one-shot with --rpg --debug logs the request body to prompt-log.jsonl', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  const file = await tempConfig(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  t.mock.method(process.stdout, 'write', () => true)
  const errors = []
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  mockExit(t)
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const { exited } = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir, debug: true },
    systemPrompt: 'RPG system prompt',
    rpgFirstMessage: 'The gate creaks open.',
  })

  assert.equal(exited, false)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].messages[0].content, 'RPG system prompt')

  // The append is held open (see the pin above), and the run still returns with
  // both the file and its debug notice in place.
  const raw = await readFile(join(rpgDir, 'prompt-log.jsonl'), 'utf-8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.ok(entry.timestamp)
  assert.equal(entry.model, 'test/model-a')
  assert.equal(entry.provider, 'openrouter')
  assert.deepEqual(entry.request, bodies[0])
  assert.ok(errors.some((line) => line.includes('prompt logged:') && line.includes('prompt-log.jsonl')))
})

// Every file under a directory (recursive), or null when it does not exist -
// the shape a --no-save run must reproduce exactly.
async function listFiles(dir) {
  try {
    return (await readdir(dir, { recursive: true })).map(String).sort()
  } catch {
    return null
  }
}

test('one-shot --no-save leaves the sessions dir, the prefs file and the RPG dir untouched', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  withStdoutTTY(t, false)
  const file = await tempConfig(t)
  await writeFile(file, JSON.stringify({ budget: 5 }, null, 2) + '\n')
  const prefsBefore = await readFile(file, 'utf-8')
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  const rpgSessions = await ensureRpgSessionsDir(rpgDir)
  const globalSessions = await ensureSessionsDir()
  const sessionsBefore = await listFiles(globalSessions)
  const rpgBefore = await listFiles(rpgDir)
  const writes = []
  t.mock.method(process.stdout, 'write', (chunk) => { writes.push(String(chunk)); return true })
  mockExit(t)

  const { exited } = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir, save: false },
    rpgHistory: [{ role: 'user', content: 'Hello' }],
  })

  assert.equal(exited, false)
  // The run itself is unchanged: one request, and the answer still streams.
  assert.equal(bodies.length, 1)
  assert.ok(writes.join('').includes('Hello world'))
  // Nothing was left behind: no session file (and no 0-byte claim), no chapter
  // in the RPG dir, no prefs write.
  assert.deepEqual(await listFiles(globalSessions), sessionsBefore)
  assert.deepEqual(await listFiles(rpgDir), rpgBefore)
  assert.ok(!(await listFiles(rpgSessions)).some((f) => f.endsWith('.json')))
  assert.equal(await readFile(file, 'utf-8'), prefsBefore)
})

test('one-shot --no-save still writes the prompt log --debug asked for', async (t) => {
  const bodies = []
  mockOpenRouterStream(t, [], bodies)
  withApiKey(t)
  withStdoutTTY(t, false)
  const file = await tempConfig(t)
  await writeFile(file, JSON.stringify({ budget: 5 }, null, 2) + '\n')
  const prefsBefore = await readFile(file, 'utf-8')
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  const rpgSessions = await ensureRpgSessionsDir(rpgDir)
  const globalSessions = await ensureSessionsDir()
  const sessionsBefore = await listFiles(globalSessions)
  t.mock.method(process.stdout, 'write', () => true)
  const errors = []
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  mockExit(t)
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const { exited } = await runOneShot(t, {
    overrides: { config: file, rpg: rpgDir, save: false, debug: true },
    rpgHistory: [{ role: 'user', content: 'Hello' }],
  })

  assert.equal(exited, false)
  // --debug is an explicit request for a log, so --no-save still writes it: the
  // flag governs the saved session state (session file, chapter, prefs), not
  // the artifacts the run was asked to produce. This return path flushes the
  // log chain too, so the read below needs no wait even with the append held
  // open (see the pin above).
  const logged = (await readFile(join(rpgDir, 'prompt-log.jsonl'), 'utf-8')).trim().split('\n')
  assert.equal(logged.length, 1)
  assert.deepEqual(JSON.parse(logged[0]).request, bodies[0])
  assert.ok(errors.some((line) => line.includes('prompt logged:')))
  assert.deepEqual(await listFiles(globalSessions), sessionsBefore)
  assert.ok(!(await listFiles(rpgSessions)).some((f) => f.endsWith('.json')))
  assert.equal(await readFile(file, 'utf-8'), prefsBefore)
})

test('one-shot ignores a legacy prefs.budget entirely', async (t) => {
  const fetchCalls = []
  mockOpenRouterStream(t, fetchCalls)
  withApiKey(t)
  mockPipedStdout(t)
  const file = await tempConfig(t)

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const before = new Set((await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.')))

  const zero = await runOneShot(t, { overrides: { config: file }, prefs: { budget: 0 } })
  assert.equal(zero.exited, false)
  const negative = await runOneShot(t, { overrides: { config: file }, prefs: { budget: -1 } })
  assert.equal(negative.exited, false)
  const garbage = await runOneShot(t, { overrides: { config: file }, prefs: { budget: 'abc' } })
  assert.equal(garbage.exited, false)
  const configured = await runOneShot(t, { overrides: { config: file }, prefs: { budget: 5 } })
  assert.equal(configured.exited, false)
  assert.ok(fetchCalls.some((u) => u.includes('/chat/completions')))

  const created = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.') && !before.has(f))
  assert.equal(created.length, 4)
  for (const f of created) {
    const saved = JSON.parse(await readFile(join(sessionsDir, f), 'utf-8'))
    assert.equal(saved.budget, null)
  }
})

test('one-shot without a prompt errors before any API call', async (t) => {
  mockOpenRouterStream(t)
  withApiKey(t)
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original)
    else delete process.stdin.isTTY
  })
  const getExitCode = mockExit(t)

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await assert.rejects(
    oneShotCmd({ apiKey: 'test-key', opts: opts(), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: '' }),
    (e) => e instanceof CliError && /no prompt provided/.test(e.message) && e.exitCode === 1
  )
  assert.equal(getExitCode(), null)
})

test('one-shot with --zdr sends provider.zdr in the request body', async (t) => {
  const bodies = []
  const models = [{ id: 'test/model-a', name: 'Model A', context_length: 1000, description: 'd', reasoning: null }]
  const endpoints = [{
    provider_name: 'ProviderX',
    tag: 't',
    status: 'available',
    uptime_last_30m: null,
    pricing: { prompt: 1e-6, completion: 2e-6 },
    context_length: 1000,
    max_completion_tokens: null,
    supported_parameters: {},
  }]
  const stream = [
    event({ choices: [{ delta: { content: 'Hello' } }] }),
    event({ choices: [{ delta: {}, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }] }),
    'data: [DONE]\n\n',
  ]
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/chat/completions')) {
      bodies.push(JSON.parse(opts.body))
      return sseResponse(stream)
    }
    if (String(url).includes('/endpoints/zdr')) {
      return jsonResponse({ data: [{ provider_name: 'ProviderX', tag: 't', model_id: 'test/model-a' }] })
    }
    if (String(url).includes('/endpoints')) return jsonResponse({ data: { endpoints } })
    return jsonResponse({ data: models })
  })
  withApiKey(t)
  mockPipedStdout(t)
  const file = await tempConfig(t)
  mockExit(t)
  resetMetadataCaches()

  const { exited } = await runOneShot(t, { overrides: { config: file, zdr: true } })

  assert.equal(exited, false)
  assert.equal(bodies.length, 1)
  assert.deepEqual(bodies[0].provider, { order: ['ProviderX'], allow_fallbacks: false, zdr: true })
})

test('one-shot rejects piped stdin over the 10MB limit', async (t) => {
  mockOpenRouterStream(t)
  withApiKey(t)
  const originalStdin = process.stdin
  const stdinMock = Readable.from([Buffer.alloc(11 * 1024 * 1024)])
  Object.defineProperty(process, 'stdin', { value: stdinMock, configurable: true })
  t.after(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
  })

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await assert.rejects(
    oneShotCmd({ apiKey: 'test-key', opts: opts(), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: '' }),
    (e) => e instanceof CliError && /exceeds the 10MB limit/.test(e.message)
  )
})

test('one-shot reads the prompt from piped stdin when no prompt is given', async (t) => {
  mockOpenRouterStream(t)
  withApiKey(t)
  const originalStdin = process.stdin
  const stdinMock = Readable.from([Buffer.from('Hello from stdin')])
  Object.defineProperty(process, 'stdin', { value: stdinMock, configurable: true })
  t.after(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
  })
  const file = await tempConfig(t)
  const writes = mockPipedStdout(t)
  mockExit(t)

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await oneShotCmd({ apiKey: 'test-key', opts: opts({ config: file }), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: '' })

  assert.ok(writes.join('').includes('Hello world'))
  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  const matches = []
  for (const f of files) {
    const saved = JSON.parse(await readFile(join(sessionsDir, f), 'utf-8'))
    if (saved.messages.some((m) => m.role === 'user' && m.content === 'Hello from stdin')) matches.push(saved)
  }
  assert.equal(matches.length, 1)
})

test('one-shot SIGINT during a --rpg --debug request flushes the prompt log and exits 130', async (t) => {
  const models = [{ id: 'test/model-a', name: 'Model A', context_length: 1000, description: 'd', reasoning: null }]
  const endpoints = [{
    provider_name: 'ProviderX',
    tag: 't',
    status: 'available',
    uptime_last_30m: null,
    pricing: { prompt: 1e-6, completion: 2e-6 },
    context_length: 1000,
    max_completion_tokens: null,
    supported_parameters: {},
  }]
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  let dispatch
  const dispatched = new Promise((resolve) => { dispatch = resolve })
  const bodies = []
  const fetchCalls = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls.push(String(url))
    if (String(url).includes('/chat/completions')) {
      opts.signal.addEventListener('abort', () => {
        rejectCompletion(Object.assign(new Error('aborted'), { pendingBuffer: 'data: {"choices":[{"delta":{"content":"Hel' }))
      })
      // The prompt-log append is issued while the body is built, right before
      // this fetch: only interrupt a request that is really out (see the pin).
      if (opts.body) bodies.push(JSON.parse(opts.body))
      dispatch()
      return pending
    }
    if (String(url).includes('/endpoints')) return jsonResponse({ data: { endpoints } })
    return jsonResponse({ data: models })
  })
  withApiKey(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  const getExitCode = mockExit(t)
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  let sigintHandler = null
  let handlerReady
  const handlerSet = new Promise((resolve) => { handlerReady = resolve })
  const originalOn = process.on.bind(process)
  const originalOff = process.off.bind(process)
  t.mock.method(process, 'on', (event, fn) => {
    if (event === 'SIGINT') {
      sigintHandler = fn
      handlerReady()
    }
    return originalOn(event, fn)
  })
  t.mock.method(process, 'off', (event, fn) => originalOff(event, fn))

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  const run = oneShotCmd({ apiKey: 'test-key', opts: opts({ rpg: rpgDir, debug: true }), prefs: {}, systemPrompt: 'RPG system prompt', rpgFirstMessage: 'The gate creaks open.', providerType: 'openrouter', prompt: 'Hello' })
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('SIGINT handler never registered')), 5000))
  await Promise.race([handlerSet, timeout])
  await dispatched
  assert.ok(sigintHandler !== null)
  sigintHandler()

  await assert.rejects(run, (e) => e instanceof ExitSignal && e.code === 130)
  assert.equal(getExitCode(), 130)
  assert.ok(errors.some((e) => e.includes('Interrupted.')))
  // The interrupt path awaits the log chain before its process.exit(130), with
  // the append held open by the pin above: an exit that skipped the flush would
  // find no file at all here (this test fails with ENOENT without it).
  const logged = (await readFile(join(rpgDir, 'prompt-log.jsonl'), 'utf-8')).trim().split('\n')
  assert.equal(logged.length, 1)
  assert.deepEqual(JSON.parse(logged[0]).request, bodies[0])
})

// The failed-request half of the same catch: the rethrow happens after the
// flush (the caller prints it and exits 1), so the log is on disk by the time
// the run rejects.
test('one-shot --rpg --debug flushes the prompt log before a failed request rethrows', async (t) => {
  resetOpenRouterModelCaches()
  const models = [{ id: 'test/model-a', name: 'Model A', context_length: 1000, description: 'd', reasoning: null }]
  const endpoints = [{
    provider_name: 'ProviderX',
    tag: 't',
    status: 'available',
    uptime_last_30m: null,
    pricing: { prompt: 1e-6, completion: 2e-6 },
    context_length: 1000,
    max_completion_tokens: null,
    supported_parameters: {},
  }]
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/chat/completions')) {
      if (opts.body) bodies.push(JSON.parse(opts.body))
      return jsonResponse({ error: { message: 'bad request' } }, 400)
    }
    if (String(url).includes('/endpoints')) return jsonResponse({ data: { endpoints } })
    return jsonResponse({ data: models })
  })
  withApiKey(t)
  const rpgDir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(rpgDir, { recursive: true, force: true }))
  t.mock.method(console, 'error', () => {})
  const getExitCode = mockExit(t)
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const { exited, exitCode, message } = await runOneShot(t, {
    overrides: { rpg: rpgDir, debug: true },
    systemPrompt: 'RPG system prompt',
    rpgFirstMessage: 'The gate creaks open.',
  })

  assert.equal(exited, true)
  assert.equal(exitCode, 1)
  assert.match(message, /OpenRouter request failed \(400\)/)
  assert.equal(getExitCode(), null)
  assert.equal(bodies.length, 1)
  const logged = (await readFile(join(rpgDir, 'prompt-log.jsonl'), 'utf-8')).trim().split('\n')
  assert.equal(logged.length, 1)
  assert.deepEqual(JSON.parse(logged[0]).request, bodies[0])
})


test('one-shot TTY output prints the banner, sources and the skipped-chunk warning', async (t) => {
  const models = [{ id: 'test/model-a', name: 'Model A', context_length: 1000, description: 'd', reasoning: null }]
  const endpoints = [{
    provider_name: 'ProviderX',
    tag: 't',
    status: 'available',
    uptime_last_30m: null,
    pricing: { prompt: 1e-6, completion: 2e-6 },
    context_length: 1000,
    max_completion_tokens: null,
    supported_parameters: {},
  }]
  const stream = [
    event({ choices: [{ delta: { content: 'Hello' } }] }),
    'data: {not-json}\n\n',
    event({ choices: [{ delta: { content: ' world' } }] }),
    event({ choices: [{ delta: { annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com', title: 'Example' } }] } }] }),
    event({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    'data: [DONE]\n\n',
  ]
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/chat/completions')) return sseResponse(stream)
    if (String(url).includes('/endpoints')) return jsonResponse({ data: { endpoints } })
    return jsonResponse({ data: models })
  })
  withApiKey(t)
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original)
    else delete process.stdout.isTTY
  })
  const writes = mockPipedStdout(t)
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  mockExit(t)

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await oneShotCmd({ apiKey: 'test-key', opts: opts({ temperature: 1.1, topP: 0.7 }), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: 'Hello' })

  const banner = logs.find((l) => l.includes('ProviderX / test/model-a'))
  assert.ok(banner, 'banner line printed')
  assert.ok(banner.includes(`${dim('[temp: ')}1.1${dim(']')}`), 'temp badge dim-keyed')
  assert.ok(banner.includes(`${dim('[top-p: ')}0.7${dim(']')}`), 'top-p badge dim-keyed')
  assert.ok(writes.some((w) => w.includes('Hello world')))
  assert.ok(writes.some((w) => w.includes('Sources (1)')))
  assert.ok(writes.some((w) => w.includes('1 malformed stream chunk skipped')))

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  for (const f of files) {
    const saved = JSON.parse(await readFile(join(sessionsDir, f), 'utf-8'))
    assert.equal(saved.contextLength, 1000)
  }
  assert.ok(!logs.some((l) => l.includes('CTX')))

  // A run without --config persists its prefs to the default path under the
  // mocked home. If the node:os mock ever stops applying, these land in the
  // real ~/.communicator.json instead and the assertion fails.
  const prefs = JSON.parse(await readFile(join(tempHome, '.communicator.json'), 'utf-8'))
  assert.equal(prefs.temperature['test/model-a'], 1.1)
  assert.equal(prefs.topP['test/model-a'], 0.7)
})

const IMAGE_BYTES = Buffer.from('one-shot image')
const IMAGE_B64 = IMAGE_BYTES.toString('base64')

function mockVeniceImageFetch(t, fetchCalls = []) {
  resetVeniceModelCaches()
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url)
    fetchCalls.push(u)
    if (u.includes('/models?type=text')) {
      return jsonResponse({ data: [] })
    }
    if (u.includes('/models?type=image')) {
      return jsonResponse({ data: [
        {
          id: 'venice-sd35',
          model_spec: {
            name: 'SD 3.5',
            constraints: {},
            pricing: { generation: { usd: 0.02 } },
          },
        },
        {
          id: 'bria-bg-remover',
          model_spec: {
            name: 'Background Remover',
            constraints: { widthHeightDivisor: 1 },
            pricing: { generation: { usd: 0.03 }, upscale: { '2x': { usd: 0.02 }, '4x': { usd: 0.08 } } },
          },
        },
      ] })
    }
    if (u.includes('/image/generate')) {
      bodies.push(JSON.parse(opts.body))
      return jsonResponse({ id: 'gen-1', images: [IMAGE_B64], timing: {} })
    }
    throw new Error(`unexpected fetch: ${u}`)
  })
  return { bodies, fetchCalls }
}

test('one-shot with a scraped page injects it as the first user message and persists the scrape count', async (t) => {
  resetVeniceModelCaches()
  mockPipedStdout(t)
  const models = [{ id: 'venice-model', model_spec: { name: 'V', capabilities: {}, constraints: {} } }]
  const stream = [
    event({ choices: [{ delta: { content: 'Summary' } }] }),
    event({ choices: [{ delta: {}, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }] }),
    'data: [DONE]\n\n',
  ]
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/augment/scrape')) return jsonResponse({ url: 'https://example.com/article', content: '# Article body', format: 'markdown' })
    if (u.includes('/chat/completions')) return sseResponse(stream)
    if (u.includes('/models?type=text')) return jsonResponse({ data: models })
    throw new Error(`unexpected fetch: ${u}`)
  })
  const file = await tempConfig(t)
  mockExit(t)
  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const before = new Set((await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.')))

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await oneShotCmd({
    apiKey: 'venice-key',
    opts: opts({ model: 'venice-model', config: file }),
    prefs: {},
    systemPrompt: null,
    providerType: 'venice',
    prompt: 'Summarize',
    scraped: { url: 'https://example.com/article', content: '# Article body' },
  })

  assert.ok(!calls.some((u) => u.includes('/augment/scrape')), 'the scrape itself happens before one-shot dispatch')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.') && !before.has(f))
  assert.equal(files.length, 1)
  const saved = JSON.parse(await readFile(join(sessionsDir, files[0]), 'utf-8'))
  assert.equal(saved.scrapes, 1)
  assert.equal(saved.providerType, 'venice')
  assert.equal(saved.messages.length, 4)
  assert.equal(saved.messages[1].role, 'user')
  assert.equal(saved.messages[1].content, 'Scraped from https://example.com/article:\n\n# Article body')
  assert.equal(saved.messages[2].content, 'Summarize')
  assert.equal(saved.messages[3].content, 'Summary')
})

test('-m with an image model id routes to one-shot image generation', async (t) => {
  const { bodies, fetchCalls } = mockVeniceImageFetch(t)
  const file = await tempConfig(t)
  const writes = mockPipedStdout(t)
  t.mock.method(console, 'log', () => {})

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  await ensureSessionsDir()
  const before = new Set((await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.')))

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await oneShotCmd({ apiKey: 'venice-key', opts: opts({ model: 'venice-sd35', config: file }), prefs: {}, systemPrompt: null, providerType: 'venice', prompt: 'a red cat' })

  assert.ok(fetchCalls.every((u) => !u.includes('/chat/completions')), fetchCalls.join('\n'))
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].model, 'venice-sd35')
  assert.equal(bodies[0].prompt, 'a red cat')
  assert.ok(writes.some((w) => w.includes('saved to ')), writes.join('\n'))

  const created = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.') && !before.has(f))
  assert.equal(created.length, 1)
  const saved = JSON.parse(await readFile(join(sessionsDir, created[0]), 'utf-8'))
  assert.equal(saved.model, 'venice-sd35')
  assert.equal(saved.providerType, 'venice')
  assert.equal(saved.messages.length, 3)
  assert.equal(saved.messages[0].role, 'system')
  assert.equal(saved.messages[1].role, 'user')
  assert.equal(saved.messages[1].content, 'a red cat')
  assert.equal(saved.messages[2].role, 'assistant')
  assert.equal(saved.messages[2].content[0].type, 'image_url')

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastImageModel, 'venice-sd35')
})

test('-m with an image model rejects --attach before any generation', async (t) => {
  const { bodies, fetchCalls } = mockVeniceImageFetch(t)

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await assert.rejects(
    oneShotCmd({ apiKey: 'venice-key', opts: opts({ model: 'venice-sd35', attach: ['photo.png'] }), prefs: {}, systemPrompt: null, providerType: 'venice', prompt: 'a red cat' }),
    (e) => e instanceof CliError && e.message === 'Error: --attach is not supported with image models.'
  )
  assert.equal(bodies.length, 0)
  assert.ok(fetchCalls.every((u) => !u.includes('/image/generate')))
})

test('-m with the Venice utility model id fails on the not-found path without a generation call', async (t) => {
  const { bodies, fetchCalls } = mockVeniceImageFetch(t)

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await assert.rejects(
    oneShotCmd({ apiKey: 'venice-key', opts: opts({ model: 'bria-bg-remover' }), prefs: {}, systemPrompt: null, providerType: 'venice', prompt: 'a red cat' }),
    (e) => e instanceof CliError && e.message === 'Error: model bria-bg-remover not found. Use --list-models to see available models.'
  )
  assert.equal(bodies.length, 0)
  assert.ok(fetchCalls.every((u) => !u.includes('/image/generate')), fetchCalls.join('\n'))
})

test('Ctrl+C at the picker in one-shot (TTY, no -m) propagates ExitPromptError', async (t) => {
  mockOpenRouterStream(t)
  withApiKey(t)
  const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  t.after(() => {
    if (originalTTY) Object.defineProperty(process.stdin, 'isTTY', originalTTY)
    else delete process.stdin.isTTY
  })

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await assert.rejects(
    oneShotCmd({ apiKey: 'test-key', opts: opts({ model: undefined }), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: 'Hello' }),
    (e) => e instanceof ExitPromptError
  )
})


function mockMandatoryReasoningFetch(t, bodies = []) {
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/chat/completions')) {
      if (opts?.body) bodies.push(JSON.parse(opts.body))
      return sseResponse([event({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
    }
    if (String(url).includes('/endpoints')) {
      return jsonResponse({ data: [{ provider_name: 'ProviderX', tag: 't', status: 'available', pricing: { prompt: 1e-6, completion: 2e-6 }, context_length: 1000, supported_parameters: ['reasoning'] }] })
    }
    return jsonResponse({ data: [{ id: 'test/model-mandatory', name: 'Mandatory', context_length: 1000, description: 'd', reasoning: { supported: true, supported_efforts: ['high'], default_effort: 'high', mandatory: true } }] })
  })
}

test('one-shot never sends a disable reasoning body for mandatory-reasoning models', async (t) => {
  resetOpenRouterModelCaches()
  const bodies = []
  mockMandatoryReasoningFetch(t, bodies)
  withApiKey(t)
  withStdoutTTY(t, false)
  const { logs, errors } = captureConsole(t)
  t.mock.method(process.stdout, 'write', () => {})

  const { exited } = await runOneShot(t, { overrides: { model: 'test/model-mandatory', reasoningEffort: 'none' }, prompt: 'Hello' })

  assert.equal(exited, false)
  assert.ok(!('reasoning' in bodies[0]))
  assert.ok(!logs.some((l) => l.includes('reasoning is mandatory for test/model-mandatory')), 'the note must stay off piped stdout')
  assert.ok(errors.some((l) => l.includes('reasoning is mandatory for test/model-mandatory')))
})

test('the mandatory-reasoning note prints on stdout on a terminal', async (t) => {
  resetOpenRouterModelCaches()
  mockMandatoryReasoningFetch(t)
  withApiKey(t)
  withStdoutTTY(t, true)
  const { logs, errors } = captureConsole(t)
  t.mock.method(process.stdout, 'write', () => {})

  const { exited } = await runOneShot(t, { overrides: { model: 'test/model-mandatory', reasoningEffort: 'none' }, prompt: 'Hello' })

  assert.equal(exited, false)
  assert.ok(logs.some((l) => l.includes('reasoning is mandatory for test/model-mandatory')))
  assert.ok(!errors.some((l) => l.includes('reasoning is mandatory for test/model-mandatory')), 'the note belongs on stdout on a terminal')
})
