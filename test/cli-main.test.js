import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '../src/cli-main.js'
import { resetModelCaches as resetOpenRouterModelCaches } from '../src/providers/openrouter.js'
import { resetModelCaches as resetVeniceModelCaches } from '../src/providers/venice.js'

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
  webSearch: undefined,
  webResults: undefined,
  smoothStreaming: true,
  smoothSpeed: undefined,
  delete: undefined,
  deleteAllSessions: undefined,
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
  t.mock.method(console, 'warn', (msg) => err.push(String(msg)))
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

function withVeniceApiKey(t, value = 'venice-test-key') {
  const previous = process.env.VENICE_API_KEY
  process.env.VENICE_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.VENICE_API_KEY
    else process.env.VENICE_API_KEY = previous
  })
}

function mockOpenRouterApi(t) {
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
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/endpoints')) return jsonResponse({ data: { endpoints } })
    return jsonResponse({ data: models })
  })
}

function mockVeniceApi(t) {
  resetVeniceModelCaches()
  const models = [{
    id: 'venice/model-x',
    model_spec: { name: 'Model X', capabilities: {}, constraints: { max_tokens: 1000 }, availableContextTokens: 1000, pricing: null, description: null },
  }]
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: models }))
}

test('-m <id> alone takes the chat path instead of validating and exiting', async (t) => {
  withTTY(t, true)
  const previous = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  })
  const { err } = await runAndExit(t, { model: 'test/model-a' }, undefined, 1)
  assert.match(err[0], /OPENROUTER_API_KEY environment variable is not set/)
})

test('the removed one-shot flags are rejected as unknown options', async (t) => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const home = await mkdtemp(join(tmpdir(), 'communicator-cli-spawn-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const cases = [
    ['--variants', '2'],
    ['--resolution', '2K'],
    ['--quality', 'high'],
    ['--width', '512'],
    ['--height', '512'],
    ['--budget', '2'],
  ]
  for (const [flag, value] of cases) {
    const res = spawnSync(process.execPath, [join(root, 'index.js'), flag, value, 'x'], {
      cwd: root,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf-8',
      timeout: 20000,
    })
    assert.equal(res.status, 1, `${flag}: ${res.stdout}${res.stderr}`)
    assert.match(res.stderr, /unknown option/, `${flag} stderr: ${res.stderr}`)
  }
})

test('invalid --web-search mode is rejected before any dispatch', async (t) => {
  const { err } = await runAndExit(t, { webSearch: 'bogus' }, undefined, 1)
  assert.match(err[0], /--web-search expects "auto", "always", "on", or "off"/)
})

test('a piped run with --system-prompt and no model needs a TTY', async (t) => {
  withTTY(t, false)
  withVeniceApiKey(t)
  mockVeniceApi(t)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { provider: 'venice', config: file, watermark: false, systemPrompt: '/nonexistent.md' }, undefined, 1)
  assert.match(err.join('\n'), /Interactive selection needs a TTY/)
  assert.ok(!err.join('\n').includes('Saved to'))
  await assert.rejects(readFile(file, 'utf-8'), /ENOENT/)
})

test('a piped --scrape run with no model needs a TTY and never bills', async (t) => {
  withTTY(t, false)
  withVeniceApiKey(t)
  const file = await tempConfig(t)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    return jsonResponse({ data: [] })
  })
  const { err } = await runAndExit(t, { provider: 'venice', config: file, watermark: false, scrape: 'https://example.com/article' }, undefined, 1)
  assert.match(err.join('\n'), /Interactive selection needs a TTY/)
  assert.ok(!calls.some((u) => u.includes('/augment/scrape')), 'a refused run must not bill a scrape')
  await assert.rejects(readFile(file, 'utf-8'), /ENOENT/)
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

test('--delete-all-sessions conflicts with --resume', async (t) => {
  const { err } = await runAndExit(t, { deleteAllSessions: 'y', resume: true }, undefined, 1)
  assert.match(err[0], /Cannot use --delete-all-sessions with --resume, --export or --delete/)
})

test('--delete-all-sessions conflicts with --export', async (t) => {
  const { err } = await runAndExit(t, { deleteAllSessions: 'y', export: true }, undefined, 1)
  assert.match(err[0], /Cannot use --delete-all-sessions with --resume, --export or --delete/)
})

test('--delete-all-sessions conflicts with --delete', async (t) => {
  const { err } = await runAndExit(t, { deleteAllSessions: 'y', delete: true }, undefined, 1)
  assert.match(err[0], /Cannot use --delete-all-sessions with --resume, --export or --delete/)
})

test('a prompt argument cannot be combined with --delete-all-sessions', async (t) => {
  const { err } = await runAndExit(t, { deleteAllSessions: 'y' }, 'hello', 1)
  assert.match(err[0], /Cannot combine a prompt argument with --delete-all-sessions/)
})

