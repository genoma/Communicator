import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { CliError } from '../src/errors.js'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-image-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

let searchCalls = []
let selectCalls = []
let selectAnswers = []
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async (opts) => {
      searchCalls.push(opts)
      return { id: 'flux-1-1', name: 'Flux 1.1' }
    },
    select: async (opts) => {
      selectCalls.push(opts)
      return selectAnswers.shift()
    },
    checkbox: async () => { throw new Error('unexpected checkbox') },
  },
})

const { imageGenCmd, runImageGeneration } = await import('../src/commands/image-gen.js')

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const IMAGE_MODELS = [
  {
    id: 'flux-1-1',
    model_spec: {
      name: 'Flux 1.1',
      description: 'Fast diffusion',
      privacy: 'anonymized',
      constraints: {
        aspectRatios: ['1:1', '16:9'],
        resolutions: ['1K', '2K'],
        qualities: ['low', 'high'],
        promptCharacterLimit: 2048,
        steps: { default: 25, max: 50 },
        widthHeightDivisor: 8,
      },
      pricing: { generation: { usd: 0.02, diem: 0.02 } },
    },
  },
  {
    id: 'z-image-turbo',
    model_spec: {
      name: 'Z-Image Turbo',
      description: 'Fast pixel model',
      privacy: 'anonymized',
      constraints: {
        aspectRatios: null,
        promptCharacterLimit: 2048,
        widthHeightDivisor: 8,
      },
      pricing: { generation: { usd: 0.01, diem: 0.01 } },
    },
  },
]

const IMG1 = Buffer.from('hello image')
const IMG2 = Buffer.from('second image')
const B64_1 = IMG1.toString('base64')
const B64_2 = IMG2.toString('base64')

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function mockVeniceFetch(t, { onGenerate } = {}) {
  const bodies = []
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push(String(url))
    if (String(url).includes('/image/generate')) {
      bodies.push(JSON.parse(opts.body))
      if (onGenerate) return onGenerate(opts)
      return jsonResponse({ id: 'gen-1', images: [B64_1, B64_2], timing: {} })
    }
    if (String(url).includes('/models?type=image')) {
      return jsonResponse({ data: IMAGE_MODELS })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  return { bodies, calls }
}

function withApiKey(t, value = 'test-key') {
  const previous = process.env.VENICE_API_KEY
  process.env.VENICE_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.VENICE_API_KEY
    else process.env.VENICE_API_KEY = previous
  })
}

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-image-config-'))
  const file = join(dir, 'config.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return file
}

const BASE_OPTS = {
  image: true,
  imageModel: 'flux-1-1',
  imageFormat: undefined,
  variants: undefined,
  aspectRatio: undefined,
  resolution: undefined,
  quality: undefined,
  seed: undefined,
  width: undefined,
  height: undefined,
  safeMode: true,
  watermark: true,
  outputDir: undefined,
  config: undefined,
}

const opts = (overrides = {}) => ({ ...BASE_OPTS, ...overrides })

async function runImageGen(t, { overrides = {}, prefs = {}, prompt = 'a red cat' } = {}) {
  const stdoutChunks = []
  const stdout = { write: (chunk) => stdoutChunks.push(String(chunk)), isTTY: process.stdout.isTTY === true }
  try {
    await imageGenCmd({ apiKey: 'test-key', opts: opts(overrides), prefs, providerType: 'venice', prompt, stdout })
    return { exited: false, stdoutChunks }
  } catch (e) {
    if (e instanceof CliError) return { exited: true, message: e.message, stdoutChunks }
    throw e
  }
}

async function sessionsDir() {
  return join(tempHome, '.communicator', 'sessions')
}

function mockConsole(t) {
  const stderrChunks = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.method(process.stderr, 'write', (chunk) => { stderrChunks.push(String(chunk)) })
  return {
    logs: () => console.log.mock.calls.map((c) => String(c.arguments[0])),
    warns: () => console.warn.mock.calls.map((c) => String(c.arguments[0])),
    stderrLines: () => stderrChunks.join('').split('\n').filter(Boolean),
  }
}

function setStdoutTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original)
    else delete process.stdout.isTTY
  })
}

function setStdinTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original)
    else delete process.stdin.isTTY
  })
}

