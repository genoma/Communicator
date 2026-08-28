import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { dim } from '../src/ui/style.js'

// Controllable stub for the post-stream metrics printer: lets each test decide
// whether the metrics block emits a line, and gates the await so a stop can
// land mid-metrics deterministically.
let metrics = { emits: false, line: null, entered: false, resolve: null }
mock.module(new URL('../src/artifacts.js', import.meta.url), {
  exports: {
    printPostStreamMetrics: async (_apiResult, { stdout }) => {
      metrics.entered = true
      const gate = new Promise((resolve) => { metrics.resolve = resolve })
      await gate
      if (metrics.line != null) stdout.write(metrics.line)
      return metrics.emits
    },
  },
})

const { createTurnRunner, createSessionState } = await import('../src/turn-runner.js')

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
  render.flush = async () => {}
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

function runTurn(deps, state) {
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
  })
  return runner.runTurn()
}

function okProvider() {
  return {
    async chatCompletion(opts) {
      opts.onToken('Hello!', 'content')
      return { content: 'Hello!', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
}

test('post-metrics Esc stop keeps one blank row above the Stopped note when the metrics block printed nothing', async () => {
  const writes = []
  metrics = { emits: false, line: null, entered: false, resolve: null }
  const state = fakeState()
  const sessionState = createSessionState()
  const { deps, exitCodes, saves } = makeDeps({
    provider: okProvider(),
    sessionState,
    stdout: { write: (s) => writes.push(String(s)) },
  })

  const turn = runTurn(deps, state)
  while (!metrics.entered) await new Promise((resolve) => setTimeout(resolve, 0))
  sessionState.stopped = true
  metrics.resolve()
  await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  assert.equal(state.messages[2].content, 'Hello!')
  assert.deepEqual(writes, ['\n', '\n\n', `${dim('Stopped')}\n\n`])
})

test('post-metrics Esc stop adds a blank row above the Stopped note when the metrics block emitted lines', async () => {
  const writes = []
  metrics = { emits: true, line: 'file.txt saved\n', entered: false, resolve: null }
  const state = fakeState()
  const sessionState = createSessionState()
  const { deps, exitCodes, saves } = makeDeps({
    provider: okProvider(),
    sessionState,
    stdout: { write: (s) => writes.push(String(s)) },
  })

  const turn = runTurn(deps, state)
  while (!metrics.entered) await new Promise((resolve) => setTimeout(resolve, 0))
  sessionState.stopped = true
  metrics.resolve()
  await turn

  assert.deepEqual(exitCodes, [])
  assert.deepEqual(saves, ['session'])
  assert.equal(state.messages[2].content, 'Hello!')
  assert.deepEqual(writes, ['\n', '\n\n', 'file.txt saved\n', '\n\n', `${dim('Stopped')}\n\n`])
})
