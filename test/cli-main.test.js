import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli-main.js'

class ExitSignal {
  constructor(code) {
    this.code = code
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const BASE_OPTS = {
  model: undefined,
  provider: 'openrouter',
  listModels: undefined,
  listEndpoints: undefined,
  resume: undefined,
  export: undefined,
  outputDir: undefined,
  listSessions: undefined,
  config: undefined,
  systemPrompt: undefined,
  reasoningEffort: undefined,
  temperature: undefined,
  budget: undefined,
  webSearch: undefined,
  webResults: undefined,
  smoothStreaming: true,
  smoothSpeed: undefined,
  delete: undefined,
  attach: [],
}

function opts(overrides = {}) {
  return { ...BASE_OPTS, ...overrides }
}

async function runAndExit(t, overrides, promptArg, expectedCode) {
  let exitCode = null
  const out = []
  const err = []
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })
  t.mock.method(console, 'log', (msg) => out.push(String(msg)))
  t.mock.method(console, 'error', (msg) => err.push(String(msg)))
  await assert.rejects(
    runCli(opts(overrides), promptArg),
    (e) => e instanceof ExitSignal && e.code === expectedCode
  )
  return { exitCode, out, err }
}

function withTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original)
    else delete process.stdin.isTTY
  })
}

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  const file = join(dir, 'config.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return file
}

function withApiKey(t, value = 'test-key') {
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  })
}

function mockOpenRouterApi(t) {
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
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/endpoints')) return jsonResponse({ data: { endpoints } })
    return jsonResponse({ data: models })
  })
}

function mockVeniceApi(t) {
  const models = [{
    id: 'venice/model-x',
    model_spec: { name: 'Model X', capabilities: {}, constraints: { max_tokens: 1000 }, availableContextTokens: 1000, pricing: null, description: null },
  }]
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: models }))
}

test('invalid --web-search mode is rejected before any dispatch', async (t) => {
  const { err } = await runAndExit(t, { webSearch: 'bogus' }, undefined, 1)
  assert.match(err[0], /--web-search expects "auto", "always", "on", or "off"/)
})

test('--web-search on is accepted and persisted as auto', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  mockOpenRouterApi(t)
  const file = await tempConfig(t)
  const { out } = await runAndExit(t, { config: file, model: 'test/model-a', webSearch: 'on' }, undefined, 0)
  assert.match(out.join('\n'), /Web search set to auto/)
  const saved = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(saved.webSearch['test/model-a'], 'auto')
})

test('invalid --smooth-speed is rejected before any dispatch', async (t) => {
  const { err } = await runAndExit(t, { smoothSpeed: 'bogus' }, undefined, 1)
  assert.match(err[0], /Smooth speed must be/)
})

test('--resume and --export are mutually exclusive', async (t) => {
  const { err } = await runAndExit(t, { resume: true, export: true }, undefined, 1)
  assert.match(err[0], /Cannot use --resume and --export together/)
})

test('--delete conflicts with --resume', async (t) => {
  const { err } = await runAndExit(t, { delete: true, resume: true }, undefined, 1)
  assert.match(err[0], /Cannot use --delete with --resume or --export/)
})

test('--delete conflicts with --export', async (t) => {
  const { err } = await runAndExit(t, { delete: true, export: true }, undefined, 1)
  assert.match(err[0], /Cannot use --delete with --resume or --export/)
})

test('a prompt argument cannot be combined with --resume', async (t) => {
  const { err } = await runAndExit(t, { resume: true }, 'hello', 1)
  assert.match(err[0], /Cannot combine a prompt argument/)
})

test('a prompt argument cannot be combined with --list-models', async (t) => {
  const { err } = await runAndExit(t, { listModels: true }, 'hello', 1)
  assert.match(err[0], /Cannot combine a prompt argument/)
})

test('interactive flags require a TTY', async (t) => {
  const { err } = await runAndExit(t, { export: true }, undefined, 1)
  assert.match(err[0], /interactive pickers need a TTY/)
})