test('--image happy path writes a resumable session with refs and prints saved/cost lines', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  const file = await tempConfig(t)
  mockConsole(t)

  const dir = await sessionsDir()
  const before = new Set((await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json') && !f.startsWith('.')))

  const { exited, stdoutChunks } = await runImageGen(t, { overrides: { config: file }, prefs: {} })
  assert.equal(exited, false)

  const created = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.') && !before.has(f))
  assert.equal(created.length, 1)
  const saved = JSON.parse(await readFile(join(dir, created[0]), 'utf-8'))
  assert.equal(saved.providerType, 'venice')
  assert.equal(saved.model, 'flux-1-1')
  assert.equal(saved.messages.length, 3)
  assert.equal(saved.messages[0].role, 'system')
  assert.equal(saved.messages[1].role, 'user')
  assert.equal(saved.messages[1].content, 'a red cat')
  const parts = saved.messages[2].content
  assert.equal(parts.length, 2)
  assert.equal(parts[0].type, 'image_url')
  assert.ok(parts[0].image_url.url.startsWith('ref://attachments/'), parts[0].image_url.url)
  assert.equal(parts[0].image_url.url, `ref://attachments/${hash(IMG1)}.webp`)
  assert.equal(parts[1].image_url.url, `ref://attachments/${hash(IMG2)}.webp`)

  const blobDir = join(dir, 'attachments', created[0].slice(0, -5))
  const blobs = await readdir(blobDir)
  assert.deepEqual(blobs.sort(), [`${hash(IMG1)}.webp`, `${hash(IMG2)}.webp`])
  assert.deepEqual(await readFile(join(blobDir, `${hash(IMG1)}.webp`)), IMG1)
  assert.deepEqual(await readFile(join(blobDir, `${hash(IMG2)}.webp`)), IMG2)

  const logs = stdoutChunks.join('').split('\n').filter(Boolean)
  assert.ok(logs.some((l) => l === `saved to ${join(blobDir, `${hash(IMG1)}.webp`)}`), logs.join('\n'))
  assert.ok(logs.some((l) => l === `saved to ${join(blobDir, `${hash(IMG2)}.webp`)}`))
  assert.ok(logs.some((l) => l === 'Cost: $0.02 per image × 2 = $0.04'), logs.join('\n'))

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastImageModel, 'flux-1-1')
})

test('--image with --image-model skips the picker', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)

  const { exited } = await runImageGen(t, {})
  assert.equal(exited, false)
  assert.equal(searchCalls.length, 0)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].model, 'flux-1-1')
  assert.equal(bodies[0].prompt, 'a red cat')
  assert.equal(bodies[0].format, 'webp')
  assert.equal(bodies[0].variants, 1)
  assert.equal(bodies[0].safe_mode, true)
})

test('--image without --image-model uses the picker on a TTY', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  setStdoutTTY(t, true)
  setStdinTTY(t, true)
  mockConsole(t)
  searchCalls = []

  const { exited } = await runImageGen(t, { overrides: { imageModel: undefined } })

  assert.equal(exited, false)
  assert.equal(searchCalls.length, 1)
  assert.equal(searchCalls[0].message, 'Select an image model')
})

test('--image without --image-model and no TTY errors with the -m-style wording', async (t) => {
  withApiKey(t)
  setStdoutTTY(t, false)

  const { exited, message } = await runImageGen(t, { overrides: { imageModel: undefined } })

  assert.equal(exited, true)
  assert.equal(message, 'Error: interactive model selection needs a TTY. Use --image-model <id> when piping input.')
})

test('--image without a prompt errors before any API call', async (t) => {
  withApiKey(t)
  setStdinTTY(t, true)

  const { exited, message } = await runImageGen(t, { prompt: '' })

  assert.equal(exited, true)
  assert.equal(message, 'Error: no prompt provided. Pass a prompt argument or pipe input via stdin.')
})

test('--image reads the prompt from piped stdin', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  const originalStdin = process.stdin
  const stdinMock = Readable.from([Buffer.from('piped cat')])
  Object.defineProperty(process, 'stdin', { value: stdinMock, configurable: true })
  t.after(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
  })
  mockConsole(t)

  const { exited } = await runImageGen(t, { prompt: '' })

  assert.equal(exited, false)
  assert.equal(bodies[0].prompt, 'piped cat')
  const dir = await sessionsDir()
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  const matches = []
  for (const f of files) {
    const saved = JSON.parse(await readFile(join(dir, f), 'utf-8'))
    if (saved.messages.some((m) => m.role === 'user' && m.content === 'piped cat')) matches.push(saved)
  }
  assert.equal(matches.length, 1)
})

