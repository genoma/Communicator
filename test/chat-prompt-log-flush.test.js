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
const { createSpellingProvider } = await import('../src/spelling/provider.js')

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

function makeHarness({ readInput, onExit = () => {}, ...overrides }) {
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
      // Mirror registerSignalHandlers: a removed listener can no longer fire.
      return () => { signalHandlers = null }
    },
    newSessionId: async () => '2026-01-02T00-00-00',
    ...overrides,
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

// --- clean-exit window: the signal handlers must stay live through the save
// and the flush (src/chat.js exitCleanly), so a Ctrl+C landing there still
// exits 130 once both writes are done instead of dying unflushed. -----------

function countConsole(t) {
  const lines = []
  t.mock.method(console, 'log', (line) => { lines.push(String(line)) })
  return lines
}

// The real provider (not a stub), driven through its backend seam: the window
// disposes it from both the exit path and the signal handler, so the backend
// must still see a single dispose.
function countingSpelling(disposes) {
  return () => createSpellingProvider({
    backend: {
      run: async () => ({ ranges: [] }),
      dispose: () => { disposes.push('dispose') },
    },
    features: { typoDetection: true },
  })
}

test('SIGINT during the clean-exit flush lands the prompt log and exits 130 once', async (t) => {
  const logs = countConsole(t)
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  const dir = await tempRpgDir(t)
  const { provider, calls } = fakeProvider()
  const disposes = []
  let saves = 0
  const logPath = join(dir, 'prompt-log.jsonl')
  const exits = []
  const { deps, signals } = makeHarness({
    readInput: scriptedInput(['hello', '/quit']),
    saveSession: async () => { saves += 1 },
    createSpelling: countingSpelling(disposes),
    // The exit itself reports what was on disk at that moment: cleanup runs
    // before the process leaves, so an early exit loses the line silently.
    onExit: (code) => exits.push({ code, logAtExit: existsSync(logPath) ? readLog(dir) : null }),
  })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const session = runChatSession(baseCtx(provider, dir), deps)
  // The clean-exit save has run and the held append is still in flight, so the
  // session sits exactly in the window.
  await waitFor(() => saves === 1)
  const handlers = signals()
  assert.ok(handlers, 'the signal handlers must stay live through the clean-exit window')
  const outputBefore = logs.length
  handlers.sigint()
  handlers.sigint()
  await waitFor(() => exits.length === 1)
  await session

  assert.equal(calls.length, 1)
  assert.deepEqual(exits.map((entry) => entry.code), [130])
  assert.equal(exits[0].logAtExit?.length, 1, 'the exit must wait for the held append')
  assert.equal(saves, 1, 'a repeat press must not start a second save')
  assert.deepEqual(disposes, ['dispose'], 'the window disposes the provider twice; the backend is released once')
  assert.equal(logs.length, outputBefore, 'the interrupt path adds no output lines')
  assert.ok(!errors.some((line) => line.includes('Interrupted.')))
})

test('SIGINT during the clean-exit save waits for the in-flight write', async (t) => {
  countConsole(t)
  t.mock.method(console, 'error', () => {})
  const dir = await tempRpgDir(t)
  const { provider } = fakeProvider()
  let saves = 0
  let saved = false
  let releaseSave
  const saveGate = new Promise((resolve) => { releaseSave = resolve })
  const logPath = join(dir, 'prompt-log.jsonl')
  const exits = []
  const { deps, signals } = makeHarness({
    readInput: scriptedInput(['hello', '/quit']),
    saveSession: async () => {
      saves += 1
      await saveGate
      saved = true
    },
    createSpelling: () => null,
    onExit: (code) => exits.push({ code, savedAtExit: saved, logAtExit: existsSync(logPath) ? readLog(dir) : null }),
  })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0; releaseSave() })

  const session = runChatSession(baseCtx(provider, dir), deps)
  await waitFor(() => saves === 1)
  const handlers = signals()
  assert.ok(handlers, 'the signal handlers must stay live through the clean-exit save')
  handlers.sigint()
  // The held append has landed, so only the in-flight save can still hold the
  // exit: an exit chain that ignored it would already have fired here.
  await waitFor(() => existsSync(logPath))
  await delay(20)
  assert.deepEqual(exits, [], 'the exit must wait for the in-flight save')
  releaseSave()
  await waitFor(() => exits.length === 1)
  await session

  assert.deepEqual(exits.map((entry) => entry.code), [130])
  assert.equal(exits[0].savedAtExit, true, 'the exit must not truncate the in-flight save')
  assert.equal(exits[0].logAtExit?.length, 1)
  assert.equal(saves, 1)
})