test('session flags cannot be combined with --list-* flags', async (t) => {
  const { err } = await runAndExit(t, { listModels: true, temperature: '0.5' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --list-\* flags/)
})

test('--model cannot be combined with --list-* flags', async (t) => {
  const { err } = await runAndExit(t, { listModels: true, model: 'x' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --list-\* flags/)
})

test('--output-dir cannot be combined with --list-* flags', async (t) => {
  const { err } = await runAndExit(t, { listEndpoints: 'x', outputDir: '/tmp' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --list-\* flags/)
})

test('session flags cannot be combined with --export', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { export: true, budget: '1' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --export/)
})

test('--model cannot be combined with --export', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { export: true, model: 'x' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --export/)
})

test('session flags cannot be combined with --delete', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { delete: true, webSearch: 'auto' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --delete/)
})

test('--output-dir cannot be combined with --delete', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { delete: true, outputDir: '/tmp' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --delete/)
})

test('--model cannot be combined with --resume', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { resume: true, model: 'x' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --resume/)
})

test('--attach cannot be combined with --resume', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { resume: true, attach: ['a.png'] }, undefined, 1)
  assert.match(err[0], /cannot be combined with --resume/)
  assert.match(err[0], /--attach/)
})

test('--output-dir cannot be combined with --resume', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { resume: true, outputDir: '/tmp' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --resume/)
})

test('standalone --output-dir rejects a prompt argument', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { outputDir: '/tmp' }, 'hello', 1)
  assert.match(err[0], /--output-dir sets the default export directory/)
})

test('standalone --output-dir requires a TTY', async (t) => {
  const { err } = await runAndExit(t, { outputDir: '/tmp' }, undefined, 1)
  assert.match(err[0], /--output-dir sets the default export directory/)
})

test('bare --config cannot be combined with other flags', async (t) => {
  const { err } = await runAndExit(t, { config: true, model: 'x' }, undefined, 1)
  assert.match(err[0], /bare --config \(config view\) cannot be combined/)
})

test('bare --config with --list-models is rejected', async (t) => {
  const { err } = await runAndExit(t, { config: true, listModels: true }, undefined, 1)
  assert.match(err[0], /bare --config \(config view\) cannot be combined/)
})

test('bare --config prints the config file header and exits 0', async (t) => {
  const { out } = await runAndExit(t, { config: true }, undefined, 0)
  assert.match(out[0], /^Config file:/)
})

test('--output-dir alone persists the default export directory', async (t) => {
  withTTY(t, true)
  const file = await tempConfig(t)
  const { out } = await runAndExit(t, { config: file, outputDir: '/tmp/exports' }, undefined, 0)
  assert.match(out[0], /Export directory set to \/tmp\/exports/)
  const saved = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(saved.outputDir, '/tmp/exports')
})

test('--budget alone persists the default budget', async (t) => {
  withTTY(t, true)
  const file = await tempConfig(t)
  const { out } = await runAndExit(t, { config: file, budget: '2' }, undefined, 0)
  assert.match(out[0], /Budget set to \$2/)
  const saved = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(saved.budget, 2)
})

test('--no-smooth-streaming alone persists the default', async (t) => {
  withTTY(t, true)
  const file = await tempConfig(t)
  await runAndExit(t, { config: file, smoothStreaming: false }, undefined, 0)
  const saved = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(saved.smoothStreaming, false)
})

test('per-model setters without --model are rejected', async (t) => {
  withTTY(t, true)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { config: file, temperature: '0.5' }, undefined, 1)
  assert.match(err[0], /require --model <id>/)
})

test('invalid temperature in config-set mode fails gracefully', async (t) => {
  withTTY(t, true)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { config: file, temperature: '3' }, undefined, 1)
  assert.match(err[0], /Temperature must be a number between 0 and 2/)
})

