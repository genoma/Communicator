import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { ExitPromptError } from '@inquirer/core'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../src/errors.js'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-image-session-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const genCalls = []
const genPrefs = []
const genOpts = []
const genModels = []
const printed = []
const payloadArgs = []
mock.module(new URL('../src/commands/image-gen.js', import.meta.url).href, {
  namedExports: {
    runImageGeneration: async ({ prompt, model, prefs, opts, sizingInteractive }) => {
      genCalls.push(prompt)
      genPrefs.push(prefs?.hideWatermark)
      genModels.push(model?.id)
      genOpts.push({ aspectRatio: opts?.aspectRatio, imageFormat: opts?.imageFormat, resolution: opts?.resolution, quality: opts?.quality, variants: opts?.variants, seed: opts?.seed, sizingInteractive })
      if (prompt === 'boom') throw new CliError('Error: venice exploded.')
      return {
        message: { role: 'assistant', content: [{ type: 'image_url', image_url: { url: `ref://attachments/${genCalls.length}.webp` } }] },
        savedPaths: [`saved-${prompt}.webp`],
        blurred: false,
        costLine: null,
        modelId: model?.id || 'venice-sd35',
      }
    },
    printImageOutcome: async (outcome) => { printed.push(outcome) },
    buildImageSessionPayload: (args) => {
      payloadArgs.push(args)
      return {
        model: args.modelId,
        providerType: args.providerName || 'venice',
        createdAt: args.createdAt,
        messages: args.messages,
        endpointProviderName: args.endpointProviderName,
        pricing: args.pricing,
      }
    },
    handleWatermarkCommand: async ({ providerName, args, prefs, savePrefs, out = console.log, errOut = console.error }) => {
      if (providerName !== 'venice') {
        errOut('Error: /watermark is only supported on Venice sessions.\n')
        return
      }
      if (!args) {
        out(`Venice watermark is ${prefs.hideWatermark === true ? 'off' : 'on'}.\n`)
        return
      }
      if (args === 'on' || args === 'off') {
        const next = args === 'on'
        prefs.hideWatermark = !next
        await savePrefs({ hideWatermark: !next })
        out(`Venice watermark ${next ? 'enabled' : 'disabled'}.\n`)
        return
      }
      errOut('Error: /watermark expects "on" or "off".\n')
    },
  },
})

// /model in the image session opens the same combined picker as chat's
// /model; only selectModelAndEndpoint is stubbed. findImageModel and
// selectImageEndpoint keep their real behavior (provider-driven) so the
// existing provider-based tests pass.
let modelSelectionQueue = []
let modelSelectionError = null
mock.module(new URL('../src/model-selection.js', import.meta.url).href, {
  namedExports: {
    selectModelAndEndpoint: async () => {
      if (modelSelectionError) throw modelSelectionError
      const sel = modelSelectionQueue.shift()
      if (!sel) throw new Error('no selection mocked')
      return sel
    },
    findImageModel: async (provider, apiKey, modelId) => {
      if (typeof provider.fetchImageModels !== 'function') return null
      const models = await provider.fetchImageModels(apiKey)
      return models.find((m) => m.id === modelId) || null
    },
    selectImageEndpoint: async ({ provider, apiKey, model }) => {
      const endpoints = await provider.fetchImageModelEndpoints(apiKey, model.id)
      return endpoints[0] || null
    },
  },
})

const { startImageSession } = await import('../src/commands/image-session.js')

const fakeProvider = {
  meta: { name: 'venice' },
  async fetchImageModels() {
    return [{ id: 'venice-sd35', name: 'SD 3.5', pricing: { perImage: 0.02 }, constraints: { aspectRatios: ['1:1', '16:9', '3:2'], formats: ['png', 'jpeg', 'webp'], resolutions: ['1K', '2K', '4K'], qualities: ['low', 'medium', 'high'] } }]
  },
}

const veniceNoRatioProvider = {
  meta: { name: 'venice' },
  async fetchImageModels() {
    return [{ id: 'z-image-turbo', name: 'Z-Image Turbo', pricing: { perImage: 0.01 }, constraints: { aspectRatios: null, formats: ['png', 'jpeg', 'webp'], widthHeightDivisor: 8 } }]
  },
}

const openRouterNoListsProvider = {
  meta: { name: 'openrouter' },
  async fetchImageModels() {
    return [{ id: 'openai/gpt-5-image', name: 'GPT-5 Image', pricing: { perImage: 0.1 }, constraints: { aspectRatios: null, formats: null } }]
  },
}

const openRouterEndpointProvider = {
  ...openRouterNoListsProvider,
  async fetchImageModelEndpoints() {
    return [
      { providerName: 'OpenAI', slug: 'openai', pricing: { perImage: 0.1 } },
      { providerName: 'Azure', slug: 'azure', pricing: { perImage: 0.12 } },
    ]
  },
}

