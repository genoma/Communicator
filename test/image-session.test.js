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
const printed = []
mock.module(new URL('../src/commands/image-gen.js', import.meta.url).href, {
  namedExports: {
    runImageGeneration: async ({ prompt, model, prefs }) => {
      genCalls.push(prompt)
      genPrefs.push(prefs?.hideWatermark)
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
    return [{ id: 'venice-sd35', name: 'SD 3.5', pricing: { perImage: 0.02 } }]
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
