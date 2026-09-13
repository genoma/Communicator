import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-image-endpoint-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const { runImageGeneration } = await import('../src/commands/image-gen.js')
const { startImageSession } = await import('../src/commands/image-session.js')

const IMG = Buffer.from('endpoint image')
const SESSION_ID = '2026-01-01T00-00-00'
const RESUME_SESSION_ID = '2026-01-01T00-00-03'
const plainStdout = { write: () => {}, isTTY: false }

const pricing = (perImage) => ({ perImage, perToken: null, byResolution: null, byQuality: null })

const CONSTRAINTS = { aspectRatios: ['1:1', '16:9'], formats: ['png', 'jpeg'], resolutions: null, qualities: null, widthHeightDivisor: null }

function imageModel(overrides = {}) {
  return { id: 'qwen/qwen-image-3', name: 'Qwen Image 3', pricing: null, constraints: { ...CONSTRAINTS }, ...overrides }
}

function imageResult() {
  return {
    id: 'gen-1',
    images: [{ bytes: IMG, dataUrl: `data:image/png;base64,${IMG.toString('base64')}`, mime: 'image/png', ext: 'png' }],
    blurred: false,
    cost: 0.02,
  }
}

function endpointProvider(endpoints) {
  const genArgs = []
  const endpointCalls = []
  return {
    meta: { name: 'openrouter' },
    genArgs,
    endpointCalls,
    async fetchImageModelEndpoints(apiKey, modelId) {
      endpointCalls.push({ apiKey, modelId })
      return endpoints
    },
    async generateImage(args) {
      genArgs.push(args)
      return imageResult()
    },
  }
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
}

function scriptedInput(values) {
  const queue = [...values]
  return async () => (queue.length === 0 ? { cancelled: true } : { value: queue.shift() })
}

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-image-endpoint-config-'))
  const file = join(dir, 'config.json')
  await writeFile(file, '{}')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return file
}

test('one-shot picks the cheapest endpoint and passes its provider and pricing to generateImage', async (t) => {
  mockConsole(t)
  const pricey = { providerName: 'Pricey Host', slug: 'pricey', tag: 'pricey', pricing: pricing(0.5) }
  const cheap = { providerName: 'Cheap Host', slug: 'cheap-slug', tag: 'cheap', pricing: pricing(0.05) }
  const provider = endpointProvider([pricey, cheap])

  const outcome = await runImageGeneration({
    provider,
    apiKey: 'k',
    prompt: 'a red cat',
    opts: {},
    prefs: {},
    model: imageModel(),
    sessionId: SESSION_ID,
    stdout: plainStdout,
  })

  assert.equal(provider.endpointCalls.length, 1)
  assert.equal(provider.endpointCalls[0].modelId, 'qwen/qwen-image-3')
  assert.equal(provider.genArgs.length, 1)
  assert.equal(provider.genArgs[0].provider, 'cheap-slug')
  assert.deepEqual(provider.genArgs[0].pricing, cheap.pricing)
  assert.equal(outcome.endpointProviderName, 'Cheap Host')
  assert.deepEqual(outcome.pricing, cheap.pricing)
})

test('one-shot falls back to the endpoint provider name when the chosen endpoint has no slug', async (t) => {
  mockConsole(t)
  const endpoint = { providerName: 'No Slug Host', slug: null, tag: null, pricing: pricing(0.03) }
  const provider = endpointProvider([endpoint])

  const outcome = await runImageGeneration({
    provider,
    apiKey: 'k',
    prompt: 'a red cat',
    opts: {},
    prefs: {},
    model: imageModel(),
    sessionId: '2026-01-01T00-00-01',
    stdout: plainStdout,
  })

  assert.equal(provider.genArgs[0].provider, 'No Slug Host')
  assert.deepEqual(provider.genArgs[0].pricing, endpoint.pricing)
  assert.equal(outcome.endpointProviderName, 'No Slug Host')
})

test('one-shot keeps a preset endpoint and never fetches endpoints for a model that already has one', async (t) => {
  mockConsole(t)
  const provider = endpointProvider([{ providerName: 'Other Host', slug: 'other', tag: null, pricing: pricing(0.01) }])
  const preset = pricing(0.09)

  const outcome = await runImageGeneration({
    provider,
    apiKey: 'k',
    prompt: 'a red cat',
    opts: {},
    prefs: {},
    model: imageModel({ imageProvider: 'preset-slug', endpointProviderName: 'Preset Host', pricing: preset }),
    sessionId: '2026-01-01T00-00-02',
    stdout: plainStdout,
  })

  assert.equal(provider.endpointCalls.length, 0)
  assert.equal(provider.genArgs[0].provider, 'preset-slug')
  assert.deepEqual(provider.genArgs[0].pricing, preset)
  assert.equal(outcome.endpointProviderName, 'Preset Host')
  assert.deepEqual(outcome.pricing, preset)
})

test('startImageSession picks a fresh endpoint when no saved imageProviderName matches', async (t) => {
  mockConsole(t)
  const file = await tempConfig(t)
  const fresh = { providerName: 'Baseten', slug: 'baseten', tag: 'baseten', pricing: pricing(0.04) }
  // A single endpoint keeps the real picker on its no-prompt shortcut; the
  // generation path is deliberately not exercised here because
  // runImageGeneration would re-select an endpoint for a model without one
  // and mask what startImageSession chose.
  const provider = {
    meta: { name: 'openrouter' },
    async fetchImageModels() {
      return [imageModel()]
    },
    async fetchImageModelEndpoints() {
      return [fresh]
    },
  }

  // A resumed session must carry history: a 1-message payload is dropped as
  // an empty claim and never reaches disk (saveSession's placeholder guard).
  const initialMessages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'old prompt' },
  ]

  await startImageSession({
    provider,
    apiKey: 'k',
    prefs: {},
    imageModelId: 'qwen/qwen-image-3',
    sessionId: RESUME_SESSION_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    initialMessages,
    imageProviderName: 'Removed Host',
    configPath: file,
    readInput: scriptedInput(['/quit']),
    stdout: plainStdout,
  })

  // The raw payload stores the endpoint provider name under `providerName`.
  const saved = JSON.parse(await readFile(join(tempHome, '.communicator', 'sessions', `${RESUME_SESSION_ID}.json`), 'utf-8'))
  assert.equal(saved.model, 'qwen/qwen-image-3')
  assert.equal(saved.providerName, 'Baseten')
  assert.deepEqual(saved.pricing, fresh.pricing)
})