test('session flags cannot be combined with --delete-all-sessions', async (t) => {
  const { err } = await runAndExit(t, { deleteAllSessions: 'y', webSearch: 'auto' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --delete-all-sessions/)
})

test('--output-dir cannot be combined with --delete-all-sessions', async (t) => {
  const { err } = await runAndExit(t, { deleteAllSessions: 'y', outputDir: '/tmp' }, undefined, 1)
  assert.match(err[0], /cannot be combined with --delete-all-sessions/)
})

test('--delete-all-sessions cannot be combined with --list-* flags', async (t) => {
  const { err } = await runAndExit(t, { deleteAllSessions: 'y', listSessions: true }, undefined, 1)
  assert.match(err[0], /cannot be combined with --list-\* flags/)
})

test('a prompt argument cannot be combined with --resume', async (t) => {
  const { err } = await runAndExit(t, { resume: true }, 'hello', 1)
  assert.match(err[0], /Cannot combine a prompt argument/)
})

test('a prompt argument cannot be combined with --list-models', async (t) => {
  const { err } = await runAndExit(t, { listModels: true }, 'hello', 1)
  assert.match(err[0], /Cannot combine a prompt argument/)
})

test('bare interactive flags require a TTY', async (t) => {
  const { err } = await runAndExit(t, { export: true }, undefined, 1)
  assert.match(err[0], /bare --export needs a TTY/)
})

test('an explicitly empty session selector needs a TTY exactly like the bare flag', async (t) => {
  // Commander keeps an empty value (--export '' / --export=) as '': no id was
  // given, so the picker form's message must fire on a pipe instead of the run
  // reaching a prompt (or, for -r, the piped-stdin one-shot).
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const home = await mkdtemp(join(tmpdir(), 'communicator-cli-spawn-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  for (const [flag, message] of [
    ['--resume', 'Error: bare --resume needs a TTY (pass a session id to select non-interactively).'],
    ['--export', 'Error: bare --export needs a TTY (pass a session id to select non-interactively).'],
    ['--delete', 'Error: bare --delete needs a TTY (pass a session id to select non-interactively).'],
  ]) {
    for (const args of [[`${flag}=`], [flag, '']]) {
      const res = spawnSync(process.execPath, [join(root, 'index.js'), ...args], {
        cwd: root,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf-8',
        timeout: 20000,
      })
      assert.equal(res.status, 1, `${args.join(' ')}: ${res.stdout}${res.stderr}`)
      assert.equal(res.stderr.trim(), message, `${args.join(' ')} stderr: ${res.stderr}`)
    }
  }
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

test('--e2ee cannot be combined with --list-* flags', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  mockVeniceApi(t)
  const { exitCode, out, err } = await runAndExit(t, { e2ee: true, provider: 'venice', listModels: true }, undefined, 1)
  assert.equal(exitCode, 1)
  assert.match(err[0], /--e2ee cannot be combined with --list-\* flags/)
  assert.ok(!err.some((l) => /encrypts messages sent to the API/.test(l)))
  assert.deepEqual(out, [])
})

test('--e2ee cannot be combined with --export', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  mockVeniceApi(t)
  const { exitCode, out, err } = await runAndExit(t, { e2ee: true, provider: 'venice', export: true }, undefined, 1)
  assert.equal(exitCode, 1)
  assert.match(err[0], /--e2ee cannot be combined with --export/)
  assert.ok(!err.some((l) => /encrypts messages sent to the API/.test(l)))
  assert.deepEqual(out, [])
})

test('--web-results is rejected on Venice before any dispatch', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  mockVeniceApi(t)
  const { exitCode, out, err } = await runAndExit(t, { provider: 'venice', webResults: 5 }, 'hi', 1)
  assert.equal(exitCode, 1)
  assert.match(err[0], /--web-results is only available with --provider openrouter/)
  assert.deepEqual(out, [])
})

test('--e2ee cannot be combined with --delete or --delete-all-sessions', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  mockVeniceApi(t)
  for (const exit of [{ delete: true }, { deleteAllSessions: 'y' }]) {
    const { exitCode, out, err } = await runAndExit(t, { e2ee: true, provider: 'venice', ...exit }, undefined, 1)
    assert.equal(exitCode, 1)
    assert.match(err[0], /--e2ee cannot be combined with --(delete|delete-all-sessions)/)
    assert.ok(!err.some((l) => /encrypts messages sent to the API/.test(l)))
    assert.deepEqual(out, [])
  }
})

test('session flags cannot be combined with --export', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { export: true, temperature: '0.5' }, undefined, 1)
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

test('standalone --output-dir requires --export or --image even with a prompt', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { outputDir: '/tmp' }, 'hello', 1)
  assert.match(err[0], /--output-dir requires --export or --image/)
})

test('standalone --output-dir requires --export or --image without a TTY', async (t) => {
  const { err } = await runAndExit(t, { outputDir: '/tmp' }, undefined, 1)
  assert.match(err[0], /--output-dir requires --export or --image/)
})

test('bare --config cannot be combined with other flags', async (t) => {
  const { err } = await runAndExit(t, { config: true, model: 'x' }, undefined, 1)
  assert.match(err[0], /bare --config \(config view\) cannot be combined/)
})