test('--image sizing/format/variants/seed/safe-mode flags reach generateImage', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)

  const { exited } = await runImageGen(t, {
    overrides: {
      imageFormat: 'png',
      variants: '2',
      aspectRatio: '16:9',
      quality: 'high',
      seed: '7',
      safeMode: false,
    },
  })

  assert.equal(exited, false)
  const body = bodies[0]
  assert.equal(body.format, 'png')
  assert.equal(body.variants, 2)
  assert.equal(body.aspect_ratio, '16:9')
  assert.equal(body.quality, 'high')
  assert.equal(body.seed, 7)
  assert.equal(body.safe_mode, false)
  assert.equal(body.width, undefined)
  assert.equal(body.height, undefined)
})

test('--image --width/--height are passed through', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)

  const { exited } = await runImageGen(t, { overrides: { width: '1024', height: '768' } })

  assert.equal(exited, false)
  assert.equal(bodies[0].width, 1024)
  assert.equal(bodies[0].height, 768)
})

test('--image rejects flags that violate the model constraints', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)

  const { exited, message } = await runImageGen(t, { overrides: { aspectRatio: '21:9' } })

  assert.equal(exited, true)
  assert.equal(message, 'Error: --aspect-ratio 21:9 is not supported by flux-1-1. Supported: 1:1, 16:9.')

  const { exited: ex2, message: msg2 } = await runImageGen(t, { overrides: { resolution: '4K' } })
  assert.equal(ex2, true)
  assert.equal(msg2, 'Error: --resolution 4K is not supported by flux-1-1. Supported: 1K, 2K.')

  const { exited: ex3, message: msg3 } = await runImageGen(t, { overrides: { quality: 'medium' } })
  assert.equal(ex3, true)
  assert.equal(msg3, 'Error: --quality medium is not supported by flux-1-1. Supported: low, high.')

  const { exited: ex4, message: msg4 } = await runImageGen(t, { overrides: { width: '1023' } })
  assert.equal(ex4, true)
  assert.equal(msg4, 'Error: --width 1023 must be divisible by 8 for flux-1-1.')
})

test('--image with an unknown --image-model errors before any generation call', async (t) => {
  const { bodies, calls } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)

  const { exited, message } = await runImageGen(t, { overrides: { imageModel: 'unknown-model', aspectRatio: '21:9' } })

  assert.equal(exited, true)
  assert.equal(message, 'Error: image model unknown-model not found. Use --list-image-models to see available models.')
  assert.equal(calls.length, 1)
  assert.equal(bodies.length, 0)
})

test('--image --output-dir copies the generated images there', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const outDir = await mkdtemp(join(tmpdir(), 'communicator-image-out-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))

  const { exited } = await runImageGen(t, { overrides: { outputDir: outDir } })

  assert.equal(exited, false)
  const copies = (await readdir(outDir)).sort()
  assert.deepEqual(copies, [`${hash(IMG1)}.webp`, `${hash(IMG2)}.webp`])
  assert.deepEqual(await readFile(join(outDir, `${hash(IMG1)}.webp`)), IMG1)
})

test('--image generation failure wraps into a CliError and persists nothing', async (t) => {
  mockVeniceFetch(t, {
    onGenerate: () => new Response('nope', { status: 401 }),
  })
  withApiKey(t)
  mockConsole(t)
  const dir = await sessionsDir()
  const before = new Set((await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json') && !f.startsWith('.')))
  const attachments = join(dir, 'attachments')
  const attBefore = new Set(await readdir(attachments).catch(() => []))

  const { exited, message } = await runImageGen(t, {})
  assert.equal(exited, true)
  assert.ok(message.includes('Invalid API key'), message)

  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.') && !before.has(f))
  assert.equal(files.length, 0)
  const createdDirs = (await readdir(attachments).catch(() => [])).filter((d) => !attBefore.has(d))
  assert.deepEqual(createdDirs, [])
})

test('--image prints the blur warning when the response is blurred', async (t) => {
  mockVeniceFetch(t, {
    onGenerate: () => jsonResponse({ id: 'gen-1', images: [B64_1], timing: {} }, 200, { 'x-venice-is-blurred': 'true' }),
  })
  withApiKey(t)
  const consoleSpy = mockConsole(t)

  const { exited } = await runImageGen(t, {})
  assert.equal(exited, false)
  assert.ok(consoleSpy.stderrLines().some((w) => w.includes('blurred')))
})

test('--image picker ordering uses lastImageModel on a second run', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  setStdoutTTY(t, true)
  setStdinTTY(t, true)
  mockConsole(t)
  searchCalls = []

  await runImageGen(t, { overrides: { imageModel: undefined }, prefs: { lastImageModel: 'flux-1-1' } })

  assert.equal(searchCalls.length, 1)
  const choices = await searchCalls[0].source('')
  assert.equal(choices[0].value.id, 'flux-1-1')
})

test('--image --no-watermark sends hide_watermark and persists the pref', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited } = await runImageGen(t, { overrides: { config: file, watermark: false } })

  assert.equal(exited, false)
  assert.equal(bodies[0].hide_watermark, true)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.hideWatermark, true)
})

