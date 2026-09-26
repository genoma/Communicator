import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnRunner, createSessionState } from '../src/turn-runner.js'
import { ApiError, makeHandleHttpError, overflowErrorText, emptyAnswerOutcome } from '../src/errors.js'
import { dim } from '../src/ui/style.js'

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

function captureErrors(t) {
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  return errors
}

const handleOpenRouterError = makeHandleHttpError({ providerName: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY' })

// The live OpenRouter pre-flight over-window 400: wording only (numeric code,
// no error_type), so the REPL must classify it before rendering anything.
function openRouterOverflowError() {
  try {
    handleOpenRouterError(400, JSON.stringify({
      error: {
        message: "This endpoint's maximum context length is 16384 tokens. However, you requested about 26265 tokens (26255 of text input, 10 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.",
        code: 400,
        metadata: { provider_name: null },
      },
    }))
  } catch (err) {
    return err
  }
  throw new Error('expected the OpenRouter handler to throw')
}

function enableAnsi(t) {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  process.stdout.getColorDepth = () => 8
  t.after(() => {
    delete process.stdout.getColorDepth
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  })
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
  assert.equal(sessionState.tracker.completionTokens, 5)
  assert.ok(sessionState.tracker.cost > 0)
  assert.equal(sessionState.tracker.peakContext, 10 + 5)
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

test('runTurn resolves false on no content and stashes the turn for /retry', async (t) => {
  mockConsole(t)
  const { deps } = makeDeps({ provider: okProvider({ chatCompletion: async () => ({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) }) })
  const state = fakeState()

  const ok = await runTurn(deps, state)

  assert.equal(ok, false)
  assert.equal(state.retryTurn, 'hello')
  assert.equal(state.messages.at(-1).role, 'system')
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

test('a non-retryable mid-stream error salvages the rendered partial as an assistant message', async (t) => {
  mockConsole(t)
  const provider = okProvider({
    async chatCompletion({ onToken }) {
      onToken('Hello ', 'content')
      onToken('world', 'content')
      throw new ApiError('Content generated was filtered', { retryable: false, errorType: 'content_filter' })
    },
  })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state)

  // The rendered partial is preserved as an assistant message so a rebuild or
  // /retry keeps what the user already saw, and the user message is not popped
  // (non-retryable error).
  assert.equal(state.messages.length, 3)
  assert.equal(state.messages.at(-1).role, 'assistant')
  assert.equal(state.messages.at(-1).content, 'Hello world')
  assert.equal(state.retryTurn, undefined)
  assert.equal(state.lastError.retryable, false)
  assert.equal(state.lastError.type, 'content_filter')
})

test('a pre-flight context overflow renders the REPL message and keeps the user message', async (t) => {
  const errors = captureErrors(t)
  const provider = okProvider({
    async chatCompletion() {
      throw openRouterOverflowError()
    },
  })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state)

  const text = overflowErrorText({ phase: 'preflight', mode: 'repl' })
  // The classified message replaces the raw provider body (and never leaks the
  // 'request failed' rendering); the failure is non-retryable, so the user
  // message stays in the transcript.
  assert.deepEqual(errors, [`\nError: ${text}\n`])
  assert.equal(state.messages.length, 2)
  assert.equal(state.retryTurn, undefined)
  assert.deepEqual(state.lastError, { message: text, status: 400, code: '400', type: null, retryable: false })
})

test('a mid-generation context overflow renders the REPL message and salvages the partial', async (t) => {
  const errors = captureErrors(t)
  const provider = okProvider({
    async chatCompletion({ onToken }) {
      onToken('Partial ', 'content')
      throw new ApiError('Provider error', { errorType: 'context_length_exceeded', retryable: false })
    },
  })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state)

  const text = overflowErrorText({ phase: 'mid-generation', mode: 'repl' })
  assert.deepEqual(errors, [`\nError: ${text}\n`])
  // Delivered output classifies the failure as mid-generation, and the
  // non-retryable salvage keeps the partial in the transcript.
  assert.equal(state.messages.length, 3)
  assert.equal(state.messages.at(-1).role, 'assistant')
  assert.equal(state.messages.at(-1).content, 'Partial ')
  assert.equal(state.retryTurn, undefined)
  assert.deepEqual(state.lastError, { message: text, status: null, code: null, type: 'context_length_exceeded', retryable: false })
})

test('a non-overflow 400 keeps the raw provider rendering', async (t) => {
  const errors = captureErrors(t)
  const provider = okProvider({
    async chatCompletion() {
      throw new ApiError('OpenRouter request failed (400): Invalid model id', { status: 400, retryable: false })
    },
  })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state)

  assert.deepEqual(errors, ['\nError: OpenRouter request failed (400): Invalid model id\n'])
  assert.equal(state.messages.length, 2)
  assert.equal(state.lastError.message, 'OpenRouter request failed (400): Invalid model id')
})

test('a retryable failure records the failure summary on state.lastError', async (t) => {
  mockConsole(t)
  const provider = okProvider({
    async chatCompletion() {
      throw new ApiError('Rate limited', { status: 429, retryable: true, errorType: 'rate_limit_exceeded' })
    },
  })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state)

  assert.equal(state.messages.length, 1)
  assert.equal(state.retryTurn, 'hello')
  assert.deepEqual(state.lastError, { message: 'Rate limited', status: 429, code: null, type: 'rate_limit_exceeded', retryable: true })
})

test('an empty-content turn is surfaced as a real failure and stashed for /retry', async (t) => {
  mockConsole(t)
  const provider = okProvider({ async chatCompletion() { return { content: '' } } })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state)

  assert.equal(state.messages.length, 1)
  assert.equal(state.retryTurn, 'hello')
  assert.deepEqual(state.lastError, { message: 'Provider returned no output.', status: null, code: null, type: null, retryable: true })
})

