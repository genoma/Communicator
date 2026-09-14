import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Holding the prompt-log append open (src/rpg.js is its only writer on this
// path) turns "the line is on disk" into a deterministic assertion; the gate
// is released by the test, never by a timer. Everything else delegates to the
// real module.
let appendGate = null
let appendStarted = 0
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    appendFile: async (...args) => {
      appendStarted += 1
      if (appendGate) await appendGate
      return realFs.appendFile(...args)
    },
  },
})

// The homedir mock must be registered before chat.js/sessions.js resolve
// SESSIONS_DIR at module load.
const tempHome = await mkdtemp(join(tmpdir(), 'communicator-chat-home-'))
mock.module('node:os', { namedExports: { homedir: () => tempHome } })

// rpg.js is imported after the fs mock (so its appendFile is the gated one),
// then re-registered with a tracked flush: the beforeExit handler is
// fire-and-forget, so the module call is the only observable evidence that it
// flushed. Every other export stays real.
const realRpg = await import('../src/rpg.js')
let flushes = 0
mock.module(new URL('../src/rpg.js', import.meta.url).href, {
  namedExports: {
    ...realRpg,
    flushRpgPromptLog: (...args) => {
      flushes += 1
      return realRpg.flushRpgPromptLog(...args)
    },
  },
})

const { runChatSession } = await import('../src/chat.js')

after(() => rm(tempHome, { recursive: true, force: true }))

const WIPE = '\x1b[2J\x1b[3J\x1b[H'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition) {
  for (let tries = 0; tries < 400 && !condition(); tries++) await delay(5)
}

function silenceConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
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