test('--image without the flag honors a persisted hideWatermark pref without rewriting it', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited } = await runImageGen(t, { overrides: { config: file }, prefs: { hideWatermark: true } })

  assert.equal(exited, false)
  assert.equal(bodies[0].hide_watermark, true)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.hideWatermark, true)
  assert.equal(Object.keys(prefs).includes('hideWatermark'), true)
})

test('--image without the flag and no pref sends no hide_watermark and adds no pref key', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited } = await runImageGen(t, { overrides: { config: file } })

  assert.equal(exited, false)
  assert.equal(bodies[0].hide_watermark, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.hideWatermark, undefined)
})

test('--image --no-safe-mode sends safe_mode false and persists the pref', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited } = await runImageGen(t, { overrides: { config: file, safeMode: false } })

  assert.equal(exited, false)
  assert.equal(bodies[0].safe_mode, false)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.safeMode, false)
})

test('--image without the flag honors a persisted safeMode pref without rewriting it', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited } = await runImageGen(t, { overrides: { config: file }, prefs: { safeMode: false } })

  assert.equal(exited, false)
  assert.equal(bodies[0].safe_mode, false)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.safeMode, false)
  assert.equal(Object.keys(prefs).includes('safeMode'), true)
})

test('--image without the flag and no pref sends safe_mode true and adds no pref key', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited } = await runImageGen(t, { overrides: { config: file } })

  assert.equal(exited, false)
  assert.equal(bodies[0].safe_mode, true)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.safeMode, undefined)
})

test('--image rejects an invalid flag value with a CliError', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)

  const { exited, message } = await runImageGen(t, { overrides: { variants: '9' } })

  assert.equal(exited, true)
  assert.equal(message, 'Error: --variants must be an integer between 1 and 4.')
})

function fakeSizingProvider(overrides = {}) {
  return {
    meta: { name: 'venice' },
    async fetchImageModels() {
      return [
        {
          id: 'flux-1-1',
          name: 'Flux 1.1',
          pricing: { perImage: 0.02, byResolution: null, byQuality: null },
          constraints: {
            aspectRatios: ['1:1', '16:9'],
            formats: ['png', 'jpeg', 'webp'],
            resolutions: null,
            qualities: null,
            widthHeightDivisor: null,
          },
        },
      ]
    },
    async generateImage(args) {
      this.genArgs = args
      return {
        id: 'gen-1',
        images: [{ bytes: IMG1, dataUrl: `data:image/png;base64,${B64_1}`, mime: 'image/png', ext: 'png' }],
        blurred: false,
        cost: 0.02,
      }
    },
    ...overrides,
  }
}

const plainStdout = { write: () => {}, isTTY: false }

test('runImageGeneration validates an explicit format against the model list', async (t) => {
  mockConsole(t)
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'flux-1-1', name: 'Flux 1.1', pricing: null, constraints: { aspectRatios: null, formats: ['png', 'jpeg'], resolutions: null, qualities: null, widthHeightDivisor: null } }]
    },
  })

  await assert.rejects(
    runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'flux-1-1', imageFormat: 'webp' }, prefs: {}, sessionId: '2026-01-01T00-00-00', stdout: plainStdout }),
    (err) => err instanceof CliError && err.message === 'Error: --image-format webp is not supported by flux-1-1. Supported: png, jpeg.'
  )
})