const twoImageModelsProvider = {
  meta: { name: 'venice' },
  async fetchImageModels() {
    return [
      { id: 'venice-sd35', name: 'SD 3.5', pricing: { perImage: 0.02 }, constraints: { aspectRatios: ['1:1', '16:9', '3:2'], formats: ['png', 'jpeg', 'webp'], resolutions: ['1K', '2K', '4K'], qualities: ['low', 'medium', 'high'] } },
      { id: 'z-image-turbo', name: 'Z-Image Turbo', pricing: { perImage: 0.01 }, constraints: { aspectRatios: null, formats: ['png', 'jpeg', 'webp'], widthHeightDivisor: 8 } },
    ]
  },
}

const openRouterTwoImageModelsProvider = {
  meta: { name: 'openrouter' },
  async fetchImageModels() {
    return [
      { id: 'openai/gpt-5-image', name: 'GPT-5 Image', pricing: null, constraints: { aspectRatios: null, formats: null } },
      { id: 'openai/gpt-image-1-mini', name: 'GPT Image 1 Mini', pricing: null, constraints: { aspectRatios: null, formats: null } },
    ]
  },
}

// A Venice model whose resolution/quality lists do not cover the full
// resolver range, so a valid global value can still be unsupported.
const limitedSizingProvider = {
  meta: { name: 'venice' },
  async fetchImageModels() {
    return [{ id: 'venice-sd35', name: 'SD 3.5', pricing: { perImage: 0.02 }, constraints: { aspectRatios: ['1:1', '16:9', '3:2'], formats: ['png', 'jpeg', 'webp'], resolutions: ['1K', '2K'], qualities: ['low', 'medium'] } }]
  },
}

function textSelection(overrides = {}) {
  return {
    modelId: 'openrouter/auto',
    isImageModel: false,
    endpointProviderName: 'OpenAI',
    reasoningEffort: null,
    supportsReasoning: true,
    modelReasoning: null,
    contextLength: 128000,
    webSearchSupported: true,
    visionSupported: false,
    fileSupported: true,
    imageOutputSupported: undefined,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    ...overrides,
  }
}

function scriptedInput(values) {
  const queue = [...values]
  return async () => {
    if (queue.length === 0) return { cancelled: true }
    return { value: queue.shift() }
  }
}

function sessionFile(sessionId) {
  return join(tempHome, '.communicator', 'sessions', `${sessionId}.json`)
}

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-image-session-config-'))
  const file = join(dir, 'config.json')
  await writeFile(file, '{}')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return file
}

function baseOpts(overrides = {}) {
  return {
    provider: fakeProvider,
    apiKey: 'k',
    prefs: {},
    imageModelId: 'venice-sd35',
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    stdout: { write: () => {} },
    ...overrides,
  }
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
}

test('two prompts generate two images, persist the session and save prefs', async (t) => {
  genCalls.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({ configPath: file, readInput: scriptedInput(['a red cat', 'a blue dog', '/quit']) }))

  assert.deepEqual(genCalls, ['a red cat', 'a blue dog'])
  assert.equal(printed.length, 2)

  const saved = JSON.parse(await readFile(sessionFile('2026-01-01T00-00-00'), 'utf-8'))
  assert.equal(saved.model, 'venice-sd35')
  assert.equal(saved.providerType, 'venice')
  assert.equal(saved.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(saved.messages.length, 5)
  assert.equal(saved.messages[0].role, 'system')
  assert.equal(saved.messages[1].role, 'user')
  assert.equal(saved.messages[1].content, 'a red cat')
  assert.equal(saved.messages[2].content[0].image_url.url, 'ref://attachments/1.webp')
  assert.equal(saved.messages[3].role, 'user')
  assert.equal(saved.messages[3].content, 'a blue dog')
  assert.equal(saved.messages[4].content[0].image_url.url, 'ref://attachments/2.webp')

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastImageModel, 'venice-sd35')
})

test('persists the endpoint provider and pricing for resumed OpenRouter sessions', async (t) => {
  payloadArgs.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    provider: openRouterEndpointProvider,
    imageModelId: 'openai/gpt-5-image',
    imageProviderName: 'OpenAI',
    pricing: { perImage: 0.09 },
    configPath: file,
    readInput: scriptedInput(['draw a cat', '/quit']),
  }))

  const saved = JSON.parse(await readFile(sessionFile('2026-01-01T00-00-00'), 'utf-8'))
  assert.equal(saved.endpointProviderName, 'OpenAI')
  assert.deepEqual(saved.pricing, { perImage: 0.09 })
  assert.equal(payloadArgs[0].endpointProviderName, 'OpenAI')
  assert.deepEqual(payloadArgs[0].pricing, { perImage: 0.09 })
})

test('resume continues from initialMessages without re-adding a system message', async (t) => {
  genCalls.length = 0
  printed.length = 0
  mockConsole(t)

  await startImageSession(baseOpts({
    initialMessages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'old prompt' },
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'ref://attachments/old.webp' } }] },
    ],
    readInput: scriptedInput(['new prompt', '/quit']),
  }))

  assert.deepEqual(genCalls, ['new prompt'])
  const saved = JSON.parse(await readFile(sessionFile('2026-01-01T00-00-00'), 'utf-8'))
  assert.equal(saved.messages.length, 5)
  assert.equal(saved.messages[0].content, 'You are a helpful assistant.')
  assert.equal(saved.messages[3].content, 'new prompt')
})

