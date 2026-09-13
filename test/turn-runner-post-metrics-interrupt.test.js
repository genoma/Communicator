import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createTurnRunner, createSessionState } from '../src/turn-runner.js'

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
      { role: 'user', content: 'make an image' },
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
    requestFn: deps.requestFn,
    sessionsDir: deps.sessionsDir ?? null,
  })
  return runner.runTurn()
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
}

const pngBytes = Buffer.from('png-bytes')

// The public IP literal keeps resolveSafeUrl off DNS, so the download only
// ever reaches the requestFn seam.
function nodeResponse({ status = 200, headers = {}, body = null } = {}) {
  const stream = Readable.from(body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)])
  stream.statusCode = status
  stream.headers = headers
  return stream
}

// requestFn seam that holds the artifact download open until release() is
// called, so the test can interrupt while the download is still in flight.
function gatedDownload(response) {
  let onResponse = null
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const requestFn = () => {
    markStarted()
    return {
      on(event, listener) {
        if (event === 'response') onResponse = listener
        return this
      },
      end() {},
    }
  }
  const release = async () => {
    while (!onResponse) await new Promise((resolve) => setTimeout(resolve, 0))
    onResponse(response)
  }
  return { requestFn, started, release }
}

test('an interrupt during the artifact download exits 130 without recording usage', async (t) => {
  mockConsole(t)
  const sessionsDir = await mkdtemp(join(tmpdir(), 'communicator-post-metrics-interrupt-'))
  t.after(() => rm(sessionsDir, { recursive: true, force: true }))
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const part = { type: 'image_url', image_url: { url: 'https://93.184.216.34/photo.png' } }
  const provider = {
    async chatCompletion() {
      return { content: 'Here it is', parts: [part], usage }
    },
  }
  const { requestFn, started, release } = gatedDownload(nodeResponse({ headers: { 'Content-Type': 'image/png' }, body: pngBytes }))
  const state = fakeState()
  const sessionState = createSessionState()
  const { deps, exitCodes, saves } = makeDeps({ provider, requestFn, sessionsDir, sessionState })

  const turn = runTurn(deps, state)
  await started
  sessionState.interrupted = true
  await release()
  await turn

  assert.deepEqual(exitCodes, [130])
  assert.deepEqual(saves, ['interrupt'])
  assert.equal(state.messages.length, 3)
  assert.equal(state.messages[2].role, 'assistant')
  assert.deepEqual(state.messages[2].content, [
    { type: 'text', text: 'Here it is' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}` } },
  ])
  assert.deepEqual(state.messages[2].usage, usage)
  assert.equal(sessionState.tracker.requests, 0)
  assert.equal(sessionState.lastTurnMetrics, null)
})