test('an empty-content turn with a stop finish reason keeps the generic retryable verdict', async (t) => {
  mockConsole(t)
  const provider = okProvider({ async chatCompletion() { return { content: '', finishReason: 'stop' } } })
  const state = fakeState()
  const { deps } = makeDeps({ provider })

  await runTurn(deps, state)

  assert.equal(state.messages.length, 1)
  assert.equal(state.retryTurn, 'hello')
  assert.deepEqual(state.lastError, { message: 'Provider returned no output (finish reason: stop).', status: null, code: null, type: null, retryable: true })
})

// A classified empty answer (the provider spent the turn without writing) is
// terminal: the user message stays so /edit can target it and a resume keeps it,
// and no retryTurn is stashed because replaying the same turn cannot succeed.
test('a length, content-filter or error empty answer is non-retryable and keeps the user message', async (t) => {
  const errors = captureErrors(t)
  for (const finishReason of ['length', 'content_filter', 'error']) {
    errors.length = 0
    const provider = okProvider({ async chatCompletion() { return { content: '', finishReason } } })
    const state = fakeState()
    const { deps } = makeDeps({ provider })

    await runTurn(deps, state)

    const { message, retryable } = emptyAnswerOutcome(finishReason, { mode: 'repl' })
    assert.equal(retryable, false)
    assert.deepEqual(errors, [`Error: ${message}\n`], finishReason)
    assert.deepEqual(state.lastError, { message, status: null, code: null, type: null, retryable: false }, finishReason)
    assert.equal(state.messages.length, 2, finishReason)
    assert.equal(state.messages.at(-1).role, 'user')
    assert.equal(state.messages.at(-1).content, 'hello')
    assert.equal(state.retryTurn, undefined)
  }
})