test('resume without generating keeps the stored updatedAt, a generation bumps it', async (t) => {
  genCalls.length = 0
  printed.length = 0
  payloadArgs.length = 0
  mockConsole(t)

  await startImageSession(baseOpts({
    updatedAt: '2026-01-01T00:00:01.000Z',
    readInput: scriptedInput(['/quit']),
  }))
  assert.equal(payloadArgs.at(-1).updatedAt, '2026-01-01T00:00:01.000Z')

  genCalls.length = 0
  printed.length = 0
  payloadArgs.length = 0
  await startImageSession(baseOpts({
    updatedAt: '2026-01-01T00:00:01.000Z',
    readInput: scriptedInput(['a red cat', '/quit']),
  }))
  assert.ok(Date.parse(payloadArgs.at(-1).updatedAt) > Date.parse('2026-01-01T00:00:01.000Z'))
})

test('/quit leaves the session without generating', async (t) => {
  genCalls.length = 0
  printed.length = 0
  mockConsole(t)

  await startImageSession(baseOpts({ readInput: scriptedInput(['/quit']) }))

  assert.deepEqual(genCalls, [])
  assert.deepEqual(printed, [])
})

test('/quit without generating persists the last image model', async (t) => {
  genCalls.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({ configPath: file, readInput: scriptedInput(['/quit']) }))

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastImageModel, 'venice-sd35')
})

test('EOF without generating persists the last image model', async (t) => {
  genCalls.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({ configPath: file, readInput: scriptedInput([]) }))

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastImageModel, 'venice-sd35')
})

test('EOF leaves the session without generating', async (t) => {
  genCalls.length = 0
  printed.length = 0
  mockConsole(t)

  await startImageSession(baseOpts({ readInput: scriptedInput([]) }))

  assert.deepEqual(genCalls, [])
  assert.deepEqual(printed, [])
})

test('empty prompts are skipped', async (t) => {
  genCalls.length = 0
  printed.length = 0
  mockConsole(t)

  await startImageSession(baseOpts({ readInput: scriptedInput(['', '   ', 'a cat', '/quit']) }))

  assert.deepEqual(genCalls, ['a cat'])
  assert.equal(printed.length, 1)
})

test('/help lists the commands and does not generate', async (t) => {
  genCalls.length = 0
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/help', '/quit']) }))

  assert.deepEqual(genCalls, [])
  assert.ok(logs.some((l) => l.includes('/help')))
  assert.ok(logs.some((l) => l.includes('/quit')))
  assert.ok(logs.some((l) => l.includes('/watermark')))
  assert.ok(logs.some((l) => l.includes('/resolution')))
  assert.ok(logs.some((l) => l.includes('/quality')))
  assert.ok(logs.some((l) => l.includes('/variants')))
  assert.ok(logs.some((l) => l.includes('/seed')))
})

test('unknown slash commands are reported without generating', async (t) => {
  genCalls.length = 0
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/nope', '/quit']) }))

  assert.deepEqual(genCalls, [])
  assert.ok(logs.some((l) => l.includes('Unknown command')))
})

test('a failed generation is reported and the loop continues', async (t) => {
  genCalls.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ readInput: scriptedInput(['boom', 'a cat', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('venice exploded.')))
  assert.deepEqual(genCalls, ['boom', 'a cat'])
  assert.equal(printed.length, 1)
})

test('a missing image model throws a CliError before reading input', async (t) => {
  genCalls.length = 0
  mockConsole(t)

  await assert.rejects(
    startImageSession(baseOpts({ imageModelId: 'gone', readInput: scriptedInput(['x']) })),
    (err) => err instanceof CliError && err.message.includes('gone')
  )
  assert.deepEqual(genCalls, [])
})

test('/watermark off hides the watermark for subsequent generations and persists', async (t) => {
  genCalls.length = 0
  genPrefs.length = 0
  printed.length = 0
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    readInput: scriptedInput(['/watermark off', 'a cat', '/watermark', '/quit']),
  }))

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.hideWatermark, true)
  assert.deepEqual(genPrefs, [true])
  assert.ok(logs.some((l) => l.includes('watermark disabled')))
  assert.ok(logs.some((l) => l.includes('watermark is off')))
})

test('/watermark on re-enables the watermark and persists', async (t) => {
  genCalls.length = 0
  genPrefs.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    prefs: { hideWatermark: true },
    readInput: scriptedInput(['/watermark on', '/watermark', '/quit']),
  }))

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.hideWatermark, false)
  assert.deepEqual(genPrefs, [])
})

test('/watermark with an invalid argument errors and continues', async (t) => {
  genCalls.length = 0
  genPrefs.length = 0
  printed.length = 0
  const logs = []
  const errors = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    readInput: scriptedInput(['/watermark sometimes', 'a cat', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('/watermark expects "on" or "off"')))
  assert.deepEqual(genCalls, ['a cat'])
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.hideWatermark, undefined)
})

