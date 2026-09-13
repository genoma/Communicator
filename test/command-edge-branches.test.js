import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../src/errors.js'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-edge-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

let searchAnswers = []
let selectAnswers = []
let checkboxAnswers = []
const selectCalls = []
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async () => searchAnswers.shift(),
    select: async (opts) => {
      selectCalls.push(opts)
      return selectAnswers.shift()
    },
    checkbox: async () => checkboxAnswers.shift(),
    confirm: async () => false,
  },
})

// chat-start's text branch must never open a real REPL here.
mock.module(new URL('../src/chat.js', import.meta.url).href, {
  namedExports: {
    startChat: async (...args) => {
      return { modelId: args[1], providerType: args[6].meta.name, messages: [] }
    },
  },
})

const imageSessionCalls = []
mock.module(new URL('../src/commands/image-session.js', import.meta.url).href, {
  namedExports: {
    startImageSession: async (opts) => {
      imageSessionCalls.push(opts)
    },
  },
})

let resumeResult = null
mock.module(new URL('../src/commands/resume.js', import.meta.url).href, {
  namedExports: {
    resumeCmd: async () => resumeResult,
  },
})

const { configViewCmd } = await import('../src/commands/config-view.js')
const { listSessionsCmd } = await import('../src/commands/list-sessions.js')
const { deleteAllSessionsCmd } = await import('../src/commands/delete-all-cmd.js')
const { exportCmd } = await import('../src/commands/export-cmd.js')
const { listEndpointsCmd } = await import('../src/commands/list-endpoints.js')
const { runImageGeneration } = await import('../src/commands/image-gen.js')
const { chatStart } = await import('../src/commands/chat-start.js')
// chat-start imports the mocked image session above; this file drives the real
// one for the bare /format and /aspect branches.
const { startImageSession } = await import('../src/commands/image-session.js?real')
const { DEFAULT_CONFIG_FILE } = await import('../src/constants.js')
const { resetModelCaches } = await import('../src/providers/venice.js')

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function mockConsole(t) {
  const logs = []
  const errors = []
  t.mock.method(console, 'log', (line) => logs.push(String(line)))
  t.mock.method(console, 'error', (line) => errors.push(String(line)))
  t.mock.method(console, 'warn', () => {})
  return { logs, errors }
}

function setStdinTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original)
    else delete process.stdin.isTTY
  })
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function tempConfig(t) {
  const dir = await tempDir(t, 'communicator-edge-config-')
  const file = join(dir, 'config.json')
  await writeFile(file, '{}\n')
  return file
}

function withVeniceApiKey(t, value = 'venice-edge-key') {
  const previous = process.env.VENICE_API_KEY
  process.env.VENICE_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.VENICE_API_KEY
    else process.env.VENICE_API_KEY = previous
  })
}

function scriptedInput(values) {
  const queue = [...values]
  return async () => (queue.length === 0 ? { cancelled: true } : { value: queue.shift() })
}

function sessionData(overrides = {}) {
  return {
    model: 'test/model',
    providerName: 'ProviderX',
    providerType: 'openrouter',
    reasoningEffort: 'low',
    temperature: 0.9,
    budget: 5,
    webSearch: 'off',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ],
    ...overrides,
  }
}

async function seedSession(id) {
  const { ensureSessionsDir, saveSession } = await import('../src/sessions.js')
  const dir = await ensureSessionsDir()
  await saveSession(dir, id, sessionData())
  return dir
}

test('configViewCmd reports an empty store and pretty-prints saved preferences', async (t) => {
  const { logs } = mockConsole(t)

  await configViewCmd()

  assert.deepEqual(logs, [`Config file: ${DEFAULT_CONFIG_FILE}`, 'No preferences saved yet.'])

  const prefs = { lastModel: 'org/model', imageDefaults: { venice: { format: 'webp' } } }
  await writeFile(DEFAULT_CONFIG_FILE, JSON.stringify(prefs))
  logs.length = 0

  await configViewCmd()

  assert.equal(logs[0], `Config file: ${DEFAULT_CONFIG_FILE}`)
  assert.deepEqual(logs.slice(1), [JSON.stringify(prefs, null, 2)])
})

test('listSessionsCmd reports an empty sessions store', async (t) => {
  const { logs } = mockConsole(t)

  await listSessionsCmd()

  assert.deepEqual(logs, ['No saved sessions found.'])
})

test('deleteAllSessionsCmd reports an empty store instead of a delete count', async (t) => {
  const { logs } = mockConsole(t)
  setStdinTTY(t, false)

  await deleteAllSessionsCmd('y')

  assert.deepEqual(logs, ['No saved sessions found.'])
})

