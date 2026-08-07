import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chatCommands, CHAT_COMMANDS, commandAcceptsArgs, visibleChatCommands } from '../src/commands/chat/index.js'
import { ChatState } from '../src/chat-state.js'
import { UsageTracker } from '../src/tracker.js'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-chat-image-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

function fakeVeniceProvider(overrides = {}) {
  return {
    meta: { name: 'venice' },
    async fetchImageModels() {
      return [
        {
          id: 'flux-1-1',
          name: 'Flux 1.1',
          pricing: { perImage: 0.02, byResolution: null, byQuality: null },
          constraints: { aspectRatios: ['1:1'], resolutions: null, qualities: null, widthHeightDivisor: 8 },
          offline: false,
        },
      ]
    },
    async generateImage() {
      return {
        id: 'gen-1',
        images: [
          { bytes: Buffer.from('chat image'), dataUrl: 'data:image/png;base64,Y2hhdCBpbWFnZQ==', mime: 'image/png', ext: 'png' },
        ],
        blurred: false,
        cost: 0.02,
      }
    },
    ...overrides,
  }
}

function makeCtx(overrides = {}) {
  const state = new ChatState({
    modelId: 'venice-chat-model',
    endpointProviderName: 'venice',
    reasoningEffort: 'high',
    temperature: 0.7,
    budget: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    supportsReasoning: true,
    webSearch: 'off',
    webResults: null,
    webSearchSupported: true,
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelReasoning: null,
  })
  const savedSessions = []
  const prefsUpdates = []

  const ctx = {
    state,
    tracker: new UsageTracker(),
    provider: fakeVeniceProvider(),
    apiKey: 'test-key',
    prefs: {},
    systemContent: 'You are a helpful assistant.',
    saveSession: async () => { savedSessions.push(state.messages.length) },
    savePrefs: async (updates) => { prefsUpdates.push(updates) },
    runTurn: async () => {},
    render: { markdown: true, smooth: true, smoothCharsPerTick: 40 },
    newSessionId: async () => '2026-01-02T00-00-00',
    copyText: async () => ({ ok: true }),
    selectImageModel: undefined,
    ...overrides,
  }

  return { ctx, savedSessions, prefsUpdates }
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  return {
    log: (i) => console.log.mock.calls[i]?.arguments[0],
    error: (i) => console.error.mock.calls[i]?.arguments[0],
    allLogs: () => console.log.mock.calls.map((c) => String(c.arguments[0])),
    allErrors: () => console.error.mock.calls.map((c) => String(c.arguments[0])),
  }
}

test('/image generates, appends user + assistant messages and saves the session', async (t) => {
  const consoleSpy = mockConsole(t)
  let pickerCalls = 0
  const { ctx, savedSessions, prefsUpdates } = makeCtx({
    selectImageModel: async (models, lastImageModel) => {
      pickerCalls++
      assert.equal(lastImageModel, undefined)
      return { id: models[0].id, name: models[0].name }
    },
  })

  await chatCommands['/image']({ ...ctx, input: '/image a red cat', args: 'a red cat' })

  assert.equal(pickerCalls, 1)
  assert.equal(savedSessions.length, 2)
  assert.equal(ctx.state.messages.length, 3)
  const userMsg = ctx.state.messages[1]
  assert.equal(userMsg.role, 'user')
  assert.equal(userMsg.content, 'a red cat')
  const assistantMsg = ctx.state.messages[2]
  assert.equal(assistantMsg.role, 'assistant')
  assert.equal(assistantMsg.content.length, 1)
  assert.equal(assistantMsg.content[0].type, 'image_url')
  assert.ok(assistantMsg.content[0].image_url.url.startsWith('ref://attachments/'), assistantMsg.content[0].image_url.url)
  assert.deepEqual(prefsUpdates, [{ lastImageModel: 'flux-1-1' }])

  const logs = consoleSpy.allLogs()
  assert.ok(logs.some((l) => l.includes('saved to ')), logs.join('\n'))
  assert.ok(logs.some((l) => l.includes('Cost: $0.02 per image')))
})

test('/image with no args prints a usage hint and does nothing else', async (t) => {
  const consoleSpy = mockConsole(t)
  let pickerCalls = 0
  const { ctx, savedSessions } = makeCtx({
    selectImageModel: async () => { pickerCalls++ },
  })
  const before = ctx.state.messages.length

  await chatCommands['/image'](ctx)

  assert.equal(consoleSpy.log(0), 'Usage: /image <description>\n')
  assert.equal(ctx.state.messages.length, before)
  assert.deepEqual(savedSessions, [])
  assert.equal(pickerCalls, 0)
})

test('/image on an openrouter session errors without calling the API', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, savedSessions } = makeCtx({
    provider: fakeVeniceProvider({ meta: { name: 'openrouter' } }),
    selectImageModel: async () => { throw new Error('picker should not run') },
  })
  const before = ctx.state.messages.length

  await chatCommands['/image']({ ...ctx, input: '/image a red cat', args: 'a red cat' })

  assert.equal(consoleSpy.error(0), 'Error: /image is only supported on Venice sessions.\n')
  assert.equal(ctx.state.messages.length, before)
  assert.deepEqual(savedSessions, [])
})

test('/image reports generation failures without corrupting the session', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, savedSessions } = makeCtx({
    provider: fakeVeniceProvider({
      async generateImage() {
        throw new Error('boom')
      },
    }),
    selectImageModel: async (models) => ({ id: models[0].id, name: models[0].name }),
  })
  const before = ctx.state.messages.length

  await chatCommands['/image']({ ...ctx, input: '/image a red cat', args: 'a red cat' })

  assert.equal(consoleSpy.error(0), '\nError: boom\n')
  assert.equal(ctx.state.messages.length, before)
  assert.equal(savedSessions.length, 1)
})

test('/image is a registered, args-accepting command visible regardless of vision support', () => {
  assert.ok(CHAT_COMMANDS.includes('/image'))
  assert.equal(commandAcceptsArgs('/image'), true)
  assert.ok(visibleChatCommands({ visionSupported: false }).includes('/image'))
  assert.ok(visibleChatCommands({ visionSupported: true }).includes('/image'))
})