test('runImageGeneration drops unsupported saved defaults with a note on OpenRouter', async (t) => {
  const warns = []
  t.mock.method(console, 'warn', (m) => { warns.push(String(m)) })
  const provider = fakeSizingProvider({
    meta: { name: 'openrouter' },
    async fetchImageModels() {
      return [{ id: 'openai/gpt-image-1-mini', name: 'Mini', pricing: null, constraints: { aspectRatios: ['1:1', '3:2'], formats: null, resolutions: null, qualities: null, widthHeightDivisor: null } }]
    },
    async generateImage(args) {
      this.genArgs = args
      return { id: 'g1', images: [{ bytes: IMG1, dataUrl: `data:image/png;base64,${B64_1}`, mime: 'image/png', ext: 'png' }], blurred: false, cost: null }
    },
  })
  const prefs = { imageDefaults: { openrouter: { aspectRatio: '16:9', format: 'png' } } }

  const outcome = await runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'openai/gpt-image-1-mini' }, prefs, sessionId: '2026-01-01T00-00-00', stdout: plainStdout })

  assert.equal(provider.genArgs.aspectRatio, undefined)
  assert.equal(provider.genArgs.format, undefined)
  assert.equal(outcome.prefsUpdates, undefined)
  assert.ok(warns.some((w) => w.includes('saved aspect ratio 16:9 is not supported by openai/gpt-image-1-mini; it was not sent.')), warns.join('\n'))
  assert.ok(warns.some((w) => w.includes('saved format png is not supported by openai/gpt-image-1-mini; it was not sent.')), warns.join('\n'))
})

test('runImageGeneration drops a saved ratio outside the hardcoded presets with a note on a pixel-based Venice model', async (t) => {
  const warns = []
  t.mock.method(console, 'warn', (m) => { warns.push(String(m)) })
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'z-image-turbo', name: 'Z-Image Turbo', pricing: null, constraints: { aspectRatios: null, formats: ['png', 'jpeg', 'webp'], resolutions: null, qualities: null, widthHeightDivisor: 8 } }]
    },
  })
  const prefs = { imageDefaults: { venice: { aspectRatio: 'auto', format: 'webp' } } }

  await runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'z-image-turbo' }, prefs, sessionId: '2026-01-01T00-00-00', stdout: plainStdout })

  assert.equal(provider.genArgs.aspectRatio, undefined)
  assert.equal(provider.genArgs.width, undefined)
  assert.equal(provider.genArgs.height, undefined)
  assert.equal(provider.genArgs.format, 'webp')
  assert.ok(warns.some((w) => w.includes('saved aspect ratio auto is not supported by z-image-turbo; it was not sent.')), warns.join('\n'))
})

test('runImageGeneration rejects an explicit aspect ratio outside the hardcoded presets on a pixel-based model', async (t) => {
  mockConsole(t)
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'z-image-turbo', name: 'Z-Image Turbo', pricing: null, constraints: { aspectRatios: null, formats: ['png', 'jpeg', 'webp'], resolutions: null, qualities: null, widthHeightDivisor: 8 } }]
    },
  })

  await assert.rejects(
    runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'z-image-turbo', aspectRatio: '5:4' }, prefs: {}, sessionId: '2026-01-01T00-00-00', stdout: plainStdout }),
    (err) => err instanceof CliError && err.message === 'Error: --aspect-ratio 5:4 is not supported by z-image-turbo. Supported: 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5.'
  )
})

test('runImageGeneration computes pixels for an explicit preset ratio on a pixel-based model', async (t) => {
  mockConsole(t)
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'z-image-turbo', name: 'Z-Image Turbo', pricing: null, constraints: { aspectRatios: null, formats: ['png', 'jpeg', 'webp'], resolutions: null, qualities: null, widthHeightDivisor: 8 } }]
    },
  })

  const outcome = await runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'z-image-turbo', aspectRatio: '16:9' }, prefs: {}, sessionId: '2026-01-01T00-00-00', stdout: plainStdout })

  assert.equal(provider.genArgs.aspectRatio, undefined)
  assert.equal(provider.genArgs.width, 1280)
  assert.equal(provider.genArgs.height, 720)
  assert.deepEqual(outcome.prefsUpdates, { aspectRatio: '16:9' })
  assert.equal(outcome.sizing, '1280x720 · webp')
})

test('runImageGeneration applies a supported saved default without pickers when piped', async (t) => {
  mockConsole(t)
  const provider = fakeSizingProvider()
  const prefs = { imageDefaults: { venice: { aspectRatio: '1:1', format: 'webp' } } }

  const outcome = await runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'flux-1-1' }, prefs, sessionId: '2026-01-01T00-00-00', stdout: plainStdout })

  assert.equal(provider.genArgs.aspectRatio, '1:1')
  assert.equal(provider.genArgs.format, 'webp')
  assert.equal(outcome.prefsUpdates, undefined)
  assert.equal(outcome.sizing, '1:1 · webp')
})

