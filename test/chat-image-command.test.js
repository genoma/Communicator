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
    generateCalls: [],
    async fetchImageModels() {
      return [
        {
          id: 'flux-1-1',
          name: 'Flux 1.1',
          pricing: { perImage: 0.02, byResolution: null, byQuality: null },
          constraints: { aspectRatios: ['1:1', '16:9', '3:2'], formats: ['png', 'jpeg', 'webp'], resolutions: null, qualities: null, widthHeightDivisor: 8 },
          offline: false,
        },
      ]
    },
    async generateImage(generateArgs) {
      this.generateCalls.push(generateArgs)
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
  const stdoutChunks = []

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
    selectImageSizing: async (_message, values) => values[0],
    stdout: { write: (chunk) => stdoutChunks.push(String(chunk)) },
    ...overrides,
  }

  return { ctx, savedSessions, prefsUpdates, stdoutChunks }
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
  mockConsole(t)
  let pickerCalls = 0
  const { ctx, savedSessions, prefsUpdates, stdoutChunks } = makeCtx({
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
  assert.deepEqual(prefsUpdates, [{ lastImageModel: 'flux-1-1', imageDefaults: { venice: { aspectRatio: '1:1', format: 'png' } } }])

  const logs = stdoutChunks.join('').split('\n').filter(Boolean)
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

  assert.equal(consoleSpy.log(0), 'Usage: /image [--ratio <x:y>] [--format <png|jpeg|webp>] <description>\n')
  assert.equal(ctx.state.messages.length, before)
  assert.deepEqual(savedSessions, [])
  assert.equal(pickerCalls, 0)
})

test('/image on a provider without image models errors without calling the API', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, savedSessions } = makeCtx({
    provider: { meta: { name: 'openrouter' } },
    selectImageModel: async () => { throw new Error('picker should not run') },
  })
  const before = ctx.state.messages.length

  await chatCommands['/image']({ ...ctx, input: '/image a red cat', args: 'a red cat' })

  assert.equal(consoleSpy.error(0), 'Error: /image is not supported by openrouter.\n')
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

test('/image passes hideWatermark through from prefs to generateImage', async (t) => {
  mockConsole(t)
  const { ctx } = makeCtx({
    prefs: { hideWatermark: true },
    selectImageModel: async (models) => ({ id: models[0].id, name: models[0].name }),
  })

  await chatCommands['/image']({ ...ctx, input: '/image a red cat', args: 'a red cat' })

  assert.equal(ctx.provider.generateCalls.length, 1)
  assert.equal(ctx.provider.generateCalls[0].hideWatermark, true)
})

test('/watermark shows the current status with no argument', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/watermark'](ctx)

  assert.equal(consoleSpy.log(0), 'Venice watermark is on.\n')
})

test('/watermark status shows off when the watermark is hidden', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({ prefs: { hideWatermark: true } })

  await chatCommands['/watermark'](ctx)

  assert.equal(consoleSpy.log(0), 'Venice watermark is off.\n')
})

test('/watermark on shows the watermark and off hides it, persisting and mutating the shared prefs object', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx({ prefs: { hideWatermark: true } })

  await chatCommands['/watermark']({ ...ctx, args: 'on' })

  assert.deepEqual(prefsUpdates, [{ hideWatermark: false }])
  assert.equal(ctx.prefs.hideWatermark, false)
  assert.equal(consoleSpy.log(0), 'Venice watermark enabled.\n')

  await chatCommands['/watermark']({ ...ctx, args: 'off' })

  assert.deepEqual(prefsUpdates, [{ hideWatermark: false }, { hideWatermark: true }])
  assert.equal(ctx.prefs.hideWatermark, true)
  assert.equal(consoleSpy.log(1), 'Venice watermark disabled.\n')
})

test('/watermark with an invalid argument errors', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()

  await chatCommands['/watermark']({ ...ctx, args: 'sometimes' })

  assert.equal(consoleSpy.error(0), 'Error: /watermark expects "on" or "off".\n')
  assert.deepEqual(prefsUpdates, [])
})

test('/watermark on an openrouter session errors', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx({
    provider: fakeVeniceProvider({ meta: { name: 'openrouter' } }),
  })

  await chatCommands['/watermark']({ ...ctx, args: 'on' })

  assert.equal(consoleSpy.error(0), 'Error: /watermark is only supported on Venice sessions.\n')
  assert.deepEqual(prefsUpdates, [])
})