test('a length-truncated answer stores its finish reason and prints the truncation notice', async (t) => {
  mockConsole(t)
  const writes = []
  const provider = okProvider({
    async chatCompletion() {
      return { content: 'partial answer', finishReason: 'length', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  })
  const { deps } = makeDeps({ provider, stdout: { write: (s) => writes.push(String(s)) } })
  const state = fakeState()

  await runTurn(deps, state)

  assert.equal(state.messages[2].finishReason, 'length')
  assert.ok(writes.includes('Output limit reached — the answer above is incomplete.\n'))
})

test('a content-filtered answer stores its finish reason and names it in the early-end notice', async (t) => {
  mockConsole(t)
  const writes = []
  const provider = okProvider({
    async chatCompletion() {
      return { content: 'partial answer', finishReason: 'content_filter' }
    },
  })
  const { deps } = makeDeps({ provider, stdout: { write: (s) => writes.push(String(s)) } })
  const state = fakeState()

  await runTurn(deps, state)

  assert.equal(state.messages[2].finishReason, 'content_filter')
  assert.ok(writes.includes('The response ended early (finish reason: content_filter).\n'))
})

test('a normal stop finish reason is not stored and prints no notice', async (t) => {
  mockConsole(t)
  const writes = []
  const provider = okProvider({
    async chatCompletion() {
      return { content: 'Hello!', finishReason: 'stop' }
    },
  })
  const { deps } = makeDeps({ provider, stdout: { write: (s) => writes.push(String(s)) } })
  const state = fakeState()

  await runTurn(deps, state)

  assert.equal('finishReason' in state.messages[2], false)
  assert.ok(!writes.some((l) => l.includes('Output limit reached')))
})

test('an unmapped finish reason is stored but prints no notice', async (t) => {
  mockConsole(t)
  const writes = []
  const provider = okProvider({
    async chatCompletion() {
      return { content: 'Hello!', finishReason: 'tool_calls' }
    },
  })
  const { deps } = makeDeps({ provider, stdout: { write: (s) => writes.push(String(s)) } })
  const state = fakeState()

  await runTurn(deps, state)

  assert.equal(state.messages[2].finishReason, 'tool_calls')
  assert.ok(!writes.some((l) => l.includes('limit reached') || l.includes('ended early')))
})

test('an empty length-truncated answer is the output-limit verdict, keeps the user message and prints no notice', async (t) => {
  const errors = captureErrors(t)
  const writes = []
  const provider = okProvider({
    async chatCompletion() {
      return { content: '', finishReason: 'length' }
    },
  })
  const { deps } = makeDeps({ provider, stdout: { write: (s) => writes.push(String(s)) } })
  const state = fakeState()

  await runTurn(deps, state)

  const { message } = emptyAnswerOutcome('length', { mode: 'repl' })
  assert.deepEqual(errors, [`Error: ${message}\n`])
  assert.equal(state.messages.length, 2)
  assert.equal(state.retryTurn, undefined)
  assert.ok(!writes.some((l) => l.includes('Output limit reached')), 'the non-empty-only truncation notice stays silent')
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
  // The fetch-abort stop never received a completed apiResult: no usage may be
  // invented for the tracker or the persisted partial.
  assert.equal(sessionState.tracker.requests, 0)
  assert.equal(sessionState.tracker.promptTokens, 0)
  assert.equal(sessionState.tracker.completionTokens, 0)
  assert.equal(sessionState.tracker.cost, 0)
  assert.equal(sessionState.tracker.peakContext, 0)
  assert.equal('usage' in state.messages[2], false)
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


test('compact thinking starts the meter at turn start and never touches the loader', async (t) => {
  mockConsole(t)
  const calls = []
  const loader = {
    start() { calls.push(['start']) },
    stop(opts) { calls.push(['stop', opts ?? {}]) },
  }
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  render.compactThinking = true
  const started = []
  const resolved = []
  render.startTurn = (label) => started.push(label)
  render.resolveWaitingLine = () => { resolved.push(true); return false }
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

  // Compact mode: the meter owns the line from turn start (startTurn instead
  // of loader.start), the loader is never touched, and the content token
  // asks the renderer to resolve the waiting line (a no-op here because the
  // thinking checkpoint already owns the row).
  assert.deepEqual(calls, [])
  assert.deepEqual(started, ['Waiting for response'])
  assert.deepEqual(resolved, [true])
  assert.equal(state.messages[2].reasoning, 'thinking')
})

test('compact thinking resolves the waiting line for a reasoning-less turn', async (t) => {
  mockConsole(t)
  const calls = []
  const loader = {
    start() { calls.push(['start']) },
    stop(opts) { calls.push(['stop', opts ?? {}]) },
  }
  const stdout = { write() {} }
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  render.compactThinking = true
  const started = []
  const resolved = []
  render.startTurn = (label) => started.push(label)
  render.resolveWaitingLine = () => { resolved.push(true); stdout.write('\n'); return true }
  const state = fakeState({ compactThinking: true })
  const provider = {
    async chatCompletion(opts) {
      opts.onToken('Hello', 'content')
      return { content: 'Hello' }
    },
  }
  const { deps } = makeDeps({ render, loader, provider, tty: true, stdout })

  await runTurn(deps, state)

  assert.deepEqual(calls, [])
  assert.deepEqual(started, ['Waiting for response'])
  assert.deepEqual(resolved, [true])
  assert.equal(state.messages[2].content, 'Hello')
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
  // runner wrote no checkpoint and no extra blank row — the answer follows
  // the turn-start `\n\n` directly. The message must not carry a waitLine
  // either, so a resize/retry rebuild replays exactly what the live stream
  // showed.
  const live = writes.join('')
  assert.ok(!live.includes('Waiting for response'), 'no waiting line may appear for an instant reply')
  assert.equal(live, '\n\nHello\n\n', 'the answer must follow the turn-start newlines directly')
  assert.equal(state.messages[2].waitLine, undefined)
})

test('Esc stop persists accumulated content AND reasoning in the partial', async (t) => {
  mockConsole(t)
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  const provider = okProvider({
    async chatCompletion(opts) {
      opts.onToken('think', 'reasoning')
      opts.onToken('Hel', 'content')
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
  sessionState.stopped = true
  sessionState.streamController.abort()
  const produced = await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  assert.equal(state.messages[2].content, 'Hel')
  assert.equal(state.messages[2].reasoning, 'think')
  assert.equal(produced, true)
})

test('a stopped turn writes the Stopped note with a blank row above and below', async (t) => {
  enableAnsi(t)
  mockConsole(t)
  const writes = []
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
  const { deps, exitCodes } = makeDeps({
    provider,
    sessionState,
    stdout: { write: (s) => writes.push(String(s)) },
  })

  const turn = runTurn(deps, state)
  sessionState.stopped = true
  sessionState.streamController.abort()
  await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(writes, ['\n', '\n\n', `${dim('Stopped')}\n\n`])
})

test('Esc during the post-stream drain finalizes as stopped without exiting', async (t) => {
  enableAnsi(t)
  mockConsole(t)
  const writes = []
  let flushResolve
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => new Promise((resolve) => { flushResolve = resolve })
  const provider = {
    async chatCompletion(opts) {
      opts.onToken('Hello!', 'content')
      return { content: 'Hello!', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  const state = fakeState()
  const sessionState = createSessionState()
  const { deps, exitCodes, saves } = makeDeps({
    render,
    provider,
    sessionState,
    stdout: { write: (s) => writes.push(String(s)) },
  })

  const turn = runTurn(deps, state)
  while (!flushResolve) await new Promise((resolve) => setTimeout(resolve, 0))
  sessionState.stopped = true
  flushResolve()
  await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  assert.equal(state.messages[2].content, 'Hello!')
  assert.equal(state.messages.length, 3)
  assert.ok(writes.join('').includes(`${dim('Stopped')}\n\n`), 'the drain-phase stop still writes the Stopped note')
  // The stream had completed, so the drain-window stop records the billed
  // usage and persists it on the partial (a resume replays it via
  // seedTracker) without printing the turn footer.
  assert.equal(sessionState.tracker.requests, 1)
  assert.equal(sessionState.tracker.promptTokens, 10)
  assert.equal(sessionState.tracker.completionTokens, 5)
  assert.equal(sessionState.tracker.totalTokens, 15)
  assert.ok(sessionState.tracker.cost > 0)
  assert.equal(sessionState.tracker.peakContext, 10 + 5)
  assert.equal(sessionState.lastTurnMetrics, null)
  assert.deepEqual(state.messages[2].usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

test('Esc then Ctrl+C during finalize stays stopped and does not exit 130', async (t) => {
  mockConsole(t)
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  const provider = okProvider({
    async chatCompletion(opts) {
      opts.onToken('Hel', 'content')
      opts.signal.addEventListener('abort', () => {
        rejectCompletion(Object.assign(new Error('aborted'), { pendingBuffer: 'data: {"choices":[{"delta":{"content":"Hel' }))
      })
      return pending
    },
  })
  const state = fakeState()
  const sessionState = createSessionState()
  let onStop
  let onInterrupt
  const streamMonitor = { start() {}, stop() {} }
  const createStreamKeyMonitor = (opts) => {
    onStop = opts.onStop
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
  onStop() // first Esc: abort + mark stopped (stop finalizing)
  onInterrupt() // Ctrl+C arriving right after Esc must NOT flip to interrupted/exit-130
  await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  const assistants = state.messages.filter((m) => m.role === 'assistant')
  assert.equal(assistants.length, 1)
  assert.equal(sessionState.stopped, false)
  assert.equal(sessionState.stopping, false)
})

test('Esc during the post-stream drain returns the finishStopped boolean verdict', async (t) => {
  enableAnsi(t)
  mockConsole(t)
  let flushResolve
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => new Promise((resolve) => { flushResolve = resolve })
  const provider = {
    async chatCompletion(opts) {
      opts.onToken('Hello!', 'content')
      return { content: 'Hello!', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  const state = fakeState()
  const sessionState = createSessionState()
  const { deps, exitCodes, saves } = makeDeps({ render, provider, sessionState })

  const turn = runTurn(deps, state)
  while (!flushResolve) await new Promise((resolve) => setTimeout(resolve, 0))
  sessionState.stopped = true
  flushResolve()
  const produced = await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  assert.equal(state.messages[2].content, 'Hello!')
  // A drain-window stop that already appended the live partial must report the
  // message was produced (so /retry and /edit skip the full-screen rebuild).
  assert.equal(produced, true)
})

test('Esc during the post-stream drain carries the completed reasoning duration onto the stopped partial', async (t) => {
  enableAnsi(t)
  mockConsole(t)
  let flushResolve
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => new Promise((resolve) => { flushResolve = resolve })
  const provider = {
    async chatCompletion(opts) {
      opts.onToken(null, 'start_reasoning')
      opts.onToken('thinking', 'reasoning')
      opts.onToken('Hello!', 'content')
      return { content: 'Hello!', reasoning: 'thinking', reasoningMs: 2345, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
  const state = fakeState()
  const sessionState = createSessionState()
  const { deps, exitCodes, saves } = makeDeps({ render, provider, sessionState })

  const turn = runTurn(deps, state)
  while (!flushResolve) await new Promise((resolve) => setTimeout(resolve, 0))
  sessionState.stopped = true
  flushResolve()
  const produced = await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  assert.equal(state.messages[2].content, 'Hello!')
  assert.equal(state.messages[2].reasoning, 'thinking')
  // The drain-window branch passes the completed stream's reasoningMs onto
  // the stopped partial (mirroring apiResultMessage), so compact replay shows
  // the seconds the live meter checkmated at rather than count-only.
  assert.equal(state.messages[2].reasoningMs, 2345)
  assert.equal(produced, true)
})

test('Esc stop on a reasoning-less turn stashes the checkpoint label for replay', async (t) => {
  mockConsole(t)
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  const provider = okProvider({
    async chatCompletion(opts) {
      opts.onToken('Hel', 'content')
      opts.signal.addEventListener('abort', () => rejectCompletion(new Error('aborted')))
      return pending
    },
  })
  const state = fakeState()
  const sessionState = createSessionState()
  sessionState.streaming = true
  sessionState.streamController = new AbortController()
  const { deps, exitCodes, saves } = makeDeps({ provider, sessionState, tty: true })

  const turn = runTurn(deps, state)
  sessionState.stopped = true
  sessionState.streamController.abort()
  const produced = await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  assert.equal(state.messages[2].content, 'Hel')
  // Mirror the success path: a reasoning-less turn stashes the green
  // checkpoint so history replay shows the line the live stream did.
  assert.equal(state.messages[2].waitLine, 'Waiting for response')
  assert.equal(produced, true)
})

test('copies the stamped reasoning duration onto a stopped reply', async (t) => {
  mockConsole(t)
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  const provider = {
    async chatCompletion(opts) {
      opts.onToken(null, 'start_reasoning')
      opts.onToken('thinking', 'reasoning')
      opts.onToken('Hello', 'content')
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.reasoningMs = 2345
        rejectCompletion(err)
      })
      return pending
    },
  }
  const state = fakeState()
  const sessionState = createSessionState()
  sessionState.streaming = true
  sessionState.streamController = new AbortController()
  const { deps, exitCodes, saves } = makeDeps({ provider, sessionState, tty: true })

  const turn = runTurn(deps, state)
  sessionState.stopped = true
  sessionState.streamController.abort()
  const produced = await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  // The sse-parser stamps the duration on the abort; buildPartial carries it
  // onto the stopped partial exactly like apiResultMessage does on success.
  assert.equal(state.messages[2].content, 'Hello')
  assert.equal(state.messages[2].reasoning, 'thinking')
  assert.equal(state.messages[2].reasoningMs, 2345)
  assert.equal(produced, true)
})

test('rebuilds the frame after a turn whose reasoning arrived late, and does not stash a waitLine', async (t) => {
  // Late-reasoning bridge: when the provider returns late reasoning (content
  // streamed first, reasoning merged at close), apiResult.reasoning is truthy,
  // so waitLine is NOT stashed; instead the turn triggers the injected
  // rebuildAfterTurn so live becomes byte-identical to replay (`✓ Thinking`).
  mockConsole(t)
  const stdout = { write() {} }
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  render.compactThinking = true
  render.startTurn = () => {}
  const rebuilt = []
  const provider = {
    async chatCompletion() {
      return { content: 'Hello', reasoning: 'the late reasoning', reasoningMs: 500, lateReasoning: true }
    },
  }
  const state = fakeState({ compactThinking: true })
  const { deps } = makeDeps({ render, loader: { start() {}, stop() {} }, provider, tty: true, stdout })

  await runTurn(deps, state, {}, { rebuildAfterTurn: () => rebuilt.push(true) })

  assert.deepEqual(rebuilt, [true], 'the rebuild must fire exactly once on a late-reasoning turn')
  assert.equal(state.messages[2].reasoning, 'the late reasoning')
  assert.equal(state.messages[2].waitLine, undefined, 'a merged-reasoning turn must not carry a waitLine')
})

test('does not rebuild when no late reasoning (early-only or reasoning-less)', async (t) => {
  mockConsole(t)
  const stdout = { write() {} }
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  render.compactThinking = true
  render.startTurn = () => {}
  const rebuilt = []
  const provider = {
    async chatCompletion() {
      return { content: 'Hello', reasoning: 'early', lateReasoning: false }
    },
  }
  const state = fakeState({ compactThinking: true })
  const { deps } = makeDeps({ render, loader: { start() {}, stop() {} }, provider, tty: true, stdout })

  await runTurn(deps, state, {}, { rebuildAfterTurn: () => rebuilt.push(true) })

  assert.deepEqual(rebuilt, [], 'no rebuild when lateReasoning is false')
  assert.equal(state.messages[2].reasoning, 'early')
})

test('compact reasoning-less turn stashes the waitLine checkpoint, not a thinking marker', async (t) => {
  // A turn that genuinely streamed no reasoning (the model did not think, or
  // the endpoint delivered none) resolves the row to the waitLine checkpoint
  // (✓ Waiting for response + answer). This is the reasoning-less path; a
  // content-first burst that DID carry late reasoning merges it and instead
  // rebuilds through the late-reasoning bridge (✓ Thinking · N · Xs).
  mockConsole(t)
  const stdout = { write() {} }
  const render = () => {}
  render.sources = []
  render.resetMessage = () => {}
  render.flush = () => {}
  render.compactThinking = true
  const started = []
  const resolved = []
  render.startTurn = (label) => started.push(label)
  render.resolveWaitingLine = () => { resolved.push(true); stdout.write('\n'); return true }
  const state = fakeState({ compactThinking: true })
  const provider = {
    async chatCompletion(opts) {
      opts.onToken('Hello', 'content')
      return { content: 'Hello' }
    },
  }
  const { deps } = makeDeps({ render, loader: { start() {}, stop() {} }, provider, tty: true, stdout })

  await runTurn(deps, state)

  assert.equal(state.messages[2].content, 'Hello')
  assert.equal(state.messages[2].reasoning, undefined)
  assert.equal(state.messages[2].waitLine, 'Waiting for response')
  assert.ok(!('reasoningMs' in state.messages[2]))
})