test('/watermark on an openrouter session is an unknown command and continues', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    provider: { meta: { name: 'openrouter' }, fetchImageModels: fakeProvider.fetchImageModels },
    configPath: file,
    readInput: scriptedInput(['/watermark off', 'a cat', '/quit']),
  }))

  assert.ok(logs.some((l) => l.startsWith('Unknown command "/watermark off"')))
  assert.ok(!logs.some((l) => l.includes('/watermark is only supported on Venice sessions.')))
  assert.deepEqual(genCalls, ['a cat'])
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.hideWatermark, undefined)
})

test('/watermark is not offered or listed on an openrouter image session', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  const logs = []
  const commandsSeen = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})
  const inner = scriptedInput(['/help', '/watermark', '/quit'])
  const capturing = async (opts) => {
    commandsSeen.push(opts?.commands)
    return inner()
  }
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    provider: { meta: { name: 'openrouter' }, fetchImageModels: fakeProvider.fetchImageModels },
    configPath: file,
    readInput: capturing,
  }))

  assert.deepEqual(genCalls, [])
  for (const commands of commandsSeen) {
    assert.ok(!commands.includes('/watermark'))
  }
  assert.ok(!logs.some((l) => l.includes('Venice watermark')))
  assert.ok(logs.some((l) => l.startsWith('Unknown command "/watermark"')))
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.hideWatermark, undefined)
})

test('/aspect sets the session ratio, persists the provider default and passes it as opts', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    readInput: scriptedInput(['/aspect 16:9', 'a cat', '/quit']),
  }))

  assert.deepEqual(genCalls, ['a cat'])
  assert.equal(genOpts[0].aspectRatio, '16:9')
  assert.equal(genOpts[0].imageFormat, undefined)
  assert.equal(genOpts[0].sizingInteractive, false)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { aspectRatio: '16:9' } })
})

test('/aspect bare shows the supported ratios with the current one marked', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { aspectRatio: '16:9' } } },
    readInput: scriptedInput(['/aspect', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Aspect ratios: 1:1 [16:9] 3:2.')))
})

test('/aspect bare reports the supported ratios when none is set', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/aspect', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('Aspect ratios: 1:1 16:9 3:2 (none set).')))
})

test('/aspect bare notes a stored value outside the supported list', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { aspectRatio: '21:9' } } },
    readInput: scriptedInput(['/aspect', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Aspect ratios: 1:1 16:9 3:2 (21:9 not supported by venice-sd35).')))
})

test('image session strips terminal escape sequences from remote model ids and constraint lists', async (t) => {
  const logs = []
  const errs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', (line) => { errs.push(String(line)) })
  const evilProvider = {
    meta: { name: 'venice' },
    async fetchImageModels() {
      return [{
        id: 'venice-\x1b[2Jsanitize',
        name: 'SD 3.5',
        pricing: { perImage: 0.02 },
        constraints: {
          aspectRatios: ['1:1', '\x1b[31m16:9\x1b[0m'],
          formats: ['png'],
          resolutions: ['\x1b[2J1K', '2K'],
          qualities: ['low'],
          maxN: '2',
        },
      }]
    },
  }

  await startImageSession(baseOpts({
    provider: evilProvider,
    imageModelId: 'venice-\x1b[2Jsanitize',
    readInput: scriptedInput(['/aspect', '/resolution', '/variants', '/resolution 4K', '/variants 3', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Aspect ratios: 1:1 16:9 (none set).')))
  assert.ok(logs.some((l) => l.includes('Resolutions: 1K 2K (none set).')))
  assert.ok(logs.some((l) => l.includes('Variants: 1-2 (none set).')))
  assert.ok(errs.some((l) => l.includes('resolution 4K is not supported by venice-sanitize. Supported: 1K, 2K.')))
  assert.ok(errs.some((l) => l.includes('variants 3 is not supported by venice-sanitize. Supported: 1-2.')))
  for (const line of [...logs, ...errs]) {
    assert.ok(!line.includes('\x1b'), `unexpected escape sequence in: ${line}`)
  }
})

test('/aspect clear unsets the ratio and removes the persisted key', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    prefs: { imageDefaults: { venice: { aspectRatio: '16:9', format: 'webp' } } },
    readInput: scriptedInput(['/aspect clear', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].aspectRatio, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { format: 'webp' } })
})

test('/aspect with an unsupported ratio errors listing the supported values', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ readInput: scriptedInput(['/aspect 21:9', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('Error: aspect ratio 21:9 is not supported by venice-sd35. Supported: 1:1, 16:9, 3:2.')))
  assert.deepEqual(genCalls, [])
})

test('/aspect with an invalid shape errors', async (t) => {
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ readInput: scriptedInput(['/aspect wide', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('--aspect-ratio must be in the form W:H')))
})

test('/aspect with a ratio on a pixel-based Venice model sets it, persists the default and passes it as opts', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    configPath: file,
    readInput: scriptedInput(['/aspect 2:3', 'a cat', '/quit']),
  }))

  assert.deepEqual(genCalls, ['a cat'])
  assert.equal(genOpts[0].aspectRatio, '2:3')
  assert.ok(logs.some((l) => l.includes('Aspect ratio set to 2:3 (848x1272).')))
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { aspectRatio: '2:3' } })
})

