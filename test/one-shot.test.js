import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    if (e instanceof ExitSignal) return { exited: true }
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

test('one-shot budget pre-check refuses an already-exhausted budget before any request', async (t) => {
  const fetchCalls = []
  mockOpenRouterStream(t, fetchCalls)
  withApiKey(t)
  const file = await tempConfig(t)
  const out = []
  const err = []
  t.mock.method(console, 'error', (msg) => err.push(String(msg)))
  t.mock.method(console, 'log', (msg) => out.push(String(msg)))
  const getExitCode = mockExit(t)

  const { exited } = await runOneShot(t, { overrides: { config: file }, prefs: { budget: 0 } })

  assert.equal(exited, true)
  assert.equal(getExitCode(), 1)
  assert.equal(err[0], 'Error: Budget exhausted ($0.000000 of $0.000000).')
  assert.ok(!fetchCalls.some((u) => u.includes('/chat/completions')))
  assert.equal(out.length, 0)
})

test('one-shot with a negative configured budget is refused too', async (t) => {
  mockOpenRouterStream(t)
  withApiKey(t)
  const file = await tempConfig(t)
  const err = []
  t.mock.method(console, 'error', (msg) => err.push(String(msg)))
  const getExitCode = mockExit(t)

  const { exited } = await runOneShot(t, { overrides: { config: file }, prefs: { budget: -1 } })

  assert.equal(exited, true)
  assert.equal(getExitCode(), 1)
  assert.match(err[0], /Budget exhausted/)
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
  const err = []
  t.mock.method(console, 'error', (msg) => err.push(String(msg)))
  const getExitCode = mockExit(t)

  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  await assert.rejects(
    oneShotCmd({ apiKey: 'test-key', opts: opts(), prefs: {}, systemPrompt: null, providerType: 'openrouter', prompt: '' }),
    (e) => e instanceof ExitSignal
  )
  assert.equal(getExitCode(), 1)
  assert.match(err[0], /no prompt provided/)
})