test('uncaughtException during the clean-exit window still exits 1 after the log lands', async (t) => {
  countConsole(t)
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  const dir = await tempRpgDir(t)
  const { provider } = fakeProvider()
  let saves = 0
  const logPath = join(dir, 'prompt-log.jsonl')
  const exits = []
  const { deps, signals } = makeHarness({
    readInput: scriptedInput(['hello', '/quit']),
    saveSession: async () => { saves += 1 },
    createSpelling: () => null,
    onExit: (code) => exits.push({ code, logAtExit: existsSync(logPath) ? readLog(dir) : null }),
  })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const session = runChatSession(baseCtx(provider, dir), deps)
  await waitFor(() => saves === 1)
  const handlers = signals()
  assert.ok(handlers, 'the handlers must stay live through the clean-exit window')
  handlers.uncaughtException(new Error('boom'))
  await waitFor(() => exits.length === 1)
  await session

  assert.deepEqual(exits.map((entry) => entry.code), [1])
  assert.equal(exits[0].logAtExit?.length, 1, 'the crash exit must wait for the held append')
  assert.equal(saves, 1, 'the crash path joins the in-flight save, it does not start a second')
  assert.ok(errors.some((line) => line.includes('Unhandled error: boom')))
  assert.ok(!errors.some((line) => line.includes('Interrupted.')))
})

test('a clean /quit still saves once, flushes once and exits nothing', async (t) => {
  const logs = countConsole(t)
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  const dir = await tempRpgDir(t)
  const { provider } = fakeProvider()
  let saves = 0
  const exits = []
  const { deps, signals } = makeHarness({
    readInput: scriptedInput(['hello', '/quit']),
    saveSession: async () => { saves += 1 },
    createSpelling: () => null,
    onExit: (code) => exits.push(code),
  })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const session = runChatSession(baseCtx(provider, dir), deps)
  // Everything printed up to the clean-exit save is the session's own output;
  // the save+flush exit path must add nothing.
  await waitFor(() => saves === 1)
  const outputBefore = logs.length
  const finalState = await session

  assert.equal(saves, 1)
  assert.equal(readLog(dir).length, 1)
  assert.deepEqual(exits, [])
  assert.equal(finalState.messages.length, 3)
  assert.equal(logs.length, outputBefore, 'the clean exit prints nothing after the save starts')
  assert.equal(signals(), null, 'the clean exit removes the signal handlers before returning')
  assert.ok(![...logs, ...errors].some((line) => line.includes('Interrupted.')))
})

test('an EOF cancel still saves once, flushes once and exits nothing', async (t) => {
  const logs = countConsole(t)
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  const dir = await tempRpgDir(t)
  const { provider } = fakeProvider()
  let saves = 0
  const exits = []
  const { deps, signals } = makeHarness({
    readInput: scriptedInput(['hello']),
    saveSession: async () => { saves += 1 },
    createSpelling: () => null,
    onExit: (code) => exits.push(code),
  })
  appendFileDelayMs = 200
  t.after(() => { appendFileDelayMs = 0 })

  const session = runChatSession(baseCtx(provider, dir), deps)
  await waitFor(() => saves === 1)
  const outputBefore = logs.length
  const finalState = await session

  assert.equal(saves, 1)
  assert.equal(readLog(dir).length, 1)
  assert.deepEqual(exits, [])
  assert.equal(finalState.messages.length, 3)
  assert.equal(logs.length, outputBefore, 'the clean exit prints nothing after the save starts')
  assert.equal(signals(), null, 'the cancel exit removes the signal handlers before returning')
  assert.ok(![...logs, ...errors].some((line) => line.includes('Interrupted.')))
})
