import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import * as realOs from 'node:os'
import { join } from 'node:path'

// POSIX permission bits cannot express an unwritable config on Windows: chmod
// only toggles a file's read-only attribute there and does not stop writes into
// a directory, so the failed preference write is injected at the atomic-write
// seam for the config directory readonlyConfig hands out. Everything else
// delegates to the real module.
let readonlyDir = null
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    writeFile: async (filePath, ...rest) => {
      if (readonlyDir && String(filePath).startsWith(readonlyDir)) {
        const err = new Error(`EACCES: permission denied, open '${filePath}'`)
        err.code = 'EACCES'
        throw err
      }
      return realFs.writeFile(filePath, ...rest)
    },
  },
})

// Hermetic home: the sessions dir, the default config path and the session
// claim files all resolve under this directory.
const tempHome = await mkdtemp(join(realOs.tmpdir(), 'communicator-pref-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome, tmpdir: realOs.tmpdir } })

// Scripted stdin for the chat loop's default reader (`src/input.js`): the real
// one would take over the terminal, and `startChat` cannot inject deps.
let inputQueue = []
mock.module(new URL('../src/input.js', import.meta.url).href, {
  namedExports: {
    readInput: async () => (inputQueue.length === 0 ? { cancelled: true } : { value: inputQueue.shift() }),
  },
})

// The renderer graph is irrelevant here (every run asserts on the session
// context, not on rendering) and a stub keeps the default-deps tests quiet.
function fakeRenderer({ markdown } = {}) {
  const render = () => {}
  render.markdown = markdown
  render.resetMessage = () => {}
  render.flush = () => {}
  return render
}

mock.module(new URL('../src/ui/stream.js', import.meta.url).href, {
  namedExports: {
    createStreamRenderer: () => fakeRenderer(),
    renderHistory: () => {},
    attachmentLine: () => '',
    printSources: () => {},
  },
})

const { runCli } = await import('../src/cli-main.js')
const { runChatSession, startChat } = await import('../src/chat.js')
const { resetModelCaches } = await import('../src/providers/venice.js')

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

// Notices route to stdout on a terminal and to stderr when stdout is piped;
// pin the stream instead of inheriting the runner's own TTY state.
function withStdoutTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original)
    else delete process.stdout.isTTY
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

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(realOs.tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function tempConfig(t) {
  const dir = await tempDir(t, 'communicator-pref-config-')
  return join(dir, 'config.json')
}

// A config file that loads normally but cannot be rewritten: savePreferences
// mkdirs successfully, then the atomic temp write fails with EACCES (injected
// for this directory, above). The cleanup hook clears the injection before
// removing, so it owns the whole dir.
async function readonlyConfig(t, prefs = {}) {
  const dir = await mkdtemp(join(realOs.tmpdir(), 'communicator-pref-ro-'))
  const file = join(dir, 'config.json')
  await realFs.writeFile(file, `${JSON.stringify(prefs, null, 2)}\n`)
  readonlyDir = dir
  t.after(async () => {
    readonlyDir = null
    await rm(dir, { recursive: true, force: true })
  })
  return file
}

function sessionData(overrides = {}) {
  return {
    model: 'test/model',
    providerName: 'ProviderX',
    providerType: 'openrouter',
    reasoningEffort: 'low',
    temperature: 0.9,
    budget: 5,
    webSearch: 'off',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ],
    ...overrides,
  }
}

async function seedSession(id) {
  const { ensureSessionsDir, saveSession } = await import('../src/sessions.js')
  const dir = await ensureSessionsDir()
  await saveSession(dir, id, sessionData())
  return dir
}

test('--no-safe-mode surfaces a failed preference write and exits 1 before any dispatch', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const file = await readonlyConfig(t)
  resetModelCaches()
  t.after(resetModelCaches)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    return jsonResponse({ data: [] })
  })

  const { exitCode, err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: file, safeMode: false }, 'Hi', 1)

  assert.equal(exitCode, 1)
  assert.match(err.join('\n'), /^Error: could not save the safe mode preference: EACCES/m)
  assert.deepEqual(calls, [], 'a failed preference write must abort before any API call')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf-8')), {}, 'the existing config must be left untouched')
})

test('--image --no-watermark surfaces a failed preference write before generation', async (t) => {
  withTTY(t, false)
  withVeniceApiKey(t)
  const file = await readonlyConfig(t)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    return jsonResponse({ data: [] })
  })

  const { exitCode, err } = await runAndExit(t, { provider: 'venice', config: file, image: true, imageModel: 'flux-1-1', watermark: false }, 'a red cat', 1)

  assert.equal(exitCode, 1)
  assert.match(err.join('\n'), /^Error: could not save the watermark preference: EACCES/m)
  assert.deepEqual(calls, [], 'the image run must not start when the preference write failed')
})

