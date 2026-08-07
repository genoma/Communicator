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
      genOpts.push({ aspectRatio: opts?.aspectRatio, imageFormat: opts?.imageFormat, sizingInteractive })
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

test('/aspect and /format are listed in /help and /size is not', async (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => { logs.push(String(line)) })
  t.mock.method(console, 'error', () => {})

  await startImageSession(baseOpts({ readInput: scriptedInput(['/help', '/quit']) }))

  assert.ok(logs.some((l) => l.includes('/aspect')))
  assert.ok(logs.some((l) => l.includes('/format')))
  assert.ok(!logs.some((l) => l.includes('/size')))
})