test('/aspect bare on a pixel-based Venice model shows the hardcoded presets with the current one marked', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    prefs: { imageDefaults: { venice: { aspectRatio: '2:3' } } },
    readInput: scriptedInput(['/aspect', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Aspect ratios: 1:1 1280x1280 · 3:2 1272x848 · 16:9 1280x720 · 21:9 1264x544 · 9:16 720x1280 · [2:3 848x1272] · 3:4 960x1280 · 4:5 1024x1280.')))
})

test('/aspect bare on a pixel-based Venice model reports the presets when none is set', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    readInput: scriptedInput(['/aspect', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Aspect ratios: 1:1 1280x1280 · 3:2 1272x848 · 16:9 1280x720 · 21:9 1264x544 · 9:16 720x1280 · 2:3 848x1272 · 3:4 960x1280 · 4:5 1024x1280 (none set).')))
})

test('/aspect bare on a pixel-based Venice model marks the session value over the saved default', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    prefs: { imageDefaults: { venice: { aspectRatio: '1:1' } } },
    readInput: scriptedInput(['/aspect 16:9', '/aspect', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('[16:9 1280x720]')))
})

test('/aspect bare on a pixel-based Venice model notes a stored ratio outside the presets', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    prefs: { imageDefaults: { venice: { aspectRatio: '5:4' } } },
    readInput: scriptedInput(['/aspect', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('(current: 5:4)')))
})

test('/aspect with a ratio outside the hardcoded presets errors on a pixel-based Venice model', async (t) => {
  genCalls.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    readInput: scriptedInput(['/aspect 5:4', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: aspect ratio 5:4 is not supported by z-image-turbo. Supported: 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5.')))
  assert.deepEqual(genCalls, [])
})

test('/aspect auto errors on a pixel-based Venice model', async (t) => {
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    readInput: scriptedInput(['/aspect auto', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: aspect ratio auto is not supported by z-image-turbo.')))
})

test('/aspect clear on a pixel-based Venice model unsets the ratio and removes the persisted key', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    configPath: file,
    prefs: { imageDefaults: { venice: { aspectRatio: '2:3', format: 'webp' } } },
    readInput: scriptedInput(['/aspect clear', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].aspectRatio, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { format: 'webp' } })
})

test('/aspect with a ratio on an OpenRouter model without a list still errors', async (t) => {
  genCalls.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: openRouterNoListsProvider,
    imageModelId: 'openai/gpt-5-image',
    readInput: scriptedInput(['/aspect 16:9', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: aspect ratio is not supported by openai/gpt-5-image.')))
  assert.deepEqual(genCalls, [])
})

test('/aspect bare on an OpenRouter model without a list reports it is unsupported', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: openRouterNoListsProvider,
    imageModelId: 'openai/gpt-5-image',
    readInput: scriptedInput(['/aspect', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Aspect ratio is not supported by openai/gpt-5-image.')))
})

test('/format bare on an OpenRouter model without formats reports it is unsupported', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: openRouterNoListsProvider,
    imageModelId: 'openai/gpt-5-image',
    readInput: scriptedInput(['/format', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Format is not supported by openai/gpt-5-image.')))
})

test('/format sets the session format, persists the provider default and passes it as opts', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    readInput: scriptedInput(['/format png', 'a cat', '/quit']),
  }))

  assert.deepEqual(genCalls, ['a cat'])
  assert.equal(genOpts[0].imageFormat, 'png')
  assert.equal(genOpts[0].aspectRatio, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { format: 'png' } })
})

test('/format bare shows the supported formats with the current one marked', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { format: 'png' } } },
    readInput: scriptedInput(['/format', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Formats: [png] jpeg webp.')))
})

test('/format clear unsets the format and removes the persisted key', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    prefs: { imageDefaults: { venice: { aspectRatio: '16:9', format: 'png' } } },
    readInput: scriptedInput(['/format clear', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].imageFormat, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { aspectRatio: '16:9' } })
})

test('/format with an invalid value errors', async (t) => {
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ readInput: scriptedInput(['/format gif', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('--image-format must be one of: png, jpeg, webp.')))
})

test('/resolution sets the session resolution, persists the provider default and passes it as opts', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    readInput: scriptedInput(['/resolution 2K', 'a cat', '/quit']),
  }))

  assert.deepEqual(genCalls, ['a cat'])
  assert.equal(genOpts[0].resolution, '2K')
  assert.equal(genOpts[0].imageFormat, undefined)
  assert.equal(genOpts[0].aspectRatio, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { resolution: '2K' } })
})

