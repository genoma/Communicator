import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ApiError } from '../src/errors.js'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-turn-home-'))
mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const { createTurnRunner, createSessionState } = await import('../src/turn-runner.js')

after(() => rm(tempHome, { recursive: true, force: true }))

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
  render.flush = () => {}
  const loader = { start() {}, stop() {} }
  const exitCodes = []
  const saves = []
  const chunks = []
  const stdout = { write: (chunk) => chunks.push(String(chunk)) }
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
  return { deps, exitCodes, saves, text: () => chunks.join('') }
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

test('a turn with streamed image parts saves parts content and prints artifact lines', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const provider = {
    async chatCompletion() {
      return { content: 'Here it is', parts: [part], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    },
  }
  const { deps, text } = makeDeps({ provider })
  const state = fakeState()

  await runTurn(deps, state)

  assert.deepEqual(state.messages[2].content, [
    { type: 'text', text: 'Here it is' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ])
  assert.match(text(), /image: image\.png/)
})

test('an image part from a data URL is saved verbatim without fetching', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch') })
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const provider = {
    async chatCompletion() {
      return { content: 'Here', parts: [part] }
    },
  }
  const { deps } = makeDeps({ provider })
  const state = fakeState()

  await runTurn(deps, state)

  assert.equal(fetchMock.mock.callCount(), 0)
  assert.deepEqual(state.messages[2].content, [
    { type: 'text', text: 'Here' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ])
})

test('a remote image part is downloaded and replaced by a data URL', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('png-bytes'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }))
  const part = { type: 'image_url', image_url: { url: 'https://example.com/photo.png' } }
  const provider = {
    async chatCompletion() {
      return { content: 'Here', parts: [part] }
    },
  }
  const { deps, text } = makeDeps({ provider })
  const state = fakeState()

  await runTurn(deps, state)

  assert.deepEqual(state.messages[2].content, [
    { type: 'text', text: 'Here' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}` } },
  ])
  assert.match(text(), /image: photo\.png/)
  assert.match(text(), /saved to .*attachments[\\/]2026-01-01T00-00-00/)
})

test('a failed download keeps the remote URL and prints the failure', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', async () => { throw new ApiError('network down', { retryable: false }) })
  const part = { type: 'image_url', image_url: { url: 'https://example.com/photo.png' } }
  const provider = {
    async chatCompletion() {
      return { content: 'Here', parts: [part] }
    },
  }
  const { deps, text } = makeDeps({ provider })
  const state = fakeState()

  await runTurn(deps, state)

  assert.deepEqual(state.messages[2].content, [
    { type: 'text', text: 'Here' },
    { type: 'image_url', image_url: { url: 'https://example.com/photo.png' } },
  ])
  assert.match(text(), /download failed: network down/)
})

test('markdown images become parts for image-output models and are downloaded', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('png-bytes'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }))
  const provider = {
    async chatCompletion() {
      return { content: 'Here: ![](https://example.com/a.png)' }
    },
  }
  const { deps, text } = makeDeps({ provider })
  const state = fakeState({ imageOutputSupported: true })

  await runTurn(deps, state)

  assert.deepEqual(state.messages[2].content, [
    { type: 'text', text: 'Here: ![](https://example.com/a.png)' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}` } },
  ])
  assert.match(text(), /image: a\.png/)
})

test('markdown images stay plain text when image output is not advertised', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch') })
  const provider = {
    async chatCompletion() {
      return { content: 'Here: ![](https://example.com/a.png)' }
    },
  }
  const { deps } = makeDeps({ provider })
  const state = fakeState()

  await runTurn(deps, state)

  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(state.messages[2].content, 'Here: ![](https://example.com/a.png)')
})

test('produced parts survive an export-style round trip in the saved message', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const provider = {
    async chatCompletion() {
      return { content: 'Here', parts: [part] }
    },
  }
  const { deps } = makeDeps({ provider })
  const state = fakeState()

  await runTurn(deps, state)
  const saved = state.messages[2]
  assert.equal(saved.role, 'assistant')
  assert.deepEqual(saved.content, [
    { type: 'text', text: 'Here' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ])
  assert.equal('sources' in saved, false)
})
