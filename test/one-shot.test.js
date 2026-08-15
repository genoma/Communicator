import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExitPromptError } from '@inquirer/core'
import { CliError } from '../src/errors.js'
import { resetMetadataCaches } from '../src/providers/openrouter-meta.js'

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
  const stream = [
    event({ choices: [{ delta: { content: 'Hello' } }] }),
    event({ choices: [{ delta: { content: ' world' } }] }),
    event({ choices: [{ delta: {}, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }] }),
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

const BASE_OPTS = {
  model: 'test/model-a',
  temperature: undefined,
  budget: undefined,
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

async function runOneShot(t, { overrides = {}, prefs = {}, prompt = 'Hello', systemPrompt = null, rpgFirstMessage = null, rpgHistory = null } = {}) {
  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  try {
    await oneShotCmd({ apiKey: 'test-key', opts: opts(overrides), prefs, systemPrompt, rpgFirstMessage, rpgHistory, providerType: 'openrouter', prompt })
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
  const writes = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  t.mock.method(process.stdout, 'write', function (chunk, ...rest) {
    writes.push(String(chunk))
    return originalWrite(chunk, ...rest)
  })
  const getExitCode = mockExit(t)

  const { exited } = await runOneShot(t, { overrides: { config: file }, prefs: { budget: 5 } })

  assert.equal(exited, false)
  assert.equal(getExitCode(), null)

  const answerWrites = writes.filter((w) => w.includes('Hello world'))
  assert.ok(answerWrites.length >= 1)
  assert.ok(writes.some((w) => w === '\n'))

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  assert.equal(files.length, 1)
  const saved = JSON.parse(await readFile(join(sessionsDir, files[0]), 'utf-8'))
  assert.equal(saved.model, 'test/model-a')
  assert.equal(saved.providerName, 'ProviderX')
  assert.equal(saved.providerType, 'openrouter')
  assert.equal(saved.temperature, 0.7)
  assert.equal(saved.budget, 5)
  assert.equal(saved.webSearch, 'off')
  assert.equal(saved.messages.length, 3)
  assert.equal(saved.messages[2].content, 'Hello world')

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastModel, 'test/model-a')
  assert.equal(prefs.lastProvider, 'ProviderX')
  assert.equal(prefs.temperature['test/model-a'], 0.7)
  assert.equal(prefs.budget, 5)
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

test('one-shot seeds the RPG history and appends the exchange to history.json', async (t) => {
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

  const history = JSON.parse(await readFile(join(rpgDir, 'history.json'), 'utf-8'))
  assert.deepEqual(history.messages.map((m) => m.content), [
    'The gate creaks open.',
    'I step through.',
    'Shadows shift ahead.',
    'Hello',
    'Hello world',
  ])
  assert.equal(history.messages[0].role, 'assistant')
  assert.equal(history.messages[4].role, 'assistant')
})

test('one-shot treats an invalid configured budget as unset', async (t) => {
  const fetchCalls = []
  mockOpenRouterStream(t, fetchCalls)
  withApiKey(t)
  const file = await tempConfig(t)

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const before = new Set((await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.')))

  const zero = await runOneShot(t, { overrides: { config: file }, prefs: { budget: 0 } })
  assert.equal(zero.exited, false)
  const negative = await runOneShot(t, { overrides: { config: file }, prefs: { budget: -1 } })
  assert.equal(negative.exited, false)
  const garbage = await runOneShot(t, { overrides: { config: file }, prefs: { budget: 'abc' } })
  assert.equal(garbage.exited, false)
  assert.ok(fetchCalls.some((u) => u.includes('/chat/completions')))

  const created = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.') && !before.has(f))
  assert.equal(created.length, 3)
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
  const writes = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  t.mock.method(process.stdout, 'write', function (chunk, ...rest) {
    writes.push(String(chunk))
    return originalWrite(chunk, ...rest)
  })
  mockExit(t)

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await oneShotCmd({ apiKey: 'test-key', opts: opts({ config: file }), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: '' })

  assert.ok(writes.some((w) => w.includes('Hello world')))
  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  const matches = []
  for (const f of files) {
    const saved = JSON.parse(await readFile(join(sessionsDir, f), 'utf-8'))
    if (saved.messages.some((m) => m.role === 'user' && m.content === 'Hello from stdin')) matches.push(saved)
  }
  assert.equal(matches.length, 1)
})

test('one-shot SIGINT during the request aborts and exits 130', async (t) => {
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
  const fetchCalls = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls.push(String(url))
    if (String(url).includes('/chat/completions')) {
      opts.signal.addEventListener('abort', () => {
        rejectCompletion(Object.assign(new Error('aborted'), { pendingBuffer: 'data: {"choices":[{"delta":{"content":"Hel' }))
      })
      return pending
    }
    if (String(url).includes('/endpoints')) return jsonResponse({ data: { endpoints } })
    return jsonResponse({ data: models })
  })
  withApiKey(t)
  const getExitCode = mockExit(t)
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

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
  const run = oneShotCmd({ apiKey: 'test-key', opts: opts(), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: 'Hello' })
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('SIGINT handler never registered')), 5000))
  await Promise.race([handlerSet, timeout])
  assert.ok(sigintHandler !== null)
  sigintHandler()

  await assert.rejects(run, (e) => e instanceof ExitSignal && e.code === 130)
  assert.equal(getExitCode(), 130)
  assert.ok(errors.some((e) => e.includes('Interrupted.')))
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
  const writes = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  t.mock.method(process.stdout, 'write', function (chunk, ...rest) {
    writes.push(String(chunk))
    return originalWrite(chunk, ...rest)
  })
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  mockExit(t)

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await oneShotCmd({ apiKey: 'test-key', opts: opts({ temperature: 1.1 }), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: 'Hello' })

  assert.ok(logs.some((l) => l.includes('ProviderX / test/model-a') && l.includes('[temp: 1.1]')))
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
      return jsonResponse({ data: [{
        id: 'venice-sd35',
        model_spec: {
          name: 'SD 3.5',
          constraints: {},
          pricing: { generation: { usd: 0.02 } },
        },
      }] })
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
  const writes = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  t.mock.method(process.stdout, 'write', function (chunk, ...rest) {
    writes.push(String(chunk))
    return originalWrite(chunk, ...rest)
  })
  t.mock.method(console, 'log', () => {})

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
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