test('/resolution bare shows the supported resolutions with the current one marked', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { resolution: '2K' } } },
    readInput: scriptedInput(['/resolution', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Resolutions: 1K [2K] 4K.')))
})

test('/resolution bare reports the supported resolutions when none is set', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/resolution', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('Resolutions: 1K 2K 4K (none set).')))
})

test('/resolution bare marks the session value over the saved default', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { resolution: '1K' } } },
    readInput: scriptedInput(['/resolution 2K', '/resolution', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Resolutions: 1K [2K] 4K.')))
})

test('/resolution bare notes a stored value outside the supported list', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { resolution: '8K' } } },
    readInput: scriptedInput(['/resolution', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Resolutions: 1K 2K 4K (8K not supported by venice-sd35).')))
})

test('/resolution with a value outside the model list errors listing the supported values', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: limitedSizingProvider,
    readInput: scriptedInput(['/resolution 4K', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: resolution 4K is not supported by venice-sd35. Supported: 1K, 2K.')))
  assert.deepEqual(genCalls, [])
})

test('/resolution with an invalid value errors', async (t) => {
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ readInput: scriptedInput(['/resolution 8K', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('--resolution must be one of: 1K, 2K, 4K.')))
})

test('/resolution clear unsets the resolution and removes the persisted key', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    prefs: { imageDefaults: { venice: { resolution: '2K', format: 'png' } } },
    readInput: scriptedInput(['/resolution clear', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].resolution, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { format: 'png' } })
})

test('/resolution bare on an OpenRouter model without a list reports it is unsupported', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: openRouterNoListsProvider,
    imageModelId: 'openai/gpt-5-image',
    readInput: scriptedInput(['/resolution', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Resolution is not supported by openai/gpt-5-image.')))
})

test('/resolution with a value on an OpenRouter model without a list errors', async (t) => {
  genCalls.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: openRouterNoListsProvider,
    imageModelId: 'openai/gpt-5-image',
    readInput: scriptedInput(['/resolution 2K', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: resolution is not supported by openai/gpt-5-image.')))
  assert.deepEqual(genCalls, [])
})

test('/quality sets the session quality, persists the provider default and passes it as opts', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    readInput: scriptedInput(['/quality high', 'a cat', '/quit']),
  }))

  assert.deepEqual(genCalls, ['a cat'])
  assert.equal(genOpts[0].quality, 'high')
  assert.equal(genOpts[0].imageFormat, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { quality: 'high' } })
})

test('/quality bare shows the supported qualities with the current one marked', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { quality: 'medium' } } },
    readInput: scriptedInput(['/quality', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Qualities: low [medium] high.')))
})

test('/quality with a value outside the model list errors listing the supported values', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: limitedSizingProvider,
    readInput: scriptedInput(['/quality high', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: quality high is not supported by venice-sd35. Supported: low, medium.')))
  assert.deepEqual(genCalls, [])
})

test('/quality with an invalid value errors', async (t) => {
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ readInput: scriptedInput(['/quality 8k', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('--quality must be one of: low, medium, high.')))
})

test('/quality clear unsets the quality and removes the persisted key', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    prefs: { imageDefaults: { venice: { quality: 'high', aspectRatio: '16:9' } } },
    readInput: scriptedInput(['/quality clear', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].quality, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { aspectRatio: '16:9' } })
})

test('/quality with a value on an OpenRouter model without a list errors', async (t) => {
  genCalls.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: openRouterNoListsProvider,
    imageModelId: 'openai/gpt-5-image',
    readInput: scriptedInput(['/quality high', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: quality is not supported by openai/gpt-5-image.')))
  assert.deepEqual(genCalls, [])
})

test('/variants sets the session variants, persists the provider default and passes them as opts', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    readInput: scriptedInput(['/variants 2', 'a cat', '/quit']),
  }))

  assert.deepEqual(genCalls, ['a cat'])
  assert.equal(genOpts[0].variants, 2)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { variants: 2 } })
})

test('/variants bare shows the range with the current one marked', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { variants: 2 } } },
    readInput: scriptedInput(['/variants', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Variants: 1-4 (current: 2).')))
})

test('/variants bare reports the range when none is set', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/variants', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('Variants: 1-4 (none set).')))
})

test('/variants with a value outside the range errors', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ readInput: scriptedInput(['/variants 5', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('Error: --variants must be an integer between 1 and 4.')))
  assert.deepEqual(genCalls, [])
})

const maxNProvider = {
  meta: { name: 'venice' },
  async fetchImageModels() {
    return [{ id: 'venice-sd35', name: 'SD 3.5', pricing: { perImage: 0.02 }, constraints: { aspectRatios: ['1:1', '16:9', '3:2'], formats: ['png', 'jpeg', 'webp'], resolutions: ['1K', '2K', '4K'], qualities: ['low', 'medium', 'high'], maxN: 2 } }]
  },
}