test('bare --config with --list-models is rejected', async (t) => {
  const { err } = await runAndExit(t, { config: true, listModels: true }, undefined, 1)
  assert.match(err[0], /bare --config \(config view\) cannot be combined/)
})

test('bare --config cannot be combined with --zdr', async (t) => {
  withTTY(t, true)
  const { exitCode, err } = await runAndExit(t, { config: true, zdr: true }, undefined, 1)
  assert.equal(exitCode, 1)
  assert.match(err[0], /bare --config \(config view\) cannot be combined/)
})

test('piped bare --config with --zdr is rejected without printing the config', async (t) => {
  const { exitCode, out, err } = await runAndExit(t, { config: true, zdr: true }, undefined, 1)
  assert.equal(exitCode, 1)
  assert.match(err[0], /bare --config \(config view\) cannot be combined/)
  assert.deepEqual(out, [])
})

test('bare --config prints the config file header and exits 0', async (t) => {
  const { out } = await runAndExit(t, { config: true }, undefined, 0)
  assert.match(out[0], /^Config file:/)
})

test('--output-dir alone errors: it requires --export or --image', async (t) => {
  withTTY(t, true)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { config: file, outputDir: '/tmp/exports' }, undefined, 1)
  assert.match(err[0], /Error: --output-dir requires --export or --image\./)
  await assert.rejects(readFile(file, 'utf-8'), /ENOENT/)
})

test('--no-smooth-streaming alone takes the chat path instead of persisting a default', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { config: file, smoothStreaming: false, systemPrompt: '/nonexistent.md' }, undefined, 1)
  assert.match(err.join('\n'), /system prompt file not found/)
  await assert.rejects(readFile(file, 'utf-8'), /ENOENT/)
})

test('--no-safe-mode alone takes the chat path and fails on the missing key', async (t) => {
  withTTY(t, true)
  const previous = process.env.VENICE_API_KEY
  delete process.env.VENICE_API_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.VENICE_API_KEY
    else process.env.VENICE_API_KEY = previous
  })
  const { err } = await runAndExit(t, { provider: 'venice', safeMode: false }, undefined, 1)
  assert.match(err[0], /VENICE_API_KEY environment variable is not set/)
})

test('--no-safe-mode with --output-dir errors instead of persisting anything', async (t) => {
  withTTY(t, true)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { config: file, safeMode: false, outputDir: '/tmp/x' }, undefined, 1)
  assert.match(err[0], /Error: --output-dir requires --export or --image\./)
  await assert.rejects(readFile(file, 'utf-8'), /ENOENT/)
})

test('piped stdin with a setter flag but no model takes the run path and demands a TTY', async (t) => {
  withTTY(t, false)
  // With the set-and-exit dispatch gone these flags no longer apply and exit:
  // a piped run without -m stops at the model-selection TTY gate and writes
  // nothing.
  for (const overrides of [{ imageFormat: 'png' }, { safeMode: false }, { aspectRatio: '16:9' }]) {
    const file = await tempConfig(t)
    const { err } = await runAndExit(t, { config: file, ...overrides }, undefined, 1)
    assert.match(err.join('\n'), /Interactive selection needs a TTY/, JSON.stringify(overrides))
    await assert.rejects(readFile(file, 'utf-8'), /ENOENT/)
  }
})

test('an invalid --temperature is rejected before any dispatch', async (t) => {
  withTTY(t, true)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { config: file, temperature: '3' }, undefined, 1)
  assert.match(err[0], /Temperature must be a number between 0 and 2/)
})

test('--model with an unknown id fails gracefully', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  mockOpenRouterApi(t)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { config: file, model: 'nope/x' }, undefined, 1)
  assert.match(err[0], /model nope\/x not found/)
})

test('--web-search default is gated against model support', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
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
  resetOpenRouterModelCaches()
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

test('an unknown --provider exits 1 with a friendly message, not a raw stack', async (t) => {
  withTTY(t, true)
  const { exitCode, err } = await runAndExit(t, { provider: 'bogus' }, undefined, 1)
  assert.equal(exitCode, 1)
  assert.ok(err.some((l) => /Unknown provider: bogus/.test(l)))
  assert.ok(!err.some((l) => /at /.test(l)))
})

test('a CliError message is stripped of escape bytes before it reaches the terminal', async (t) => {
  withTTY(t, true)
  const { exitCode, err } = await runAndExit(t, { provider: 'bogus\u001b[2J\u001b[1;31mFAKE' }, undefined, 1)
  assert.equal(exitCode, 1)
  assert.ok(err.some((l) => /Unknown provider: bogusFAKE/.test(l)))
  assert.ok(!err.some((l) => l.includes('\u001b')))
})

test('plain --e2ee warns that the session file is stored unencrypted', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  mockVeniceApi(t)
  const file = await tempConfig(t)
  const { err } = await runAndExit(t, { e2ee: true, provider: 'venice', config: file, model: 'venice/model-x' }, undefined, 1)
  assert.ok(err.some((l) => /--e2ee encrypts messages sent to the API, but the session file stores them unencrypted/.test(l)))
})