function fakeSizingProvider(overrides = {}) {
  return {
    meta: { name: 'venice' },
    async fetchImageModels() {
      return [{
        id: 'flux-1-1',
        name: 'Flux 1.1',
        pricing: { perImage: 0.02 },
        constraints: {
          aspectRatios: ['1:1', '16:9'],
          formats: ['png', 'jpeg', 'webp'],
          resolutions: null,
          qualities: null,
          widthHeightDivisor: null,
        },
      }]
    },
    async generateImage(args) {
      this.genArgs = args
      return {
        id: 'gen-1',
        images: [{ bytes: Buffer.from('img'), dataUrl: 'data:image/png;base64,aW1n', mime: 'image/png', ext: 'png' }],
        blurred: false,
        cost: 0.02,
      }
    },
    ...overrides,
  }
}

const plainStdout = { write: () => {}, isTTY: false }

test('runImageGeneration rejects an explicit format when the model takes no format at all', async (t) => {
  mockConsole(t)
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'openai/gpt-image-1-mini', name: 'Mini', pricing: null, constraints: { aspectRatios: null, formats: null, resolutions: null, qualities: null, widthHeightDivisor: null } }]
    },
  })

  await assert.rejects(
    runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'openai/gpt-image-1-mini', imageFormat: 'png' }, prefs: {}, sessionId: '2026-01-01T00-00-00', stdout: plainStdout }),
    (err) => err instanceof CliError && err.message === 'Error: --image-format png is not supported by openai/gpt-image-1-mini.'
  )
})

test('the format picker runs without a preselect when the model offers no fallback format', async (t) => {
  mockConsole(t)
  selectCalls.length = 0
  selectAnswers = ['jpeg']
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'flux-1-1', name: 'Flux 1.1', pricing: null, constraints: { aspectRatios: null, formats: ['jpeg'], resolutions: null, qualities: null, widthHeightDivisor: null } }]
    },
  })

  const outcome = await runImageGeneration({
    provider,
    apiKey: 'k',
    prompt: 'x',
    opts: { imageModel: 'flux-1-1' },
    prefs: {},
    sessionId: '2026-01-01T00-00-00',
    sizingInteractive: true,
    stdout: plainStdout,
  })

  assert.equal(selectCalls.length, 1)
  assert.equal(selectCalls[0].message, 'Select an image format:')
  assert.equal(selectCalls[0].default, undefined)
  assert.equal(provider.genArgs.format, 'jpeg')
  assert.equal(outcome.prefsUpdates.format, 'jpeg')
  assert.equal(outcome.sizing, 'jpeg')
})

test('runImageGeneration reports no model selected when the interactive picker returns nothing', async (t) => {
  mockConsole(t)
  setStdinTTY(t, true)
  searchAnswers = []
  const provider = fakeSizingProvider()

  await assert.rejects(
    runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: {}, prefs: {}, sessionId: '2026-01-01T00-00-00', stdout: { write: () => {}, isTTY: true } }),
    (err) => err instanceof CliError && err.message === 'Error: no image model selected.'
  )
})

const noConstraintsProvider = {
  meta: { name: 'venice' },
  async fetchImageModels() {
    return [{ id: 'venice-raw', name: 'Raw Model', pricing: null }]
  },
}

test('bare /format and /aspect report not-set values when the model carries no constraints', async (t) => {
  const { logs } = mockConsole(t)
  const configPath = await tempConfig(t)

  await startImageSession({
    provider: noConstraintsProvider,
    apiKey: 'k',
    prefs: {},
    imageModelId: 'venice-raw',
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    configPath,
    stdout: { write: () => {} },
    readInput: scriptedInput(['/format', '/aspect', '/quit']),
  })

  const lines = logs.map((line) => line.trim())
  assert.ok(lines.includes('Format: not set.'), logs.join('\n'))
  assert.ok(lines.includes('Aspect ratio: not set.'), logs.join('\n'))
})

test('bare /format and /aspect show the saved provider default when one is stored', async (t) => {
  const { logs } = mockConsole(t)
  const configPath = await tempConfig(t)

  await startImageSession({
    provider: noConstraintsProvider,
    apiKey: 'k',
    prefs: { imageDefaults: { venice: { format: 'webp', aspectRatio: '1:1' } } },
    imageModelId: 'venice-raw',
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    configPath,
    stdout: { write: () => {} },
    readInput: scriptedInput(['/format', '/aspect', '/quit']),
  })

  const lines = logs.map((line) => line.trim())
  assert.ok(lines.includes('Format: webp.'), logs.join('\n'))
  assert.ok(lines.includes('Aspect ratio: 1:1.'), logs.join('\n'))
})

