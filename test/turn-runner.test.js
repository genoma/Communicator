import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnRunner, createSessionState } from '../src/turn-runner.js'
import { ApiError } from '../src/errors.js'

function fakeState(overrides = {}) {
  const state = {
    modelId: 'org/model',
    endpointProviderName: 'Provider',
    reasoningEffort: 'high',
    supportsReasoning: true,
    sessionId: '2026-01-01T00-00-00',
    temperature: 0.7,
    webSearch: 'off',
    webResults: null,
    zdr: false,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    contextLength: 1000,
    budget: null,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ],
    appendAssistant(message) {
      this.messages.push(message)
    },
    popLastMessage() {
      return this.messages.pop()
    },
    ...overrides,
  }
  return state
}

function makeDeps(overrides = {}) {
  const render = () => {}
  render.sources = []
  render.flush = () => {}
  const loader = { start() {}, stop() {} }
  const exitCodes = []
  const saves = []
  const stdout = { write() {} }
  const deps = {
    render,
    loader,
    stdout,
    tty: false,
    saveCurrentSession: async () => { saves.push('session') },
    interruptSave: async () => { saves.push('interrupt') },
    exit: (code) => exitCodes.push(code),
    ...overrides,
  }
  return { deps, exitCodes, saves }
}

function runTurn(deps, state, opts, runnerOpts = {}) {
  const runner = createTurnRunner({
    state,
    provider: deps.provider,
    apiKey: 'test-key',
    render: deps.render,
    loader: deps.loader,
    stdout: deps.stdout,
    tty: deps.tty,
    saveCurrentSession: deps.saveCurrentSession,
    interruptSave: deps.interruptSave,
    exit: deps.exit,
    sessionState: deps.sessionState ?? createSessionState(),
    ...runnerOpts,
  })
  return runner.runTurn(opts)
}