test('--aspect-ratio surfaces a failed image-defaults write on a chat run', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const file = await readonlyConfig(t)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    return jsonResponse({ data: [] })
  })

  const { exitCode, err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: file, aspectRatio: '16:9' }, 'Hi', 1)

  assert.equal(exitCode, 1)
  assert.match(err.join('\n'), /^Error: could not save the image defaults preference: EACCES/m)
  assert.deepEqual(calls, [])
})

test('--image --aspect-ratio surfaces a failed image-defaults write on the image path', async (t) => {
  withTTY(t, false)
  withVeniceApiKey(t)
  const file = await readonlyConfig(t)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    return jsonResponse({ data: [] })
  })

  const { exitCode, err } = await runAndExit(t, { provider: 'venice', config: file, image: true, imageModel: 'flux-1-1', aspectRatio: '16:9' }, 'a red cat', 1)

  assert.equal(exitCode, 1)
  assert.match(err.join('\n'), /^Error: could not save the image defaults preference: EACCES/m)
  assert.deepEqual(calls, [])
})

test('--no-save skips the preference write an unwritable config would fail', async (t) => {
  withTTY(t, false)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const file = await readonlyConfig(t)
  resetModelCaches()
  t.after(resetModelCaches)
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ data: [] }))

  const { exitCode, err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: file, safeMode: false, save: false }, 'Hi', 1)

  assert.match(err.join('\n'), /^Venice safe mode disabled$/m, 'the run proceeds past the skipped write')
  assert.doesNotMatch(err.join('\n'), /could not save the/)
  assert.equal(exitCode, 1, 'the run still fails later, on the empty model catalog')
  assert.match(err.join('\n'), /model venice-model not found/)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf-8')), {})
})

test('--export surfaces a failed output-directory preference write after exporting', async (t) => {
  withTTY(t, true)
  await seedSession('2026-01-02T00-00-00')
  const outDir = await tempDir(t, 'communicator-pref-export-')
  const file = await readonlyConfig(t)

  const { exitCode, err } = await runAndExit(t, { config: file, export: '2026-01-02', outputDir: outDir }, undefined, 1)

  assert.equal(exitCode, 1)
  assert.match(err.join('\n'), /^Error: could not save the output directory preference: EACCES/m)
  const md = await readFile(join(outDir, 'session-2026-01-02T00-00-00', 'session-2026-01-02T00-00-00.md'), 'utf-8')
  assert.match(md, /First question/, 'the export itself completed before the preference write failed')
})

test('--export-format surfaces a failed export-format preference write', async (t) => {
  withTTY(t, true)
  await seedSession('2026-01-03T00-00-00')
  const outDir = await tempDir(t, 'communicator-pref-export-')
  // prefs.outputDir already matches the flag, so only the format is a pending
  // change and the failure names the export-format preference.
  const file = await readonlyConfig(t, { outputDir: outDir })

  const { exitCode, err } = await runAndExit(t, { config: file, export: '2026-01-03', outputDir: outDir, exportFormat: 'jsonl' }, undefined, 1)

  assert.equal(exitCode, 1)
  assert.match(err.join('\n'), /^Error: could not save the export format preference: EACCES/m)
  const jsonl = await readFile(join(outDir, 'session-2026-01-03T00-00-00', 'session-2026-01-03T00-00-00.jsonl'), 'utf-8')
  assert.ok(jsonl.trim().length > 0)
})

function scriptedInput(values) {
  const queue = [...values]
  return async () => (queue.length === 0 ? { cancelled: true } : { value: queue.shift() })
}