test('/variants above the model maxN errors', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ provider: maxNProvider, readInput: scriptedInput(['/variants 3', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('Error: variants 3 is not supported by venice-sd35. Supported: 1-2.')))
  assert.deepEqual(genCalls, [])
})

test('/variants bare shows the model maxN when the model advertises one', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ provider: maxNProvider, readInput: scriptedInput(['/variants', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('Variants: 1-2 (none set).')))
})

test('/variants clear unsets the variants and removes the persisted key', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    prefs: { imageDefaults: { venice: { resolution: '2K', variants: 2 } } },
    readInput: scriptedInput(['/variants clear', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].variants, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { resolution: '2K' } })
})

test('/seed sets the session seed without persisting a default', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    configPath: file,
    readInput: scriptedInput(['/seed 123', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].seed, 123)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.imageDefaults, undefined)
})

test('/seed bare shows the current seed', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/seed 123', '/seed', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('Seed: 123.')))
})

test('/seed bare reports not set when no seed is active', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/seed', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('Seed: not set.')))
})

test('/seed clear unsets the session seed', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)

  await startImageSession(baseOpts({ readInput: scriptedInput(['/seed 123', '/seed clear', 'a cat', '/quit']) }))

  assert.equal(genOpts[0].seed, undefined)
})

test('/seed with a value outside the range errors', async (t) => {
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ readInput: scriptedInput(['/seed 1000000000', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('Error: --seed must be an integer between -999999999 and 999999999.')))
})

test('/model swap clears session sizing values when the model changes', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  genModels.length = 0
  printed.length = 0
  mockConsole(t)
  modelSelectionQueue = [
    { modelId: 'z-image-turbo', name: 'Z-Image Turbo', isImageModel: true, endpointProviderName: 'venice', imageProvider: null, pricing: { perImage: 0.01 } },
  ]

  await startImageSession(baseOpts({
    provider: twoImageModelsProvider,
    readInput: scriptedInput(['/resolution 2K', '/model', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].resolution, undefined)
  assert.deepEqual(genModels, ['z-image-turbo'])
})

test('/aspect and /format are listed in /help and /size is not', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/help', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('/aspect')))
  assert.ok(logs.some((l) => l.includes('/format')))
  assert.ok(!logs.some((l) => l.includes('/size')))
})

test('/help lists /model', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/help', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('/model')))
  assert.ok(logs.some((l) => l.includes('/status')))
})

test('the connect banner lists the saved provider defaults', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { aspectRatio: '16:9', format: 'webp', resolution: '2K', quality: 'high', variants: 2 } } },
    readInput: scriptedInput(['/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('\nConnected to venice-sd35  [image]  [aspect: 16:9]  [resolution: 2K]  [quality: high]  [format: webp]  [variants: 2]\n')))
})

test('/status prints the saved provider defaults', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { aspectRatio: '16:9', format: 'webp', resolution: '2K', quality: 'high', variants: 2 } } },
    readInput: scriptedInput(['/status', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Current settings: venice-sd35  [image]  [aspect: 16:9]  [resolution: 2K]  [quality: high]  [format: webp]  [variants: 2]')))
})