function okProvider(overrides = {}) {
  return {
    async chatCompletion() {
      return { content: 'Hello!', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
    ...overrides,
  }
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
}

test('a successful turn streams tokens, records usage and appends the message', async (t) => {
  mockConsole(t)
  const render = () => {}
  render.sources = []
  render.flush = () => {}
  const state = fakeState()
  const sessionState = createSessionState()
  const provider = {
    async chatCompletion(opts) {
      opts.onToken('Hel', 'content')
      opts.onToken('lo', 'content')
      return { content: 'Hello', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  const { deps, exitCodes } = makeDeps({ render, provider, sessionState })

  await runTurn(deps, state)

  assert.equal(state.messages[2].content, 'Hello')
  assert.equal(state.messages[2].usage.total_tokens, 15)
  assert.equal(sessionState.tracker.requests, 1)
  assert.equal(sessionState.tracker.promptTokens, 10)
  assert.equal(exitCodes.length, 0)
})

test('the post-history instruction is appended to the request messages without touching state', async (t) => {
  mockConsole(t)
  const render = () => {}
  render.sources = []
  render.flush = () => {}
  const state = fakeState()
  const beforeCount = state.messages.length
  let sentMessages
  const provider = {
    async chatCompletion(opts) {
      sentMessages = opts.messages
      return { content: 'Hello', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  const { deps } = makeDeps({ render, provider })

  await runTurn(deps, state, undefined, { postHistoryInstruction: 'Stay in character.' })

  assert.equal(sentMessages.length, beforeCount + 1)
  assert.deepEqual(sentMessages.slice(0, -1), state.messages.slice(0, beforeCount))
  assert.deepEqual(sentMessages[sentMessages.length - 1], { role: 'system', content: 'Stay in character.' })
  assert.equal(state.messages.length, beforeCount + 1)
  assert.equal(state.messages.some((m) => m.content === 'Stay in character.'), false)
})

test('no post-history message is sent when the instruction is absent', async (t) => {
  mockConsole(t)
  const render = () => {}
  render.sources = []
  render.flush = () => {}
  const state = fakeState()
  let sentMessages
  const provider = {
    async chatCompletion(opts) {
      sentMessages = opts.messages
      return { content: 'Hello', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  const { deps } = makeDeps({ render, provider })

  await runTurn(deps, state)

  assert.deepEqual(sentMessages, state.messages)
})

test('printTurn receives the state context length for the CTX row', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', () => {})
  const { deps } = makeDeps({ provider: okProvider() })

  await runTurn(deps, fakeState({ contextLength: 100 }))

  assert.ok(logs.some((l) => l.includes('CTX    ██░░░░░░░░ 15%')))
})

test('printTurn omits the CTX row without a context length', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', () => {})
  const { deps } = makeDeps({ provider: okProvider() })

  await runTurn(deps, fakeState({ contextLength: null }))

  assert.ok(!logs.some((l) => l.includes('CTX')))
})

test('persists the provider sources on the appended assistant message', async (t) => {
  mockConsole(t)
  const sources = [
    { title: 'Example', url: 'https://example.com/a' },
    { title: null, url: 'https://example.com/b' },
  ]
  const render = () => {}
  render.sources = []
  render.flush = () => {}
  const state = fakeState()
  const provider = okProvider({
    async chatCompletion() {
      return { content: 'Hello', sources, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  })
  const { deps } = makeDeps({ render, provider })

  await runTurn(deps, state)

  assert.deepEqual(state.messages[2].sources, sources)
})

test('leaves the sources field unset when the provider returns none', async (t) => {
  mockConsole(t)
  const state = fakeState()
  const { deps } = makeDeps({ provider: okProvider() })

  await runTurn(deps, state)

  assert.equal('sources' in state.messages[2], false)
})

test('an interrupted stream salvages the sources collected so far', async (t) => {
  mockConsole(t)
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  const sources = [{ title: 'X', url: 'https://x.example' }]
  const provider = okProvider({
    async chatCompletion(opts) {
      opts.onSources(sources)
      opts.signal.addEventListener('abort', () => {
        rejectCompletion(Object.assign(new Error('aborted'), { pendingBuffer: 'data: {"choices":[{"delta":{"content":"Hel' }))
      })
      return pending
    },
  })
  const render = () => {}
  render.flush = () => {}
  const state = fakeState()
  const sessionState = createSessionState()
  sessionState.streaming = true
  sessionState.streamController = new AbortController()
  const { deps, exitCodes, saves } = makeDeps({ render, provider, sessionState })
  const runner = createTurnRunner({
    state,
    provider,
    apiKey: 'test-key',
    render: deps.render,
    loader: deps.loader,
    stdout: deps.stdout,
    tty: false,
    saveCurrentSession: deps.saveCurrentSession,
    interruptSave: deps.interruptSave,
    exit: deps.exit,
    sessionState,
  })

  const turn = runner.runTurn()
  sessionState.interrupted = true
  sessionState.streamController.abort()
  await turn

  assert.deepEqual(exitCodes, [130])
  assert.deepEqual(saves, ['interrupt'])
  assert.equal(state.messages[2].content, 'Hel')
  assert.deepEqual(state.messages[2].sources, sources)
})

test('prints a warning when the stream carried skipped chunks', async (t) => {
  const writes = []
  const logs = []
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', () => {})
  const provider = okProvider({
    async chatCompletion() {
      return { content: 'ok', skippedChunks: 3, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    },
  })
  const { deps } = makeDeps({ provider, stdout: { write: (s) => writes.push(String(s)) } })

  await runTurn(deps, fakeState())

  assert.ok(writes.some((l) => l.includes('3 malformed stream chunks skipped')))
})

test('warns once via the budget line when the cap is 90% crossed', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', () => {})
  const provider = okProvider()
  const state = fakeState({ budget: 0.00004 })
  const { deps } = makeDeps({ provider })

  const runner = createTurnRunner({
    state,
    provider,
    apiKey: 'test-key',
    render: deps.render,
    loader: deps.loader,
    stdout: deps.stdout,
    tty: false,
    saveCurrentSession: deps.saveCurrentSession,
    exit: deps.exit,
    sessionState: createSessionState(),
  })
  await runner.runTurn()
  await runner.runTurn()

  const budgetLines = logs.filter((l) => l.includes('Budget'))
  assert.equal(budgetLines.length, 1)
  assert.match(budgetLines[0], /Budget/)
})

test('a retryable error pops the last user message when the turn appended it', async (t) => {
  mockConsole(t)
  const provider = okProvider({
    async chatCompletion() {
      throw new ApiError('Rate limited', { status: 429, retryable: true })
    },
  })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state, { userAppended: true })

  assert.equal(state.messages.length, 1)
})

test('a retryable error pops the last user message even for /retry turns', async (t) => {
  mockConsole(t)
  const provider = okProvider({
    async chatCompletion() {
      throw new ApiError('Rate limited', { status: 429, retryable: true })
    },
  })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state)

  // The /retry path re-runs an existing user message without appending; when
  // it fails retryably the message must still be dropped, otherwise the next
  // typed prompt would silently replay the failed one alongside itself.
  assert.equal(state.messages.length, 1)
})

test('a non-retryable error keeps the user message', async (t) => {
  mockConsole(t)
  const provider = okProvider({
    async chatCompletion() {
      throw new ApiError('Bad request', { status: 400, retryable: false })
    },
  })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state)

  assert.equal(state.messages.length, 2)
})

test('an interrupted stream salvages the partial response, saves and exits 130', async (t) => {
  mockConsole(t)
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  const provider = okProvider({
    async chatCompletion(opts) {
      opts.signal.addEventListener('abort', () => {
        rejectCompletion(Object.assign(new Error('aborted'), { pendingBuffer: 'data: {"choices":[{"delta":{"content":"Hel' }))
      })
      return pending
    },
  })
  const state = fakeState()
  const sessionState = createSessionState()
  sessionState.streaming = true
  sessionState.streamController = new AbortController()
  const { deps, exitCodes, saves } = makeDeps({ provider, sessionState })
  const runner = createTurnRunner({
    state,
    provider,
    apiKey: 'test-key',
    render: deps.render,
    loader: deps.loader,
    stdout: deps.stdout,
    tty: false,
    saveCurrentSession: deps.saveCurrentSession,
    interruptSave: deps.interruptSave,
    exit: deps.exit,
    sessionState,
  })

  const turn = runner.runTurn()
  sessionState.interrupted = true
  sessionState.streamController.abort()
  await turn

  assert.deepEqual(exitCodes, [130])
  assert.deepEqual(saves, ['interrupt'])
  assert.equal(state.messages[2].content, 'Hel')
})

test('Ctrl+C during the post-stream flush saves the full response and exits 130', async (t) => {
  mockConsole(t)
  let flushResolve
  const render = () => {}
  render.sources = []
  render.flush = () => new Promise((resolve) => { flushResolve = resolve })
  const state = fakeState()
  const sessionState = createSessionState()
  const { deps, exitCodes, saves } = makeDeps({ render, provider: okProvider(), sessionState })

  const turn = runTurn(deps, state)
  while (!flushResolve) await new Promise((resolve) => setTimeout(resolve, 0))
  sessionState.interrupted = true
  flushResolve()
  await turn

  // The stream completed, so the whole response is persisted, not a partial.
  assert.deepEqual(exitCodes, [130])
  assert.deepEqual(saves, ['interrupt'])
  assert.equal(state.messages.length, 3)
  assert.equal(state.messages[2].content, 'Hello!')
  assert.deepEqual(state.messages[2].usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

test('an interrupt with no streamed content saves nothing and still exits 130', async (t) => {
  mockConsole(t)
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  const provider = okProvider({
    async chatCompletion(opts) {
      opts.signal.addEventListener('abort', () => rejectCompletion(new Error('aborted')))
      return pending
    },
  })
  const state = fakeState()
  const sessionState = createSessionState()
  sessionState.streaming = true
  sessionState.streamController = new AbortController()
  const { deps, exitCodes, saves } = makeDeps({ provider, sessionState })

  const turn = runTurn(deps, state)
  sessionState.interrupted = true
  sessionState.streamController.abort()
  await turn

  assert.deepEqual(exitCodes, [130])
  assert.deepEqual(saves, ['interrupt'])
  assert.equal(state.messages.length, 2)
})