test('runImageGeneration applies saved resolution, quality and variants defaults without pickers when piped', async (t) => {
  mockConsole(t)
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{
        id: 'flux-1-1',
        name: 'Flux 1.1',
        pricing: null,
        constraints: {
          aspectRatios: ['1:1', '16:9'],
          formats: ['png', 'jpeg', 'webp'],
          resolutions: ['1K', '2K', '4K'],
          qualities: ['low', 'medium', 'high'],
          widthHeightDivisor: null,
        },
      }]
    },
  })
  const prefs = { imageDefaults: { venice: { resolution: '2K', quality: 'high', variants: 3 } } }

  const outcome = await runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'flux-1-1' }, prefs, sessionId: '2026-01-01T00-00-00', stdout: plainStdout })

  assert.equal(provider.genArgs.resolution, '2K')
  assert.equal(provider.genArgs.quality, 'high')
  assert.equal(provider.genArgs.variants, 3)
  assert.equal(outcome.prefsUpdates, undefined)
})

test('runImageGeneration rejects an explicit variants count above the model maxN', async (t) => {
  mockConsole(t)
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'flux-1-1', name: 'Flux 1.1', pricing: null, constraints: { aspectRatios: ['1:1'], formats: ['png'], resolutions: null, qualities: null, widthHeightDivisor: null, maxN: 2 } }]
    },
  })

  await assert.rejects(
    runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'flux-1-1', variants: '3' }, prefs: {}, sessionId: '2026-01-01T00-00-00', stdout: plainStdout }),
    (err) => err instanceof CliError && err.message === 'Error: --variants 3 is not supported by flux-1-1. Supported: 1-2.'
  )
})

test('runImageGeneration drops a saved variants count above the model maxN with a note', async (t) => {
  const warns = []
  t.mock.method(console, 'warn', (m) => { warns.push(String(m)) })
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'flux-1-1', name: 'Flux 1.1', pricing: null, constraints: { aspectRatios: ['1:1'], formats: ['png'], resolutions: null, qualities: null, widthHeightDivisor: null, maxN: 2 } }]
    },
  })
  const prefs = { imageDefaults: { venice: { variants: 3 } } }

  const outcome = await runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'flux-1-1' }, prefs, sessionId: '2026-01-01T00-00-00', stdout: plainStdout })

  assert.equal(provider.genArgs.variants, 1)
  assert.ok(warns.some((w) => w.includes('saved variants 3 is not supported by flux-1-1; it was not sent.')), warns.join('\n'))
  assert.equal(outcome.prefsUpdates, undefined)
})

test('runImageGeneration drops saved resolution and quality defaults outside the model list with a note', async (t) => {
  const warns = []
  t.mock.method(console, 'warn', (m) => { warns.push(String(m)) })
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{
        id: 'flux-1-1',
        name: 'Flux 1.1',
        pricing: null,
        constraints: {
          aspectRatios: ['1:1', '16:9'],
          formats: ['png', 'jpeg', 'webp'],
          resolutions: ['1K', '2K'],
          qualities: null,
          widthHeightDivisor: null,
        },
      }]
    },
  })
  const prefs = { imageDefaults: { venice: { resolution: '4K', quality: 'high' } } }

  const outcome = await runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'flux-1-1' }, prefs, sessionId: '2026-01-01T00-00-00', stdout: plainStdout })

  assert.equal(provider.genArgs.resolution, undefined)
  assert.equal(provider.genArgs.quality, undefined)
  assert.equal(outcome.prefsUpdates, undefined)
  assert.ok(warns.some((w) => w.includes('saved resolution 4K is not supported by flux-1-1; it was not sent.')), warns.join('\n'))
  assert.ok(warns.some((w) => w.includes('saved quality high is not supported by flux-1-1; it was not sent.')), warns.join('\n'))
})

test('runImageGeneration does not apply a saved resolution default when an explicit flag is set', async (t) => {
  mockConsole(t)
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{
        id: 'flux-1-1',
        name: 'Flux 1.1',
        pricing: null,
        constraints: {
          aspectRatios: ['1:1', '16:9'],
          formats: ['png', 'jpeg', 'webp'],
          resolutions: ['1K', '2K'],
          qualities: ['low', 'high'],
          widthHeightDivisor: null,
        },
      }]
    },
  })
  const prefs = { imageDefaults: { venice: { resolution: '2K' } } }

  const outcome = await runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'flux-1-1', resolution: '1K' }, prefs, sessionId: '2026-01-01T00-00-00', stdout: plainStdout })

  assert.equal(provider.genArgs.resolution, '1K')
  assert.equal(outcome.prefsUpdates, undefined)
})