test('/status shows the session value winning over the saved default', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { imageDefaults: { venice: { format: 'webp' } } },
    readInput: scriptedInput(['/format png', '/status', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Current settings: venice-sd35  [image]  [format: png]')))
})

test('/status badges the seed and watermark state', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    prefs: { hideWatermark: true },
    readInput: scriptedInput(['/seed 7', '/status', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Current settings: venice-sd35  [image]  [watermark: off]  [seed: 7]')))
})

test('/status on a model without sizing lists shows no sizing badges', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: openRouterNoListsProvider,
    imageModelId: 'openai/gpt-5-image',
    readInput: scriptedInput(['/status', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Current settings: openai/gpt-5-image  [image]')))
})

test('/model with an image-model pick switches the session model and persists it', async (t) => {
  genCalls.length = 0
  genModels.length = 0
  printed.length = 0
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})
  const file = await tempConfig(t)
  modelSelectionQueue = [
    { modelId: 'z-image-turbo', name: 'Z-Image Turbo', isImageModel: true, endpointProviderName: 'venice', imageProvider: null, pricing: { perImage: 0.01 } },
  ]

  await startImageSession(baseOpts({
    provider: twoImageModelsProvider,
    configPath: file,
    readInput: scriptedInput(['/model', 'a cat', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Switched to venice / z-image-turbo [image]')))
  assert.deepEqual(genModels, ['z-image-turbo'])
  const saved = JSON.parse(await readFile(sessionFile('2026-01-01T00-00-00'), 'utf-8'))
  assert.equal(saved.model, 'z-image-turbo')
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastImageModel, 'z-image-turbo')
})

test('/model with an image-model pick does not clobber existing prefs', async (t) => {
  genCalls.length = 0
  genModels.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)
  await writeFile(file, JSON.stringify({ lastModel: 'gpt-5', hideWatermark: true, imageDefaults: { venice: { format: 'png' } } }))
  modelSelectionQueue = [
    { modelId: 'z-image-turbo', name: 'Z-Image Turbo', isImageModel: true, endpointProviderName: 'venice', imageProvider: null, pricing: { perImage: 0.01 } },
  ]

  await startImageSession(baseOpts({
    provider: twoImageModelsProvider,
    prefs: { lastModel: 'gpt-5', hideWatermark: true, imageDefaults: { venice: { format: 'png' } } },
    configPath: file,
    readInput: scriptedInput(['/model', 'a cat', '/quit']),
  }))

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastImageModel, 'z-image-turbo')
  assert.equal(prefs.lastModel, 'gpt-5')
  assert.equal(prefs.hideWatermark, true)
  assert.deepEqual(prefs.imageDefaults, { venice: { format: 'png' } })
})

test('/model with an image-model pick on OpenRouter persists the endpoint provider and pricing', async (t) => {
  genCalls.length = 0
  genModels.length = 0
  printed.length = 0
  payloadArgs.length = 0
  mockConsole(t)
  const file = await tempConfig(t)
  modelSelectionQueue = [{
    modelId: 'openai/gpt-5-image',
    name: 'GPT-5 Image',
    isImageModel: true,
    endpointProviderName: 'Google Vertex',
    imageProvider: 'google-vertex/global',
    pricing: { perImage: 0.05 },
  }]

  await startImageSession(baseOpts({
    provider: openRouterTwoImageModelsProvider,
    imageModelId: 'openai/gpt-5-image',
    configPath: file,
    readInput: scriptedInput(['/model', 'a cat', '/quit']),
  }))

  assert.deepEqual(genModels, ['openai/gpt-5-image'])
  const saved = JSON.parse(await readFile(sessionFile('2026-01-01T00-00-00'), 'utf-8'))
  assert.equal(saved.model, 'openai/gpt-5-image')
  assert.equal(saved.endpointProviderName, 'Google Vertex')
  assert.deepEqual(saved.pricing, { perImage: 0.05 })
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastImageModel, 'openai/gpt-5-image')
})

test('/model with a vanished image model errors and the session continues', async (t) => {
  genCalls.length = 0
  genModels.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  modelSelectionQueue = [
    { modelId: 'gone-model', name: 'Gone', isImageModel: true, endpointProviderName: 'venice', imageProvider: null, pricing: null },
  ]

  await startImageSession(baseOpts({
    provider: twoImageModelsProvider,
    readInput: scriptedInput(['/model', 'a cat', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('image model gone-model is no longer available')))
  assert.deepEqual(genCalls, ['a cat'])
  assert.deepEqual(genModels, ['venice-sd35'])
})

test('/model with a text-model pick returns a chat handoff and replaces image parts for non-vision models', async (t) => {
  mockConsole(t)
  const file = await tempConfig(t)
  modelSelectionQueue = [textSelection()]

  const result = await startImageSession(baseOpts({
    initialMessages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'draw a cat' },
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'ref://attachments/old.webp' } }, { type: 'text', text: 'here it is' }] },
    ],
    configPath: file,
    readInput: scriptedInput(['/model']),
  }))

  assert.ok(result.switchToChat)
  assert.equal(result.switchToChat.selection.modelId, 'openrouter/auto')
  assert.equal(result.switchToChat.sessionId, '2026-01-01T00-00-00')
  assert.equal(result.switchToChat.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(result.switchToChat.messages.length, 3)
  assert.deepEqual(result.switchToChat.messages[2].content, [
    { type: 'text', text: '[generated image]' },
    { type: 'text', text: 'here it is' },
  ])
})

test('/model with a vision-capable text model keeps the image parts in the handoff', async (t) => {
  mockConsole(t)
  modelSelectionQueue = [textSelection({ visionSupported: true })]

  const result = await startImageSession(baseOpts({
    initialMessages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'draw a cat' },
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'ref://attachments/old.webp' } }] },
    ],
    readInput: scriptedInput(['/model']),
  }))

  assert.equal(result.switchToChat.messages[2].content[0].type, 'image_url')
})

test('/model picker errors are reported and the session continues', async (t) => {
  genCalls.length = 0
  genModels.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  modelSelectionError = new CliError('Error: picker exploded.')

  await startImageSession(baseOpts({ readInput: scriptedInput(['/model', 'a cat', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('picker exploded.')))
  assert.deepEqual(genCalls, ['a cat'])
  assert.deepEqual(genModels, ['venice-sd35'])
  modelSelectionError = null
})

test('/model picker cancellation is reported as Aborted and the session continues', async (t) => {
  genCalls.length = 0
  genModels.length = 0
  printed.length = 0
  const logs = []
  const errors = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  modelSelectionError = new ExitPromptError()

  await startImageSession(baseOpts({ readInput: scriptedInput(['/model', 'a cat', '/quit']) }))

  assert.ok(logs.some((l) => l === 'Aborted.'))
  assert.equal(errors.length, 0)
  assert.deepEqual(genCalls, ['a cat'])
  assert.deepEqual(genModels, ['venice-sd35'])
  modelSelectionError = null
})

