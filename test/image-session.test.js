import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../src/errors.js'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-image-session-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const genCalls = []
const genPrefs = []
const genOpts = []
const printed = []
mock.module(new URL('../src/commands/image-gen.js', import.meta.url).href, {
  namedExports: {
    runImageGeneration: async ({ prompt, model, prefs, opts, sizingInteractive }) => {
      genCalls.push(prompt)
      genPrefs.push(prefs?.hideWatermark)
      genOpts.push({ aspectRatio: opts?.aspectRatio, imageFormat: opts?.imageFormat, size: opts?.size, sizingInteractive })
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
    pixelSizingHint: (model) => {
      const divisor = model?.constraints?.widthHeightDivisor
      return divisor != null ? ` This pixel-based model takes --size <x:y|WxH> or --width/--height (multiples of ${divisor}) instead.` : ''
    },
    buildImageSessionPayload: ({ messages, modelId, createdAt }) => ({ model: modelId, providerType: 'venice', createdAt, messages }),
  },
})

const { startImageSession } = await import('../src/commands/image-session.js')

const fakeProvider = {
  meta: { name: 'venice' },
  async fetchImageModels() {
    return [{ id: 'venice-sd35', name: 'SD 3.5', pricing: { perImage: 0.02 }, constraints: { aspectRatios: ['1:1', '16:9', '3:2'], formats: ['png', 'jpeg', 'webp'] } }]
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
    readInput: scriptedInput(['new prompt', '/exit']),
  }))

  assert.deepEqual(genCalls, ['new prompt'])
  const saved = JSON.parse(await readFile(sessionFile('2026-01-01T00-00-00'), 'utf-8'))
  assert.equal(saved.messages.length, 5)
  assert.equal(saved.messages[0].content, 'You are a helpful assistant.')
  assert.equal(saved.messages[3].content, 'new prompt')
})

test('/exit leaves the session without generating', async (t) => {
  genCalls.length = 0
  printed.length = 0
  mockConsole(t)

  await startImageSession(baseOpts({ readInput: scriptedInput(['/exit']) }))

  assert.deepEqual(genCalls, [])
  assert.deepEqual(printed, [])
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

test('/watermark on an openrouter session errors and continues', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    provider: { meta: { name: 'openrouter' }, fetchImageModels: fakeProvider.fetchImageModels },
    configPath: file,
    readInput: scriptedInput(['/watermark off', 'a cat', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('/watermark is only supported on Venice sessions.')))
  assert.deepEqual(genCalls, ['a cat'])
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

test('/aspect with a ratio on a pixel-based Venice model errors with a width/height hint', async (t) => {
  genCalls.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    configPath: file,
    readInput: scriptedInput(['/aspect 16:9', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: aspect ratio is not supported by z-image-turbo. This pixel-based model takes --size <x:y|WxH> or --width/--height (multiples of 8) instead.')), errors.join('\n'))
  assert.deepEqual(genCalls, [])
})

test('/aspect bare on a pixel-based Venice model reports it is unsupported', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    readInput: scriptedInput(['/aspect', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Aspect ratio is not supported by z-image-turbo. This pixel-based model takes --size <x:y|WxH> or --width/--height (multiples of 8) instead.')))
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

test('/aspect and /format are listed in /help', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/help', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('/aspect')))
  assert.ok(logs.some((l) => l.includes('/format')))
})

test('/size with a ratio sets the session size, persists the provider default and passes it as opts', async (t) => {
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
    readInput: scriptedInput(['/size 2:3', 'a cat', '/quit']),
  }))

  assert.deepEqual(genCalls, ['a cat'])
  assert.equal(genOpts[0].size, '848x1272')
  assert.equal(genOpts[0].aspectRatio, undefined)
  assert.ok(logs.some((l) => l.includes('Size set to 848x1272.')))
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { size: '848x1272' } })
})

test('/size with exact pixels sets the session size and persists it', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    configPath: file,
    readInput: scriptedInput(['/size 1024x1024', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].size, '1024x1024')
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { size: '1024x1024' } })
})

test('/size bare shows the presets with the current one marked', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    prefs: { imageDefaults: { venice: { size: '848x1272' } } },
    readInput: scriptedInput(['/size', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Sizes: 1:1 1280x1280 · 3:2 1272x848 · 16:9 1280x720 · 21:9 1264x544 · 9:16 720x1280 · 2:3 [848x1272] · 3:4 960x1280 · 4:5 1024x1280.')))
})

test('/size bare reports the presets when none is set', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    readInput: scriptedInput(['/size', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Sizes: 1:1 1280x1280 · 3:2 1272x848 · 16:9 1280x720 · 21:9 1264x544 · 9:16 720x1280 · 2:3 848x1272 · 3:4 960x1280 · 4:5 1024x1280 (none set).')))
})

test('/size bare notes a stored value outside the presets', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    prefs: { imageDefaults: { venice: { size: '1024x768' } } },
    readInput: scriptedInput(['/size', '/quit']),
  }))

  assert.ok(logs.some((l) => l.includes('Sizes: 1:1 1280x1280 · 3:2 1272x848 · 16:9 1280x720 · 21:9 1264x544 · 9:16 720x1280 · 2:3 848x1272 · 3:4 960x1280 · 4:5 1024x1280 (current: 1024x768).')))
})

test('/size clear unsets the size and removes the persisted key', async (t) => {
  genCalls.length = 0
  genOpts.length = 0
  printed.length = 0
  mockConsole(t)
  const file = await tempConfig(t)

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    configPath: file,
    prefs: { imageDefaults: { venice: { size: '848x1272', format: 'webp' } } },
    readInput: scriptedInput(['/size clear', 'a cat', '/quit']),
  }))

  assert.equal(genOpts[0].size, undefined)
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.deepEqual(prefs.imageDefaults, { venice: { format: 'webp' } })
})

test('/size with a non-divisor WxH errors', async (t) => {
  genCalls.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    readInput: scriptedInput(['/size 1023x1024', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: size 1023x1024 must be divisible by 8 for z-image-turbo.')))
  assert.deepEqual(genCalls, [])
})

test('/size with an invalid shape errors', async (t) => {
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: veniceNoRatioProvider,
    imageModelId: 'z-image-turbo',
    readInput: scriptedInput(['/size wide', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('--size must be in the form WxH (e.g. 848x1272) or W:H (e.g. 16:9).')))
})

test('/size on an aspect model errors with an /aspect hint', async (t) => {
  genCalls.length = 0
  printed.length = 0
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({ readInput: scriptedInput(['/size 2:3', '/quit']) }))

  assert.ok(errors.some((e) => e.includes('Error: size is not supported by venice-sd35. Use /aspect instead.')))
  assert.deepEqual(genCalls, [])
})

test('/size bare on an aspect model reports it is unsupported', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/size', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('Size is not supported by venice-sd35. Use /aspect instead.')))
})

test('/size on an OpenRouter model without lists errors', async (t) => {
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await startImageSession(baseOpts({
    provider: openRouterNoListsProvider,
    imageModelId: 'openai/gpt-5-image',
    readInput: scriptedInput(['/size 2:3', '/quit']),
  }))

  assert.ok(errors.some((e) => e.includes('Error: size is not supported by openai/gpt-5-image.')))
})

test('/size is listed in /help', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/help', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('/size')))
})