test('runImageGeneration sizing pickers preselect the saved default and persist non-default choices', async (t) => {
  mockConsole(t)
  selectCalls = []
  selectAnswers = ['16:9', 'png']
  const provider = fakeSizingProvider()
  const prefs = { imageDefaults: { venice: { aspectRatio: '1:1', format: 'webp' } } }

  const outcome = await runImageGeneration({
    provider,
    apiKey: 'k',
    prompt: 'x',
    opts: { imageModel: 'flux-1-1' },
    prefs,
    sessionId: '2026-01-01T00-00-00',
    sizingInteractive: true,
    stdout: plainStdout,
  })

  assert.equal(selectCalls.length, 2)
  assert.equal(selectCalls[0].message, 'Select an aspect ratio:')
  assert.equal(selectCalls[0].default, '1:1')
  assert.equal(selectCalls[1].message, 'Select an image format:')
  assert.equal(selectCalls[1].default, 'webp')
  assert.equal(provider.genArgs.aspectRatio, '16:9')
  assert.equal(provider.genArgs.format, 'png')
  assert.deepEqual(outcome.prefsUpdates, { aspectRatio: '16:9', format: 'png' })
  assert.equal(outcome.sizing, '16:9 · png')
})

test('sizing pickers are skipped when sizingInteractive is false', async (t) => {
  mockConsole(t)
  selectCalls = []
  selectAnswers = []
  const provider = fakeSizingProvider()
  const prefs = { imageDefaults: { venice: { aspectRatio: '1:1', format: 'webp' } } }

  const outcome = await runImageGeneration({
    provider,
    apiKey: 'k',
    prompt: 'x',
    opts: { imageModel: 'flux-1-1' },
    prefs,
    sessionId: '2026-01-01T00-00-00',
    sizingInteractive: false,
    stdout: plainStdout,
  })

  assert.equal(selectCalls.length, 0)
  assert.equal(provider.genArgs.aspectRatio, '1:1')
  assert.equal(provider.genArgs.format, 'webp')
  assert.equal(outcome.prefsUpdates, undefined)
})

test('--image --aspect-ratio/--image-format persist the provider defaults', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited } = await runImageGen(t, { overrides: { config: file, aspectRatio: '16:9', imageFormat: 'png' } })

  assert.equal(exited, false)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { aspectRatio: '16:9', format: 'png' } })
})

test('--image without sizing flags adds no imageDefaults key', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited } = await runImageGen(t, { overrides: { config: file } })

  assert.equal(exited, false)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.imageDefaults, undefined)
})

test('--image prints the sizing line', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)

  const { exited, stdoutChunks } = await runImageGen(t, { overrides: { aspectRatio: '16:9', imageFormat: 'png' } })

  assert.equal(exited, false)
  const logs = stdoutChunks.join('').split('\n').filter(Boolean)
  assert.ok(logs.includes('16:9 · png'), logs.join('\n'))
})

test('--image --aspect-ratio on a pixel model computes the pixels from the model divisor', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited, stdoutChunks } = await runImageGen(t, { overrides: { config: file, imageModel: 'z-image-turbo', aspectRatio: '2:3' } })

  assert.equal(exited, false)
  assert.equal(bodies[0].width, 848)
  assert.equal(bodies[0].height, 1272)
  assert.equal(bodies[0].aspect_ratio, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { aspectRatio: '2:3' } })
  const logs = stdoutChunks.join('').split('\n').filter(Boolean)
  assert.ok(logs.includes('848x1272 · webp'), logs.join('\n'))
})

test('--image --aspect-ratio on a pixel model rejects a ratio outside the hardcoded presets', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)

  const { exited, message } = await runImageGen(t, { overrides: { imageModel: 'z-image-turbo', aspectRatio: '5:4' } })

  assert.equal(exited, true)
  assert.equal(message, 'Error: --aspect-ratio 5:4 is not supported by z-image-turbo. Supported: 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5.')
})

