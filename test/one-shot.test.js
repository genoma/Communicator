import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../src/errors.js'
import { resetMetadataCaches } from '../src/providers/openrouter-meta.js'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

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

function mockOpenRouterStream(t, fetchCalls = []) {
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
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetchCalls.push(String(url))
    if (String(url).includes('/chat/completions')) return sseResponse(stream)
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

async function runOneShot(t, { overrides = {}, prefs = {}, prompt = 'Hello' } = {}) {
  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  try {
    await oneShotCmd({ apiKey: 'test-key', opts: opts(overrides), prefs, systemPrompt: null, providerType: 'openrouter', prompt })
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
  const originalOn = process.on.bind(process)
  const originalOff = process.off.bind(process)
  t.mock.method(process, 'on', (event, fn) => {
    if (event === 'SIGINT') sigintHandler = fn
    return originalOn(event, fn)
  })
  t.mock.method(process, 'off', (event, fn) => originalOff(event, fn))

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  const run = oneShotCmd({ apiKey: 'test-key', opts: opts(), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: 'Hello' })
  for (let i = 0; i < 100 && sigintHandler === null; i++) {
    await new Promise((r) => setImmediate(r))
  }
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
  await oneShotCmd({ apiKey: 'test-key', opts: opts(), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: 'Hello' })

  assert.ok(logs.some((l) => l.includes('Connected to ProviderX')))
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

