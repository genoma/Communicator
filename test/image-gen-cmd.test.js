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
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async (opts) => {
      searchCalls.push(opts)
      return { id: 'flux-1-1', name: 'Flux 1.1' }
    },
    select: async () => undefined,
  },
})

const { imageGenCmd } = await import('../src/commands/image-gen.js')

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
  outputDir: undefined,
  config: undefined,
}

const opts = (overrides = {}) => ({ ...BASE_OPTS, ...overrides })

async function runImageGen(t, { overrides = {}, prefs = {}, prompt = 'a red cat' } = {}) {
  try {
    await imageGenCmd({ apiKey: 'test-key', opts: opts(overrides), prefs, providerType: 'venice', prompt })
    return { exited: false }
  } catch (e) {
    if (e instanceof CliError) return { exited: true, message: e.message }
    throw e
  }
}

async function sessionsDir() {
  return join(tempHome, '.communicator', 'sessions')
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  return {
    logs: () => console.log.mock.calls.map((c) => String(c.arguments[0])),
    warns: () => console.warn.mock.calls.map((c) => String(c.arguments[0])),
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
  const consoleSpy = mockConsole(t)

  const dir = await sessionsDir()
  const before = new Set((await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json') && !f.startsWith('.')))

  const { exited } = await runImageGen(t, { overrides: { config: file }, prefs: {} })
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

  const logs = consoleSpy.logs()
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

test('--image with an unknown --image-model skips constraint validation and sends the id', async (t) => {
  const { bodies } = mockVeniceFetch(t)
  withApiKey(t)
  mockConsole(t)

  const { exited } = await runImageGen(t, { overrides: { imageModel: 'unknown-model', aspectRatio: '21:9' } })

  assert.equal(exited, false)
  assert.equal(bodies[0].model, 'unknown-model')
  assert.equal(bodies[0].aspect_ratio, '21:9')
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
  assert.ok(consoleSpy.warns().some((w) => w.includes('blurred')))
})

test('--image picker ordering uses lastImageModel on a second run', async (t) => {
  mockVeniceFetch(t)
  withApiKey(t)
  setStdoutTTY(t, true)
  mockConsole(t)
  searchCalls = []

  await runImageGen(t, { overrides: { imageModel: undefined }, prefs: { lastImageModel: 'flux-1-1' } })

  assert.equal(searchCalls.length, 1)
  const choices = await searchCalls[0].source('')
  assert.equal(choices[0].value.id, 'flux-1-1')
})

test('--image rejects an invalid flag value with a CliError', async (t) => {
  withApiKey(t)
  mockConsole(t)

  const { exited, message } = await runImageGen(t, { overrides: { variants: '9' } })

  assert.equal(exited, true)
  assert.equal(message, 'Error: --variants must be an integer between 1 and 4.')
})
