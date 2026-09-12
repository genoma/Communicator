import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The prompt log is written through `appendFile` (src/rpg.js); holding that one
// write open is what makes "the line is already on disk when the session exits"
// a deterministic assertion instead of a lucky timing. Only a test that asks
// for the delay is affected, everything else delegates to the real module.
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

// The homedir mock must be registered before chat.js/sessions.js resolve
// SESSIONS_DIR at module load.
const tempHome = await mkdtemp(join(tmpdir(), 'communicator-chat-home-'))
mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const { runChatSession } = await import('../src/chat.js')

after(() => rm(tempHome, { recursive: true, force: true }))

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition) {
  for (let tries = 0; tries < 400 && !condition(); tries++) await delay(5)
}

function scriptedInput(values) {
  const queue = [...values]
  return async () => {
    if (queue.length === 0) return { cancelled: true }
    return { value: queue.shift() }
  }
}

function fakeProvider(overrides = {}) {
  const calls = []
  return {
    calls,
    provider: {
      meta: { name: 'openrouter' },
      async chatCompletion(opts) {
        calls.push(opts.messages.slice())
        opts.onRequest?.({ model: opts.model, messages: opts.messages.slice(), stream: true })
        return { content: 'Hello!', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      },
      ...overrides,
    },
  }
}

function makeHarness({ readInput, onExit = () => {} }) {
  let signalHandlers = null
  const deps = {
    readInput,
    renderer: () => {
      const render = () => {}
      render.markdown = false
      render.resetMessage = () => {}
      render.flush = () => {}
      return render
    },
    stdout: { write() {} },
    exit: onExit,
    saveSession: async () => {},
    savePrefs: async () => {},
    onSignal: (handlers) => {
      signalHandlers = handlers
      return () => {}
    },
    newSessionId: async () => '2026-01-02T00-00-00',
  }
  return { deps, signals: () => signalHandlers }
}

function baseCtx(provider, rpgDir) {
  return {
    apiKey: 'test-key',
    model: 'org/model',
    endpointProviderName: 'Provider',
    provider,
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    rpgDir,
    rpgDebug: true,
  }
}

async function tempRpgDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function readLog(dir) {
  const raw = readFileSync(join(dir, 'prompt-log.jsonl'), 'utf-8')
  return raw.trim().split('\n').map((line) => JSON.parse(line))
}

test('/quit waits for a pending prompt-log append before the session returns', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const dir = await tempRpgDir(t)
  const { provider, calls } = fakeProvider()
  const { deps } = makeHarness({ readInput: scriptedInput(['hello', '/quit']) })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  await runChatSession(baseCtx(provider, dir), deps)

  assert.equal(calls.length, 1)
  // No poll and no retry: a session that returned without flushing its log
  // chain would find the append still sleeping, i.e. no file at all.
  const entries = readLog(dir)
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].request.messages.map((m) => m.role), ['system', 'user'])
})

test('SIGINT exits 130 only after a pending prompt-log append has landed', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const dir = await tempRpgDir(t)
  const { provider, calls } = fakeProvider()
  // The loop parks on this input, so the SIGINT handler sees an idle session.
  let releaseInput
  const parked = new Promise((resolve) => { releaseInput = () => resolve({ cancelled: true }) })
  let inputCalls = 0
  const readInput = async () => {
    inputCalls += 1
    return inputCalls === 1 ? { value: 'hello' } : parked
  }
  const logPath = join(dir, 'prompt-log.jsonl')
  const exits = []
  const { deps, signals } = makeHarness({
    readInput,
    // The exit itself reports what was on disk at that moment: cleanup runs
    // before the process leaves, so an early exit loses the line silently.
    onExit: (code) => exits.push({ code, logAtExit: existsSync(logPath) ? readLog(dir) : null }),
  })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const session = runChatSession(baseCtx(provider, dir), deps)
  await waitFor(() => inputCalls === 2)
  assert.equal(calls.length, 1)
  signals().sigint()
  await waitFor(() => exits.length === 1)
  releaseInput()
  await session

  assert.deepEqual(exits.map((entry) => entry.code), [130])
  assert.equal(exits[0].logAtExit?.length, 1, 'the prompt-log line must already be on disk when the exit runs')
})

test('SIGINT during streaming exits 130 only after a pending prompt-log append has landed', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const dir = await tempRpgDir(t)
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  let loggedRequest
  const requestLogged = new Promise((resolve) => { loggedRequest = resolve })
  // The streaming interrupt runs through the runner's `interruptedExit`, which
  // saves via the injected `interruptSave` (src/chat.js) and then exits 130.
  const { provider } = fakeProvider({
    async chatCompletion(opts) {
      opts.onRequest?.({ model: opts.model, messages: opts.messages.slice(), stream: true })
      loggedRequest()
      opts.signal.addEventListener('abort', () => {
        rejectCompletion(Object.assign(new Error('aborted'), { pendingBuffer: 'data: {"choices":[{"delta":{"content":"Hel' }))
      })
      return pending
    },
  })
  const logPath = join(dir, 'prompt-log.jsonl')
  const exits = []
  const { deps, signals } = makeHarness({
    readInput: scriptedInput(['hello', '/quit']),
    onExit: (code) => exits.push({ code, logAtExit: existsSync(logPath) ? readLog(dir) : null }),
  })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const session = runChatSession(baseCtx(provider, dir), deps)
  await requestLogged
  signals().sigint()
  await waitFor(() => exits.length === 1)
  await session

  assert.deepEqual(exits.map((entry) => entry.code), [130])
  assert.equal(exits[0].logAtExit?.length, 1, 'the prompt-log line must already be on disk when the streaming interrupt exits')
})

test('uncaughtException exits 1 only after a pending prompt-log append has landed', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const dir = await tempRpgDir(t)
  const { provider, calls } = fakeProvider()
  // The loop parks on this input, so the handler sees a finished turn whose
  // append is still in flight.
  let releaseInput
  const parked = new Promise((resolve) => { releaseInput = () => resolve({ cancelled: true }) })
  let inputCalls = 0
  const readInput = async () => {
    inputCalls += 1
    return inputCalls === 1 ? { value: 'hello' } : parked
  }
  const logPath = join(dir, 'prompt-log.jsonl')
  const exits = []
  const { deps, signals } = makeHarness({
    readInput,
    onExit: (code) => exits.push({ code, logAtExit: existsSync(logPath) ? readLog(dir) : null }),
  })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const session = runChatSession(baseCtx(provider, dir), deps)
  await waitFor(() => inputCalls === 2)
  assert.equal(calls.length, 1)
  signals().uncaughtException(new Error('boom'))
  await waitFor(() => exits.length === 1)
  releaseInput()
  await session

  assert.deepEqual(exits.map((entry) => entry.code), [1])
  assert.equal(exits[0].logAtExit?.length, 1, 'the prompt-log line must already be on disk when the unhandled-error exit runs')
})