function chatStartBaseOpts(overrides = {}) {
  return {
    model: undefined,
    temperature: undefined,
    budget: undefined,
    reasoningEffort: undefined,
    webSearch: undefined,
    webResults: undefined,
    attach: [],
    smoothStreaming: true,
    smoothSpeed: undefined,
    config: undefined,
    resume: undefined,
    e2ee: undefined,
    zdr: undefined,
    image: undefined,
    ...overrides,
  }
}

function resumeSession(overrides = {}) {
  return {
    modelId: 'test/model',
    providerName: 'ProviderX',
    providerType: 'openrouter',
    reasoningEffort: 'low',
    temperature: 0.9,
    topP: 0.8,
    budget: 5,
    webSearch: 'off',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    contextLength: 128000,
    initialMessages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ],
    sessionId: '2026-01-01T00-00-00',
    sessionCreatedAt: '2026-01-01T00:00:00.000Z',
    visionSupported: true,
    fileSupported: false,
    imageOutputSupported: true,
    ...overrides,
  }
}

const rpgChapter = {
  providerType: 'venice',
  isImageModel: true,
  modelId: 'venice-sd35',
  turns: [{ role: 'assistant', content: 'Welcome to the keep.' }],
  sessionId: '2026-01-01T00-00-00',
  sessionCreatedAt: '2026-01-01T00:00:00.000Z',
}

test('chatStart refuses an --rpg chapter that resolves to an image model', async (t) => {
  mockConsole(t)
  withVeniceApiKey(t)
  imageSessionCalls.length = 0

  await assert.rejects(
    chatStart({
      apiKey: 'k',
      opts: chatStartBaseOpts({ resume: '2026-01-01', rpg: '/tmp/some-story' }),
      prefs: {},
      systemPrompt: null,
      providerType: 'venice',
      rpgResume: rpgChapter,
    }),
    (err) => err instanceof CliError && err.message === 'Error: --rpg is for text chat models only; the selected model is an image model.'
  )
  assert.deepEqual(imageSessionCalls, [], 'the chapter must not degrade into an image session')
})

test('chatStart resolves a legacy image session through the catalog and keeps its saved identity', async (t) => {
  mockConsole(t)
  withVeniceApiKey(t)
  resetModelCaches()
  t.after(resetModelCaches)
  imageSessionCalls.length = 0
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [{ id: 'venice-sd35', model_spec: { name: 'SD 3.5', constraints: { aspectRatios: ['1:1'] }, pricing: { generation: { usd: 0.02 } } } }],
  }))
  resumeResult = resumeSession({
    isImageModel: undefined,
    providerType: 'venice',
    providerName: 'venice',
    modelId: 'venice-sd35',
    pricing: { perImage: 0.02 },
    sessionUpdatedAt: '2026-01-01T00:00:05.000Z',
  })
  const configFile = await tempConfig(t)

  await chatStart({
    apiKey: 'k',
    opts: chatStartBaseOpts({ resume: '2026-01-01', config: configFile }),
    prefs: {},
    systemPrompt: null,
    providerType: 'venice',
  })

  assert.equal(imageSessionCalls.length, 1)
  const call = imageSessionCalls[0]
  assert.equal(call.imageModelId, 'venice-sd35')
  assert.equal(call.sessionId, '2026-01-01T00-00-00')
  assert.equal(call.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(call.imageProviderName, 'venice')
  assert.deepEqual(call.pricing, { perImage: 0.02 })
  assert.equal(call.configPath, configFile)
  assert.equal(call.initialMessages.length, 3)
})

test('listEndpointsCmd rejects an empty or blank model value', async () => {
  const provider = { meta: { name: 'openrouter', hasEndpoints: true } }

  for (const value of ['', '   ']) {
    await assert.rejects(
      listEndpointsCmd(provider, 'key', value, {}),
      (err) => err instanceof CliError && err.message === 'Error: --list-endpoints requires a model id. Use --list-models to list available models.',
      `value: ${JSON.stringify(value)}`
    )
  }
})

test('exportCmd validates the format only after a session was selected', async (t) => {
  const { logs } = mockConsole(t)
  await seedSession('2026-02-01T00-00-00')
  const outDir = await tempDir(t, 'communicator-edge-export-')

  await assert.rejects(
    exportCmd('2026-02-01', outDir, 'csv'),
    (err) => err instanceof CliError && err.message === 'Error: --export-format expects "markdown" or "jsonl".'
  )

  // A cancelled selection returns before the format is validated.
  checkboxAnswers = [[]]
  await exportCmd(null, outDir, 'csv')

  assert.ok(logs.includes('Export cancelled.'), logs.join('\n'))
})