function fakeProvider() {
  const calls = []
  const provider = {
    meta: { name: 'openrouter' },
    async chatCompletion(callOpts) {
      calls.push({ ...callOpts, messages: callOpts.messages.slice() })
      callOpts.onRequest?.({ model: callOpts.model, messages: callOpts.messages.slice(), stream: true })
      return { content: 'Hello!', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  return { provider, calls }
}

function baseCtx(provider, overrides = {}) {
  return {
    apiKey: 'test-key',
    model: 'org/model',
    endpointProviderName: 'Provider',
    reasoningEffort: 'high',
    temperature: 1.1,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    provider,
    ...overrides,
  }
}

function chatDeps(overrides = {}) {
  return {
    readInput: scriptedInput(['hello', '/quit']),
    renderer: fakeRenderer,
    stdout: { write() {} },
    exit: () => {},
    saveSession: async () => {},
    savePrefs: async () => {},
    newSessionId: async () => '2026-01-02T00-00-00',
    onSignal: () => () => {},
    createSpelling: () => null,
    ...overrides,
  }
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'warn', () => {})
}

test('startChat maps its positional arguments and opts into the session context', async (t) => {
  mockConsole(t)
  const { provider, calls } = fakeProvider()
  inputQueue = ['hello', '/quit']

  const finalState = await startChat('test-key', 'org/model', 'ProviderX', 'high', 1.1, { prompt: 0.000001, completion: 0.000002 }, provider, {
    prefs: {},
    systemPrompt: 'Custom system prompt',
    budget: 4,
    configPath: null,
    sessionId: '2026-01-04T00-00-00',
    createdAt: '2026-01-04T00:00:00.000Z',
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].apiKey, 'test-key')
  assert.equal(calls[0].model, 'org/model')
  assert.equal(calls[0].provider, 'ProviderX')
  assert.equal(calls[0].reasoningEffort, 'high')
  assert.equal(calls[0].temperature, 1.1)
  assert.deepEqual(calls[0].messages.map((m) => m.role), ['system', 'user'])
  assert.equal(calls[0].messages[0].content, 'Custom system prompt')
  assert.equal(finalState.modelId, 'org/model')
  assert.equal(finalState.endpointProviderName, 'ProviderX')
  assert.equal(finalState.reasoningEffort, 'high')
  assert.equal(finalState.temperature, 1.1)
  assert.equal(finalState.budget, 4)
  assert.deepEqual(finalState.pricing, { prompt: 0.000001, completion: 0.000002 })
  assert.equal(finalState.sessionId, '2026-01-04T00-00-00')
})

test('a failing session save is swallowed: the session still ends cleanly', async (t) => {
  mockConsole(t)
  const { provider, calls } = fakeProvider()

  const finalState = await runChatSession(baseCtx(provider, { sessionId: '2026-01-09T00-00-00', createdAt: '2026-01-09T00:00:00.000Z' }), chatDeps({
    saveSession: async () => { throw new Error('disk full') },
  }))

  assert.equal(calls.length, 1, 'the turn itself still ran')
  assert.equal(finalState.modelId, 'org/model')
  assert.equal(finalState.messages.at(-1).content, 'Hello!')
})

test('the default session writer persists the final session under the sessions dir', async (t) => {
  mockConsole(t)
  const { provider } = fakeProvider()
  const deps = chatDeps({ sessionId: undefined, saveSession: undefined })

  const finalState = await runChatSession(baseCtx(provider, { sessionId: '2026-01-05T00-00-00', createdAt: '2026-01-05T00:00:00.000Z' }), deps)

  const saved = JSON.parse(await readFile(join(tempHome, '.communicator', 'sessions', '2026-01-05T00-00-00.json'), 'utf-8'))
  assert.equal(saved.model, 'org/model')
  assert.equal(saved.providerName, 'Provider')
  assert.deepEqual(saved.messages.map((m) => m.role), ['system', 'user', 'assistant'])
  assert.equal(finalState.sessionId, '2026-01-05T00-00-00')
})

test('the default prefs writer persists a command change to the config path', async (t) => {
  mockConsole(t)
  const { provider } = fakeProvider()
  const configFile = await tempConfig(t)
  const deps = chatDeps({ readInput: scriptedInput(['/compact-thinking on', '/quit']), savePrefs: undefined })

  await runChatSession(baseCtx(provider, { prefs: {}, configPath: configFile }), deps)

  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.compactThinking, true)
})

test('the default session id generator claims the session id', async (t) => {
  mockConsole(t)
  const { provider } = fakeProvider()
  // /new is the one caller of the injectable id generator; the following turn
  // makes sure the claim file it created survives the exit save.
  const deps = chatDeps({ readInput: scriptedInput(['/new', 'hello', '/quit']), newSessionId: undefined })

  const finalState = await runChatSession(baseCtx(provider, { sessionId: '2026-01-06T00-00-00', createdAt: '2026-01-06T00:00:00.000Z' }), deps)

  assert.match(finalState.sessionId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/)
  const entries = await readdir(join(tempHome, '.communicator', 'sessions'))
  assert.ok(entries.includes(`${finalState.sessionId}.json`), `claim file missing: ${entries.join(', ')}`)
})