function makeDeps(overrides = {}) {
  let signalHandlers = null
  const deps = {
    readInput: scriptedInput([]),
    renderer: () => {
      const render = () => {}
      render.markdown = false
      render.resetMessage = () => {}
      render.flush = () => {}
      return render
    },
    stdout: { write() {} },
    exit: () => {},
    saveSession: async () => {},
    savePrefs: async () => {},
    // Never construct the real platform provider: a stub keeps the command
    // list deterministic across platforms (null = no provider, as off darwin).
    createSpelling: () => null,
    onSignal: (handlers) => {
      signalHandlers = handlers
      return () => {}
    },
    newSessionId: async () => '2026-01-02T00-00-00',
    ...overrides,
  }
  return { deps, signals: () => signalHandlers }
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
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function capturingStdout() {
  const writes = []
  return {
    writes,
    stdout: {
      isTTY: true,
      write(chunk) {
        writes.push(String(chunk))
        return true
      },
    },
  }
}

function readLog(dir) {
  const raw = readFileSync(join(dir, 'prompt-log.jsonl'), 'utf-8')
  return raw.trim().split('\n').map((line) => JSON.parse(line))
}

// appendFile creates the file at open(), before its write lands, so "the path
// exists" is not a readiness signal: only a log line that parses is.
function tryReadLog(dir) {
  try {
    return readLog(dir)
  } catch {
    return null
  }
}

test('a late-reasoning burst turn wipes the frame and rebuilds the stored transcript', async (t) => {
  silenceConsole(t)
  const { writes, stdout } = capturingStdout()
  const { provider } = fakeProvider()
  provider.chatCompletion = async () => ({
    content: 'Burst answer.',
    reasoning: 'Burst reasoning that arrived after the content.',
    reasoningMs: 1500,
    lateReasoning: true,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  const { deps } = makeDeps({ readInput: scriptedInput(['hello', '/quit']), stdout })

  await runChatSession(baseCtx(provider), deps)

  const output = writes.join('')
  assert.equal(output.split(WIPE).length - 1, 1, 'the burst turn wipes the frame exactly once')
  const rebuilt = output.split(WIPE)[1]
  assert.match(rebuilt, /❯ You\n\nhello/, 'the rebuild replays the stored user turn')
  assert.match(rebuilt, /❯ Thinking/, 'the rebuild replays the thinking marker')
  assert.match(rebuilt, /Burst reasoning that arrived after the content\./)
  assert.match(rebuilt, /❯ Answer/)
  assert.match(rebuilt, /Burst answer\./)
})

test('a turn without lateReasoning keeps the live frame (no wipe)', async (t) => {
  silenceConsole(t)
  const { writes, stdout } = capturingStdout()
  const { provider } = fakeProvider()
  provider.chatCompletion = async () => ({
    content: 'Ordinary answer.',
    reasoning: 'Ordinary reasoning delivered live.',
    reasoningMs: 800,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  const { deps } = makeDeps({ readInput: scriptedInput(['hello', '/quit']), stdout })

  await runChatSession(baseCtx(provider), deps)

  assert.equal(writes.join('').includes(WIPE), false, 'only a late-reasoning turn may wipe the frame')
})

test('a late-reasoning burst turn rebuilds the compact thinking checkpoint', async (t) => {
  silenceConsole(t)
  const { writes, stdout } = capturingStdout()
  const { provider } = fakeProvider()
  provider.chatCompletion = async () => ({
    content: 'Burst answer.',
    reasoning: 'Burst reasoning that arrived after the content.',
    reasoningMs: 1500,
    lateReasoning: true,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
  const { deps } = makeDeps({ readInput: scriptedInput(['hello', '/quit']), stdout })

  await runChatSession(baseCtx(provider, { compactThinking: true }), deps)

  const rebuilt = writes.join('').split(WIPE)[1]
  assert.ok(rebuilt, 'the burst turn wipes the frame')
  assert.match(rebuilt, /✓ Thinking · \d+ · 1\.5s/, 'the rebuild replays the compact checkpoint with the stored duration')
  assert.match(rebuilt, /✓ Thinking · \d+ · 1\.5s\n\n❯ Answer/)
  assert.match(rebuilt, /Burst answer\./)
})

test('beforeExit flushes a held prompt-log append with one best-effort save and a spelling dispose', async (t) => {
  silenceConsole(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { provider, calls } = fakeProvider()
  // The loop parks on this input, so the handler runs while the session is
  // alive and the finished turn's append is still in flight.
  let releaseInput
  const parked = new Promise((resolve) => { releaseInput = () => resolve({ cancelled: true }) })
  let inputCalls = 0
  const readInput = async () => {
    inputCalls += 1
    return inputCalls === 1 ? { value: 'hello' } : parked
  }
  let saves = 0
  let disposed = 0
  const { deps, signals } = makeDeps({
    readInput,
    saveSession: async () => { saves += 1 },
    createSpelling: () => ({ dispose: () => { disposed += 1 } }),
  })
  let releaseAppend
  appendGate = new Promise((resolve) => { releaseAppend = resolve })
  t.after(() => { appendGate = null; appendStarted = 0 })
  const flushesBefore = flushes
  const logPath = join(dir, 'prompt-log.jsonl')

  const session = runChatSession(baseCtx(provider, { rpgDir: dir, rpgDebug: true }), deps)
  await waitFor(() => inputCalls === 2 && appendStarted === 1)
  assert.equal(calls.length, 1)
  assert.equal(existsSync(logPath), false, 'the prompt-log append must still be held open')

  signals().beforeExit()

  assert.equal(flushes - flushesBefore, 1, 'the beforeExit handler flushes the prompt log')
  assert.equal(saves, 1, 'the beforeExit handler saves best-effort exactly once')
  assert.equal(disposed, 1, 'the beforeExit handler disposes the spelling provider')
  assert.equal(existsSync(logPath), false, 'the flush must wait for the held append, not write past it')

  releaseAppend()
  await waitFor(() => tryReadLog(dir) !== null)
  assert.deepEqual(readLog(dir)[0].request.messages.map((m) => m.role), ['system', 'user'])

  releaseInput()
  await session
  assert.equal(saves, 1, 'the clean exit after the beforeExit save does not save a second time')
})
