import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCliFlags, isExitMode, isConfigSetter } from '../src/cli-validation.js'

const BASE_OPTS = {
  model: undefined,
  provider: 'venice',
  listModels: undefined,
  listImageModels: undefined,
  listEndpoints: undefined,
  resume: undefined,
  export: undefined,
  outputDir: undefined,
  listSessions: undefined,
  config: undefined,
  systemPrompt: undefined,
  reasoningEffort: undefined,
  temperature: undefined,
  budget: undefined,
  webSearch: undefined,
  webResults: undefined,
  smoothStreaming: true,
  smoothSpeed: undefined,
  delete: undefined,
  deleteAllSessions: undefined,
  attach: [],
  image: undefined,
  imageModel: undefined,
  imageFormat: undefined,
  variants: undefined,
  aspectRatio: undefined,
  resolution: undefined,
  quality: undefined,
  seed: undefined,
  width: undefined,
  height: undefined,
  safeMode: true,
  zdr: undefined,
}

const opts = (overrides = {}) => ({ ...BASE_OPTS, ...overrides })

const TTY = { isTTY: true }
const NO_TTY = { isTTY: false }
const PROMPT = (v = 'a red cat') => ({ promptArg: v })

const SESSION_FLAGS_ERROR = 'Error: --image cannot be combined with chat session flags (--model, --attach, --system-prompt, --temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --zdr, --scrape).'
const INTERACTIVE_ERROR = 'Error: --image cannot be combined with --resume, --export, --delete, or --list-* flags.'

test('--image with a prompt validates cleanly on venice', () => {
  assert.deepEqual(validateCliFlags(opts({ image: true }), { ...TTY, ...PROMPT() }), [])
  assert.deepEqual(validateCliFlags(opts({ image: true }), { ...NO_TTY, ...PROMPT() }), [])
})

test('--image validates cleanly on any provider', () => {
  assert.deepEqual(validateCliFlags(opts({ image: true, provider: 'openrouter' }), { ...TTY, ...PROMPT() }), [])
  assert.deepEqual(validateCliFlags(opts({ image: true, provider: 'openrouter' }), { ...NO_TTY, ...PROMPT() }), [])
})

test('--list-image-models validates cleanly on any provider', () => {
  assert.deepEqual(validateCliFlags(opts({ provider: 'openrouter', listImageModels: true }), TTY), [])
})

test('--image-model requires --image', () => {
  assert.deepEqual(
    validateCliFlags(opts({ imageModel: 'flux-1-1' }), TTY),
    ['Error: --image-model requires --image.']
  )
  assert.deepEqual(validateCliFlags(opts({ image: true, imageModel: 'flux-1-1' }), { ...TTY, ...PROMPT() }), [])
})

test('--image rejects every chat session flag', () => {
  for (const [name, value] of [
    ['model', 'm'],
    ['attach', ['a.png']],
    ['systemPrompt', '/path'],
    ['reasoningEffort', 'high'],
    ['temperature', 0.5],
    ['budget', 5],
    ['webSearch', 'on'],
    ['webResults', 5],
    ['smoothSpeed', 'fast'],
    ['smoothStreaming', false],
    ['zdr', true],
  ]) {
    assert.deepEqual(
      validateCliFlags(opts({ image: true, [name]: value }), { ...TTY, ...PROMPT() }),
      [SESSION_FLAGS_ERROR],
      `expected --image + --${name} to be rejected`
    )
  }
})

test('--image rejects --resume, --export, --delete and --list-* flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ image: true, resume: 'x' }), TTY),
    [INTERACTIVE_ERROR]
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, export: 'x' }), TTY),
    [INTERACTIVE_ERROR]
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, delete: 'x' }), TTY),
    [INTERACTIVE_ERROR]
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, listSessions: true }), TTY),
    [INTERACTIVE_ERROR]
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, listImageModels: true }), TTY),
    [INTERACTIVE_ERROR]
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, listModels: true }), TTY),
    [INTERACTIVE_ERROR]
  )
})

test('--image rejects --delete-all-sessions', () => {
  assert.deepEqual(
    validateCliFlags(opts({ image: true, deleteAllSessions: 'y' }), TTY),
    ['Error: --image cannot be combined with --delete-all-sessions.']
  )
})

test('--width and --height conflict with --aspect-ratio and --resolution', () => {
  assert.deepEqual(
    validateCliFlags(opts({ image: true, width: 1024, aspectRatio: '16:9' }), { ...TTY, ...PROMPT() }),
    ['Error: --width and --height must be used together.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, height: 1024, resolution: '2K' }), { ...TTY, ...PROMPT() }),
    ['Error: --width and --height must be used together.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, width: 1024, height: 1024, aspectRatio: '16:9' }), { ...TTY, ...PROMPT() }),
    ['Error: --width and --height cannot be combined with --aspect-ratio.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, width: 1024, height: 1024, resolution: '2K' }), { ...TTY, ...PROMPT() }),
    ['Error: --width and --height cannot be combined with --resolution.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, width: 1024 }), { ...TTY, ...PROMPT() }),
    ['Error: --width and --height must be used together.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, width: 1024, height: 1024 }), { ...TTY, ...PROMPT() }),
    []
  )
})

test('--image accepts --output-dir with a prompt or piped stdin', () => {
  assert.deepEqual(
    validateCliFlags(opts({ image: true, outputDir: '/tmp/out' }), { ...TTY, ...PROMPT() }),
    []
  )
  assert.deepEqual(
    validateCliFlags(opts({ image: true, outputDir: '/tmp/out' }), { ...NO_TTY, ...PROMPT() }),
    []
  )
})

test('--image with no prompt and no stdin is left to the command layer', () => {
  assert.deepEqual(validateCliFlags(opts({ image: true }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ image: true }), NO_TTY), [])
})

test('--image-model alone with --list-image-models still requires --image', () => {
  assert.deepEqual(
    validateCliFlags(opts({ listImageModels: true, imageModel: 'flux' }), TTY),
    ['Error: --image-model requires --image.']
  )
})

test('isExitMode includes --list-image-models', () => {
  assert.equal(isExitMode(opts({ listImageModels: true })), true)
  assert.equal(isExitMode(opts({ image: true })), false)
})

test('--aspect-ratio and --image-format make the invocation a config setter', () => {
  assert.equal(isConfigSetter(opts({ aspectRatio: '16:9' })), true)
  assert.equal(isConfigSetter(opts({ imageFormat: 'png' })), true)
  assert.equal(isConfigSetter(opts()), false)
})

test('bare --config cannot be combined with the image default flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ config: true, aspectRatio: '16:9' }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ config: true, imageFormat: 'png' }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
  )
})