test('--model with a setter validates, persists defaults, and exits 0', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  mockOpenRouterApi(t)
  const file = await tempConfig(t)
  const { out } = await runAndExit(t, { config: file, model: 'test/model-a', temperature: '0.5' }, undefined, 0)
  assert.match(out[0], /Model: test\/model-a via ProviderX/)
  const saved = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(saved.lastModel, 'test/model-a')
  assert.equal(saved.lastProvider, 'ProviderX')
  assert.equal(saved.temperature['test/model-a'], 0.5)
})

test('--model with an unknown id fails gracefully', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  mockOpenRouterApi(t)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { config: file, model: 'nope/x' }, undefined, 1)
  assert.match(err[0], /Model "nope\/x" not found/)
})

test('--web-search default is gated against model support', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  mockVeniceApi(t)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, {
    config: file,
    provider: 'venice',
    model: 'venice/model-x',
    webSearch: 'always',
  }, undefined, 1)
  assert.match(err[0], /does not support web search/)
})

test('bare --list-endpoints requires a TTY', async (t) => {
  const { err } = await runAndExit(t, { listEndpoints: true }, undefined, 1)
  assert.match(err[0], /interactive model selection needs a TTY/)
})

test('--list-endpoints resolves a unique partial id and prints endpoints', async (t) => {
  mockOpenRouterApi(t)
  const { out } = await runAndExit(t, { listEndpoints: 'model-a' }, undefined, 0)
  assert.match(out[0], /1 provider\(s\) for test\/model-a/)
  assert.match(out.join('\n'), /ProviderX/)
})

test('--list-endpoints with an unknown id fails gracefully', async (t) => {
  mockOpenRouterApi(t)
  const { err } = await runAndExit(t, { listEndpoints: 'zzz' }, undefined, 1)
  assert.match(err[0], /Model "zzz" not found/)
})

test('ApiError from exit-mode commands surfaces as a friendly message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 401 }))
  const { err } = await runAndExit(t, { listModels: true }, undefined, 1)
  assert.match(err[0], /Error: Invalid API key/)
})

test('--attach requires a prompt argument or piped stdin', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { attach: ['a.png'] }, undefined, 1)
  assert.match(err[0], /--attach requires a prompt argument or piped stdin/)
})

test('--attach without a TTY passes the requires-prompt guard (no piped-stdin error)', async (t) => {
  const { err } = await runAndExit(t, { attach: ['a.png'] }, undefined, 1)
  assert.doesNotMatch(err[0], /--attach requires a prompt argument/)
  assert.match(err[0], /Interactive selection needs a TTY/)
})

test('--attach cannot be combined with --list-* flags', async (t) => {
  const { err } = await runAndExit(t, { attach: ['a.png'], listModels: true }, undefined, 1)
  assert.match(err[0], /cannot be combined with --list-\* flags/)
  assert.match(err[0], /--attach/)
})

test('--attach cannot be combined with --export', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { attach: ['a.png'], export: true }, undefined, 1)
  assert.match(err[0], /cannot be combined with --export/)
  assert.match(err[0], /--attach/)
})

test('--attach cannot be combined with --delete', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { attach: ['a.png'], delete: true }, undefined, 1)
  assert.match(err[0], /cannot be combined with --delete/)
  assert.match(err[0], /--attach/)
})

test('--attach cannot be combined with bare --config', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { attach: ['a.png'], config: true }, undefined, 1)
  assert.match(err[0], /bare --config \(config view\) cannot be combined/)
})

test('one-shot gates office attachments before reading them on openrouter', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  mockOpenRouterApi(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'data.xlsx'))

  const { err } = await runAndExit(t, { attach: [join(dir, 'data.xlsx')], model: 'test/model-a' }, 'sum', 1)
  assert.match(err[0], /xlsx\/docx\/pptx are only supported on Venice/)
  assert.doesNotMatch(err[0], /Cannot read attachment/)
})