test('runImageGeneration applies a saved aspect ratio default on a pixel model without pickers when piped', async (t) => {
  mockConsole(t)
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'z-image-turbo', name: 'Z-Image Turbo', pricing: null, constraints: { aspectRatios: null, formats: ['png', 'jpeg', 'webp'], resolutions: null, qualities: null, widthHeightDivisor: 8 } }]
    },
  })
  const prefs = { imageDefaults: { venice: { aspectRatio: '2:3' } } }

  const outcome = await runImageGeneration({ provider, apiKey: 'k', prompt: 'x', opts: { imageModel: 'z-image-turbo' }, prefs, sessionId: '2026-01-01T00-00-00', stdout: plainStdout })

  assert.equal(provider.genArgs.width, 848)
  assert.equal(provider.genArgs.height, 1272)
  assert.equal(provider.genArgs.aspectRatio, undefined)
  assert.equal(provider.genArgs.format, 'webp')
  assert.equal(outcome.prefsUpdates, undefined)
  assert.equal(outcome.sizing, '848x1272 · webp')
})

test('runImageGeneration aspect picker on a pixel model preselects the saved ratio and persists non-default choices', async (t) => {
  mockConsole(t)
  selectCalls = []
  selectAnswers = ['2:3', 'webp']
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'z-image-turbo', name: 'Z-Image Turbo', pricing: null, constraints: { aspectRatios: null, formats: ['png', 'jpeg', 'webp'], resolutions: null, qualities: null, widthHeightDivisor: 8 } }]
    },
  })
  const prefs = { imageDefaults: { venice: { aspectRatio: '16:9', format: 'webp' } } }

  const outcome = await runImageGeneration({
    provider,
    apiKey: 'k',
    prompt: 'x',
    opts: { imageModel: 'z-image-turbo' },
    prefs,
    sessionId: '2026-01-01T00-00-00',
    sizingInteractive: true,
    stdout: plainStdout,
  })

  const ratioCall = selectCalls[0]
  assert.equal(selectCalls.length, 2)
  assert.equal(ratioCall.message, 'Select an aspect ratio:')
  assert.equal(ratioCall.default, '16:9')
  assert.deepEqual(ratioCall.choices.map((c) => c.value), ['1:1', '3:2', '16:9', '21:9', '9:16', '2:3', '3:4', '4:5'])
  assert.deepEqual(ratioCall.choices.map((c) => c.name), [
    '1:1 · 1280x1280',
    '3:2 · 1272x848',
    '16:9 · 1280x720',
    '21:9 · 1264x544',
    '9:16 · 720x1280',
    '2:3 · 848x1272',
    '3:4 · 960x1280',
    '4:5 · 1024x1280',
  ])
  assert.equal(selectCalls[1].message, 'Select an image format:')
  assert.equal(provider.genArgs.width, 848)
  assert.equal(provider.genArgs.height, 1272)
  assert.equal(provider.genArgs.aspectRatio, undefined)
  assert.equal(provider.genArgs.format, 'webp')
  assert.deepEqual(outcome.prefsUpdates, { aspectRatio: '2:3' })
  assert.equal(outcome.sizing, '848x1272 · webp')
})

test('runImageGeneration aspect picker falls back to 1:1 when the saved ratio is not a preset', async (t) => {
  mockConsole(t)
  selectCalls = []
  selectAnswers = ['1:1', 'webp']
  const provider = fakeSizingProvider({
    async fetchImageModels() {
      return [{ id: 'z-image-turbo', name: 'Z-Image Turbo', pricing: null, constraints: { aspectRatios: null, formats: ['png', 'jpeg', 'webp'], resolutions: null, qualities: null, widthHeightDivisor: 8 } }]
    },
  })
  const prefs = { imageDefaults: { venice: { aspectRatio: '5:4' } } }

  await runImageGeneration({
    provider,
    apiKey: 'k',
    prompt: 'x',
    opts: { imageModel: 'z-image-turbo' },
    prefs,
    sessionId: '2026-01-01T00-00-00',
    sizingInteractive: true,
    stdout: plainStdout,
  })

  const ratioCall = selectCalls.find((c) => c.message === 'Select an aspect ratio:')
  assert.equal(ratioCall.default, '1:1')
})

test('--image --aspect-ratio on a pixel model persists the ratio default via the config file', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)
  const file = await tempConfig(t)

  const { exited } = await runImageGen(t, { overrides: { config: file, imageModel: 'z-image-turbo', aspectRatio: '16:9' } })

  assert.equal(exited, false)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { aspectRatio: '16:9' } })
})
