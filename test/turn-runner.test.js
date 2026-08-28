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
  render.resetMessage = () => {}
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
  render.resetMessage = () => {}
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

test('runTurn resolves true only when an assistant message was appended', async (t) => {
  mockConsole(t)
  const { deps } = makeDeps({ provider: okProvider() })
  const state = fakeState()

  const ok = await runTurn(deps, state)

  assert.equal(ok, true)
  assert.equal(state.messages.at(-1).role, 'assistant')
})

test('runTurn resolves false when the provider returns no content', async (t) => {
  mockConsole(t)
  const { deps } = makeDeps({ provider: okProvider({ chatCompletion: async () => ({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) }) })
  const state = fakeState()

  const ok = await runTurn(deps, state)

  assert.equal(ok, false)
  assert.equal(state.messages.at(-1).role, 'user')
})

test('forwards the session top-p to chatCompletion', async (t) => {
  mockConsole(t)
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  const state = fakeState({ topP: 0.6 })
  let sentTopP
  const provider = {
    async chatCompletion(opts) {
      sentTopP = opts.topP
      return { content: 'Hello', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  const { deps } = makeDeps({ render, provider })

  await runTurn(deps, state)

  assert.equal(sentTopP, 0.6)
})

test('forwards the mandatory-reasoning flag to chatCompletion', async (t) => {
  mockConsole(t)
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  const state = fakeState({ reasoningMandatory: true })
  let sentMandatory
  const provider = {
    async chatCompletion(opts) {
      sentMandatory = opts.reasoningMandatory
      return { content: 'Hello', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  const { deps } = makeDeps({ render, provider })

  await runTurn(deps, state)

  assert.equal(sentMandatory, true)
})

test('the post-history instruction is appended to the request messages without touching state', async (t) => {
  mockConsole(t)
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
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
  render.resetMessage = () => {}
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
  render.resetMessage = () => {}
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
  render.resetMessage = () => {}
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
  assert.equal(state.retryTurn, 'hello')
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
  // typed prompt would silently replay the failed one alongside itself —
  // but the turn is preserved for /retry.
  assert.equal(state.messages.length, 1)
  assert.equal(state.retryTurn, 'hello')
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
  render.resetMessage = () => {}
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

test('Esc stop salvages the partial, appends it, saves the session and does not exit', async (t) => {
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

  const turn = runTurn(deps, state)
  sessionState.stopped = true
  sessionState.streamController.abort()
  const produced = await turn

  // No exit: the partial is the turn result and the runner returns to the prompt.
  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  assert.equal(state.messages[2].content, 'Hel')
  assert.equal(produced, true)
  assert.equal(sessionState.streaming, false)
})

test('Esc stop with no streamed content pops the user message for /retry and does not exit', async (t) => {
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
  const { deps, exitCodes } = makeDeps({ provider, sessionState })

  const turn = runTurn(deps, state)
  sessionState.stopped = true
  sessionState.streamController.abort()
  const produced = await turn

  assert.deepEqual(exitCodes, [])
  assert.equal(state.messages.length, 1)
  assert.equal(state.retryTurn, 'hello')
  assert.equal(produced, false)
})

test('the streaming key monitor wires Esc to a single stop via the stopping guard', async (t) => {
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
  let onStop
  const streamMonitor = { start() {}, stop() {} }
  const createStreamKeyMonitor = (opts) => {
    onStop = opts.onStop
    return streamMonitor
  }
  const { deps, exitCodes, saves } = makeDeps({ provider, sessionState })
  const runner = createTurnRunner({
    state,
    provider,
    apiKey: 'test-key',
    render: deps.render,
    loader: deps.loader,
    stdout: deps.stdout,
    tty: true,
    saveCurrentSession: deps.saveCurrentSession,
    interruptSave: deps.interruptSave,
    exit: deps.exit,
    sessionState,
    input: { isTTY: true },
    createStreamKeyMonitor,
  })

  const turn = runner.runTurn()
  onStop() // first Esc: abort + mark stopped
  onStop() // second Esc: the `stopping` guard must block a second abort
  await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  const assistants = state.messages.filter((m) => m.role === 'assistant')
  assert.equal(assistants.length, 1)
  assert.equal(assistants[0].content, 'Hel')
  assert.equal(sessionState.stopped, false)
  assert.equal(sessionState.stopping, false)
})

test('Ctrl+C via the streaming key monitor (\x03) still saves the partial and exits 130', async (t) => {
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
  let onInterrupt
  const streamMonitor = { start() {}, stop() {} }
  const createStreamKeyMonitor = (opts) => {
    onInterrupt = opts.onInterrupt
    return streamMonitor
  }
  const { deps, exitCodes, saves } = makeDeps({ provider, sessionState })
  const runner = createTurnRunner({
    state,
    provider,
    apiKey: 'test-key',
    render: deps.render,
    loader: deps.loader,
    stdout: deps.stdout,
    tty: true,
    saveCurrentSession: deps.saveCurrentSession,
    interruptSave: deps.interruptSave,
    exit: deps.exit,
    sessionState,
    input: { isTTY: true },
    createStreamKeyMonitor,
  })

  const turn = runner.runTurn()
  onInterrupt()
  await turn

  assert.deepEqual(exitCodes, [130])
  assert.deepEqual(saves, ['interrupt'])
  assert.equal(state.messages[2].content, 'Hel')
})


test('compact thinking hands the loader to the meter without a checkmark', async (t) => {
  mockConsole(t)
  const calls = []
  const loader = {
    start() {},
    stop(opts) { calls.push(opts ?? {}) },
  }
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  const state = fakeState({ compactThinking: true })
  const provider = {
    async chatCompletion(opts) {
      opts.onToken(null, 'start_reasoning')
      opts.onToken('thinking', 'reasoning')
      opts.onToken(null, 'end_reasoning')
      opts.onToken('Hello', 'content')
      return { content: 'Hello', reasoning: 'thinking' }
    },
  }
  const { deps } = makeDeps({ render, loader, provider, tty: true })

  await runTurn(deps, state)

  // start_reasoning clears the waiting line (no done), reasoning does not
  // touch the loader anymore, content resolves it with the checkmark, and
  // the post-turn stop is a no-op on the already-stopped waiting loader.
  assert.deepEqual(calls, [{}, { done: true }, {}])
  assert.equal(state.messages[2].reasoning, 'thinking')
})

test('stores the reasoning duration on the assistant message', async (t) => {
  mockConsole(t)
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  const state = fakeState()
  const provider = {
    async chatCompletion(opts) {
      opts.onToken(null, 'start_reasoning')
      opts.onToken('thinking', 'reasoning')
      opts.onToken(null, 'end_reasoning')
      opts.onToken('Hello', 'content')
      return { content: 'Hello', reasoning: 'thinking', reasoningMs: 1234 }
    },
  }
  const { deps } = makeDeps({ render, provider })

  await runTurn(deps, state)

  assert.equal(state.messages[2].reasoning, 'thinking')
  assert.equal(state.messages[2].reasoningMs, 1234)
})

test('omits the duration when the result carries none', async (t) => {
  mockConsole(t)
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  const state = fakeState()
  const provider = {
    async chatCompletion(opts) {
      opts.onToken(null, 'start_reasoning')
      opts.onToken('thinking', 'reasoning')
      opts.onToken(null, 'end_reasoning')
      opts.onToken('Hello', 'content')
      return { content: 'Hello', reasoning: 'thinking' }
    },
  }
  const { deps } = makeDeps({ render, provider })

  await runTurn(deps, state)

  assert.equal(state.messages[2].reasoning, 'thinking')
  assert.equal(state.messages[2].reasoningMs, undefined)
})

test('full mode starts the turn with a blank row above the marker and never checkmarks the loader during thinking', async (t) => {
  mockConsole(t)
  const calls = []
  const loader = {
    start() {},
    stop(opts) { calls.push(opts ?? {}) },
  }
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  const state = fakeState({ compactThinking: false })
  const provider = {
    async chatCompletion(opts) {
      opts.onToken(null, 'start_reasoning')
      opts.onToken('thinking', 'reasoning')
      opts.onToken(null, 'end_reasoning')
      opts.onToken('Hello', 'content')
      return { content: 'Hello', reasoning: 'thinking' }
    },
  }
  const writes = []
  const { deps } = makeDeps({
    render,
    loader,
    provider,
    tty: true,
    stdout: { write: (chunk) => writes.push(String(chunk)) },
  })

  await runTurn(deps, state)

  // One blank row between the submitted user line and the loader/marker row
  // (turn start writes '\n' + '\n' on tty), so `❯ Thinking` has exactly one
  // blank line above it while streaming. start_reasoning hands the loader
  // over without a checkmark in full mode too — no `✓ Waiting for response`
  // line ever appears in a reasoning transcript; only the post-turn no-op
  // stop remains after content's checkmark is already a no-op.
  assert.deepEqual(writes.slice(0, 2), ['\n', '\n'])
  assert.deepEqual(calls, [{}, { done: true }, {}])
})

test('a reasoning-less turn adds one blank row under the resolved checkpoint', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { write: (chunk) => writes.push(String(chunk)) }
  // A fake loader that reports the checkpoint was written when the spinner was
  // visibly spinning (done stop that wrote the line) so the runner adds the
  // blank row. This isolates turn-runner's `\n` decision from the real loader's
  // timer/grace behaviour (covered in loader.test.js). The label is captured
  // from `start`, so both `Waiting for response` and `Searching the web` go
  // through the same decision.
  let shown = true
  let label = ''
  const loader = {
    start(next) { label = next },
    stop({ done } = {}) {
      if (!shown) return false
      if (done) {
        stdout.write(`\r✓ ${label}\x1b[K\n`)
        shown = false
        return true
      }
      stdout.write('\r\x1b[K')
      shown = false
      return false
    },
  }
  const render = (token, type) => { if (type === 'content') stdout.write(token) }
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  const state = fakeState()
  const provider = {
    async chatCompletion(opts) {
      opts.onToken('Hello', 'content')
      return { content: 'Hello' }
    },
  }
  const { deps } = makeDeps({
    render,
    loader,
    provider,
    tty: true,
    stdout,
  })

  await runTurn(deps, state)

  // `stop({done:true})` reported true, so exactly one blank row (`\n`) was
  // written between the checkpoint row and the answer, matching history replay.
  const live = writes.join('')
  const norm = live.replace(/\r/g, '').replace(/\x1b\[K/g, '').replace(/\x1b\[[0-9;]*m/g, '') // eslint-disable-line no-control-regex
  const cIdx = norm.indexOf('Waiting for response')
  const aIdx = norm.indexOf('Hello')
  assert.ok(cIdx !== -1 && aIdx !== -1, 'both the checkpoint and the answer must appear')
  const between = norm.slice(cIdx + 'Waiting for response'.length, aIdx)
  assert.equal(between, '\n\n', 'exactly one blank row must sit between the checkpoint and the answer')
  // The waitLine label is stashed for history replay, and replay emits it with
  // the same one blank row below (parity with the live layout).
  assert.equal(state.messages[2].waitLine, 'Waiting for response')
})

test('a web-search-always turn uses the Searching the web checkpoint with one blank row', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { write: (chunk) => writes.push(String(chunk)) }
  let shown = true
  let label = ''
  const loader = {
    start(next) { label = next },
    stop({ done } = {}) {
      if (!shown) return false
      if (done) {
        stdout.write(`\r✓ ${label}\x1b[K\n`)
        shown = false
        return true
      }
      stdout.write('\r\x1b[K')
      shown = false
      return false
    },
  }
  const render = (token, type) => { if (type === 'content') stdout.write(token) }
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  const state = fakeState({ webSearch: 'always' })
  const provider = {
    async chatCompletion(opts) {
      opts.onToken('Hello', 'content')
      return { content: 'Hello' }
    },
  }
  const { deps } = makeDeps({
    render,
    loader,
    provider,
    tty: true,
    stdout,
  })

  await runTurn(deps, state)

  const live = writes.join('')
  const norm = live.replace(/\r/g, '').replace(/\x1b\[K/g, '').replace(/\x1b\[[0-9;]*m/g, '') // eslint-disable-line no-control-regex
  const cIdx = norm.indexOf('Searching the web')
  const aIdx = norm.indexOf('Hello')
  assert.ok(cIdx !== -1 && aIdx !== -1, 'the web-search checkpoint and the answer must appear')
  const between = norm.slice(cIdx + 'Searching the web'.length, aIdx)
  assert.equal(between, '\n\n', 'exactly one blank row must sit between the web-search checkpoint and the answer')
  assert.equal(state.messages[2].waitLine, 'Searching the web')
})

test('an instant reply adds no stray blank row (checkpoint never shown)', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { write: (chunk) => writes.push(String(chunk)) }
  let shown = false
  let label = ''
  const loader = {
    start(next) { label = next },
    stop({ done } = {}) {
      if (!shown) return false
      if (done) {
        stdout.write(`\r✓ ${label}\x1b[K\n`)
        shown = false
        return true
      }
      stdout.write('\r\x1b[K')
      shown = false
      return false
    },
  }
  const render = (token, type) => { if (type === 'content') stdout.write(token) }
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  const state = fakeState()
  const provider = {
    async chatCompletion(opts) {
      opts.onToken('Hello', 'content')
      return { content: 'Hello' }
    },
  }
  const { deps } = makeDeps({
    render,
    loader,
    provider,
    tty: true,
    stdout,
  })

  await runTurn(deps, state)

  // The spinner was never shown, so `stop({done:true})` returned false: the
  // runner wrote no checkpoint and no extra blank row — the answer follows the
  // turn-start `\n\n` directly.
  const live = writes.join('')
  assert.ok(!live.includes('Waiting for response'), 'no waiting line may appear for an instant reply')
  assert.equal(live, '\n\nHello\n\n', 'the answer must follow the turn-start newlines directly')
  assert.equal(state.messages[2].waitLine, 'Waiting for response')
})
