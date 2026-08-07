import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasAttachments, isConfigSetter, isExitMode, isInteractiveFlag, isSessionOnly, validateCliFlags } from '../src/cli-validation.js'

const BASE_OPTS = {
  model: undefined,
  provider: 'openrouter',
  listModels: undefined,
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
  watermark: true,
  delete: undefined,
  attach: [],
}

const opts = (overrides = {}) => ({ ...BASE_OPTS, ...overrides })

const TTY = { isTTY: true }
const NO_TTY = { isTTY: false }
const PROMPT = (v = 'hi') => ({ promptArg: v })

test('empty options validate cleanly', () => {
  assert.deepEqual(validateCliFlags(opts(), { ...TTY, ...PROMPT() }), [])
  assert.deepEqual(validateCliFlags(opts(), TTY), [])
})

test('rejects an invalid --web-search mode', () => {
  assert.deepEqual(
    validateCliFlags(opts({ webSearch: 'bogus' }), TTY),
    ['Error: --web-search expects "auto", "always", "on", or "off" (bare flag = auto).']
  )
  assert.deepEqual(validateCliFlags(opts({ webSearch: 'on' }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ webSearch: true }), TTY), [])
})

test('rejects --resume combined with --export', () => {
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x', export: 'y' }), TTY),
    ['Cannot use --resume and --export together. Use one at a time.']
  )
})

test('rejects --delete combined with --resume or --export', () => {
  assert.deepEqual(
    validateCliFlags(opts({ delete: 'x', resume: 'y' }), TTY),
    ['Cannot use --delete with --resume or --export. Use one at a time.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ delete: 'x', export: 'y' }), TTY),
    ['Cannot use --delete with --resume or --export. Use one at a time.']
  )
})

test('rejects a prompt argument combined with interactive or exit-mode flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x' }), { ...TTY, ...PROMPT() }),
    ['Cannot combine a prompt argument with --resume, --export, --delete, or --list-* flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ listSessions: true }), { ...TTY, ...PROMPT() }),
    ['Cannot combine a prompt argument with --resume, --export, --delete, or --list-* flags.']
  )
})

test('rejects interactive flags with piped stdin', () => {
  assert.deepEqual(
    validateCliFlags(opts({ export: undefined, resume: 'x' }), NO_TTY),
    ['Cannot use --resume, --export, or --delete with piped stdin (interactive pickers need a TTY).']
  )
})

test('rejects exit-mode flags combined with session flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ listSessions: true, temperature: 0.5 }), TTY),
    ['Error: --model, --output-dir, --system-prompt and the session flags (--temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --attach) cannot be combined with --list-* flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ listModels: true, model: 'm' }), TTY),
    ['Error: --model, --output-dir, --system-prompt and the session flags (--temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --attach) cannot be combined with --list-* flags.']
  )
})

test('rejects interactive flags combined with exit-mode flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x', listModels: true }), TTY),
    ['Error: --resume, --export and --delete cannot be combined with --list-* flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ delete: 'x', listSessions: true }), TTY),
    ['Error: --resume, --export and --delete cannot be combined with --list-* flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ export: 'x', listEndpoints: 'm' }), NO_TTY),
    [
      'Cannot use --resume, --export, or --delete with piped stdin (interactive pickers need a TTY).',
      'Error: --resume, --export and --delete cannot be combined with --list-* flags.',
    ]
  )
  assert.deepEqual(validateCliFlags(opts({ listEndpoints: 'm' }), NO_TTY), [])
  assert.deepEqual(validateCliFlags(opts({ resume: 'x' }), TTY), [])
})

test('rejects --export combined with session flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ export: 'x', budget: 5 }), TTY),
    ['Error: --model, --system-prompt and the session flags (--temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --attach) cannot be combined with --export.']
  )
})

test('rejects --delete combined with session flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ delete: 'x', attach: ['a.txt'] }), TTY),
    [
      'Error: --model, --output-dir, --system-prompt and the session flags (--temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --attach) cannot be combined with --delete.',
      'Error: --attach requires a prompt argument or piped stdin.',
    ]
  )
})