test('/watermark is a registered, args-accepting command visible regardless of vision support', () => {
  assert.ok(CHAT_COMMANDS.includes('/watermark'))
  assert.equal(commandAcceptsArgs('/watermark'), true)
  assert.ok(visibleChatCommands({ visionSupported: false }).includes('/watermark'))
  assert.ok(visibleChatCommands({ visionSupported: true }).includes('/watermark'))
})

test('/image --ratio and --format are parsed, validated and stripped from the appended message', async (t) => {
  mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx({
    prefs: { imageDefaults: { venice: { aspectRatio: '1:1', format: 'webp' } } },
    selectImageModel: async (models) => ({ id: models[0].id, name: models[0].name }),
  })

  await chatCommands['/image']({ ...ctx, input: '/image --ratio 16:9 --format png a red cat', args: '--ratio 16:9 --format png a red cat' })

  assert.equal(ctx.provider.generateCalls.length, 1)
  assert.equal(ctx.provider.generateCalls[0].aspectRatio, '16:9')
  assert.equal(ctx.provider.generateCalls[0].format, 'png')
  assert.equal(ctx.state.messages[1].content, 'a red cat')
  assert.deepEqual(prefsUpdates, [
    { lastImageModel: 'flux-1-1', imageDefaults: { venice: { aspectRatio: '16:9', format: 'png' } } },
  ])
})

test('/image --aspect-ratio is an alias of --ratio', async (t) => {
  mockConsole(t)
  const { ctx } = makeCtx({
    selectImageModel: async (models) => ({ id: models[0].id, name: models[0].name }),
  })

  await chatCommands['/image']({ ...ctx, input: '/image --aspect-ratio 3:2 a cat', args: '--aspect-ratio 3:2 a cat' })

  assert.equal(ctx.provider.generateCalls[0].aspectRatio, '3:2')
  assert.equal(ctx.provider.generateCalls[0].format, 'png')
  assert.equal(ctx.state.messages[1].content, 'a cat')
})

test('/image flags without a description print the usage hint', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/image']({ ...ctx, input: '/image --ratio 16:9', args: '--ratio 16:9' })

  assert.equal(consoleSpy.log(0), 'Usage: /image [--ratio <x:y>] [--format <png|jpeg|webp>] <description>\n')
  assert.equal(ctx.provider.generateCalls.length, 0)
})

test('/image with an unknown leading option errors with the usage hint', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, savedSessions } = makeCtx()

  await chatCommands['/image']({ ...ctx, input: '/image --red a cat', args: '--red a cat' })

  assert.equal(consoleSpy.error(0), 'Error: unknown /image option --red. Usage: /image [--ratio <x:y>] [--format <png|jpeg|webp>] <description>\n')
  assert.equal(ctx.provider.generateCalls.length, 0)
  assert.deepEqual(savedSessions, [])
})

test('/image --ratio without a value errors', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/image']({ ...ctx, input: '/image --ratio --format png a cat', args: '--ratio --format png a cat' })

  assert.equal(consoleSpy.error(0), 'Error: --ratio expects a value like 16:9.\n')
  assert.equal(ctx.provider.generateCalls.length, 0)
})

test('/image rejects an invalid ratio value before any generation', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/image']({ ...ctx, input: '/image --ratio wide a cat', args: '--ratio wide a cat' })

  assert.equal(consoleSpy.error(0), '\nError: --aspect-ratio must be in the form W:H (e.g. 16:9) or "auto".\n')
  assert.equal(ctx.provider.generateCalls.length, 0)
})

test('/image sizing pickers preselect the saved provider default', async (t) => {
  mockConsole(t)
  const pickerCalls = []
  const { ctx } = makeCtx({
    prefs: { imageDefaults: { venice: { aspectRatio: '1:1' } } },
    selectImageModel: async (models) => ({ id: models[0].id, name: models[0].name }),
    selectImageSizing: async (message, values, defaultValue) => {
      pickerCalls.push({ message, values, defaultValue })
      return values[0]
    },
  })

  await chatCommands['/image']({ ...ctx, input: '/image a red cat', args: 'a red cat' })

  assert.equal(pickerCalls.length, 2)
  assert.equal(pickerCalls[0].message, 'Select an aspect ratio:')
  assert.equal(pickerCalls[0].defaultValue, '1:1')
  assert.equal(pickerCalls[1].message, 'Select an image format:')
  assert.equal(pickerCalls[1].defaultValue, 'webp')
})