test('rejects --resume combined with --model, --output-dir or --attach', () => {
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x', model: 'm' }), TTY),
    ['Error: --model, --output-dir and --attach cannot be combined with --resume (resumed sessions keep their own model; --output-dir only applies to --export).']
  )
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x', attach: ['a.txt'] }), TTY),
    [
      'Error: --model, --output-dir and --attach cannot be combined with --resume (resumed sessions keep their own model; --output-dir only applies to --export).',
      'Error: --attach requires a prompt argument or piped stdin.',
    ]
  )
})

test('rejects bare --output-dir without a TTY or --export', () => {
  assert.deepEqual(
    validateCliFlags(opts({ outputDir: '/x' }), NO_TTY),
    ['Error: --output-dir sets the default export directory. Use it alone (with a TTY) or with --export.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ outputDir: '/x' }), { ...TTY, ...PROMPT() }),
    ['Error: --output-dir sets the default export directory. Use it alone (with a TTY) or with --export.']
  )
  assert.deepEqual(validateCliFlags(opts({ outputDir: '/x' }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ outputDir: '/x', export: 'y' }), TTY), [])
})

test('rejects bare --config combined with other flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ config: true, temperature: 0.5 }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ config: true, provider: 'venice' }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
  )
  assert.deepEqual(validateCliFlags(opts({ config: true }), TTY), [])
})

test('bare --config rejects --no-watermark but --image accepts it', () => {
  assert.deepEqual(
    validateCliFlags(opts({ config: true, watermark: false }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
  )
  assert.deepEqual(validateCliFlags(opts({ image: true, watermark: false, provider: 'venice' }), TTY), [])
})

test('rejects --attach without a prompt in a TTY', () => {
  assert.deepEqual(
    validateCliFlags(opts({ attach: ['a.txt'] }), TTY),
    ['Error: --attach requires a prompt argument or piped stdin.']
  )
  assert.deepEqual(validateCliFlags(opts({ attach: ['a.txt'] }), NO_TTY), [])
  assert.deepEqual(validateCliFlags(opts({ attach: ['a.txt'] }), { ...TTY, ...PROMPT() }), [])
})

test('reports every violated combination in order', () => {
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x', export: 'y', webSearch: 'bogus' }), TTY),
    [
      'Error: --web-search expects "auto", "always", "on", or "off" (bare flag = auto).',
      'Cannot use --resume and --export together. Use one at a time.',
      'Error: --model, --system-prompt and the session flags (--temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --attach) cannot be combined with --export.',
    ]
  )
})

test('predicates classify flags', () => {
  assert.equal(isInteractiveFlag(opts()), false)
  assert.equal(isInteractiveFlag(opts({ resume: 'x' })), true)
  assert.equal(isInteractiveFlag(opts({ export: 'x' })), true)
  assert.equal(isInteractiveFlag(opts({ delete: 'x' })), true)

  assert.equal(isExitMode(opts()), false)
  assert.equal(isExitMode(opts({ listModels: true })), true)
  assert.equal(isExitMode(opts({ listEndpoints: 'm' })), true)
  assert.equal(isExitMode(opts({ listSessions: true })), true)

  assert.equal(isSessionOnly(opts()), false)
  assert.equal(isSessionOnly(opts({ temperature: 0.5 })), true)
  assert.equal(isSessionOnly(opts({ smoothStreaming: false })), true)
  assert.equal(isSessionOnly(opts({ systemPrompt: '/p' })), true)
  assert.equal(isSessionOnly(opts({ attach: ['a.txt'] })), true)

  assert.equal(isConfigSetter(opts()), false)
  assert.equal(isConfigSetter(opts({ model: 'm' })), true)
  assert.equal(isConfigSetter(opts({ outputDir: '/x' })), true)
  assert.equal(isConfigSetter(opts({ webResults: 5 })), true)
  assert.equal(isConfigSetter(opts({ watermark: false })), true)

  assert.equal(hasAttachments(opts()), false)
  assert.equal(hasAttachments(opts({ attach: [] })), false)
  assert.equal(hasAttachments(opts({ attach: ['a.txt'] })), true)
})
