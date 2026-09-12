import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasAttachments, isExitMode, isInteractiveFlag, isSessionOnly, validateCliFlags } from '../src/cli-validation.js'

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
  webSearch: undefined,
  webResults: undefined,
  smoothStreaming: true,
  smoothSpeed: undefined,
  watermark: true,
  delete: undefined,
  deleteAllSessions: undefined,
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

test('--e2ee requires --provider venice', () => {
  assert.deepEqual(
    validateCliFlags(opts({ e2ee: true }), TTY),
    ['Error: --e2ee is only available with --provider venice.']
  )
  assert.deepEqual(validateCliFlags(opts({ e2ee: true, provider: 'venice' }), TTY), [])
  // A resumed run executes on the provider saved in its session, so the check
  // moves to src/session-setup.js — in both directions.
  assert.deepEqual(validateCliFlags(opts({ e2ee: true, provider: 'openrouter', resume: 'id' }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ e2ee: true, resume: 'id' }), TTY), [])
})

test('--zdr requires --provider openrouter', () => {
  assert.deepEqual(
    validateCliFlags(opts({ zdr: true, provider: 'venice' }), TTY),
    ['Error: --zdr is only available with --provider openrouter.']
  )
  assert.deepEqual(validateCliFlags(opts({ zdr: true }), TTY), [])
  // A resumed run executes on the session's provider, so the check moves to
  // src/session-setup.js — in both directions.
  assert.deepEqual(validateCliFlags(opts({ zdr: true, provider: 'venice', resume: 'id' }), TTY), [])
})

test('--e2ee rejects --zdr', () => {
  assert.deepEqual(
    validateCliFlags(opts({ e2ee: true, zdr: true, provider: 'venice' }), TTY),
    ['Error: --zdr is only available with --provider openrouter.', 'Error: --e2ee cannot be combined with --zdr.']
  )
})

test('--e2ee rejects web search flags', () => {
  for (const other of [{ webSearch: 'auto' }, { webSearch: true }, { webSearch: 'off' }]) {
    assert.deepEqual(
      validateCliFlags(opts({ e2ee: true, provider: 'venice', ...other }), TTY),
      ['Error: --e2ee cannot be combined with --web-search or --web-results (E2EE does not support web search).']
    )
  }
  // --web-results on Venice surfaces the provider gate first: it defers only
  // on --resume now that the set-and-exit dispatch is gone.
  assert.deepEqual(
    validateCliFlags(opts({ e2ee: true, provider: 'venice', webResults: 5 }), TTY),
    [
      'Error: --web-results is only available with --provider openrouter.',
      'Error: --e2ee cannot be combined with --web-search or --web-results (E2EE does not support web search).',
    ]
  )
  // A resumed run defers the provider gate to the session's provider, so only
  // the e2ee rule remains.
  assert.deepEqual(
    validateCliFlags(opts({ e2ee: true, provider: 'venice', webResults: 5, resume: 'id' }), TTY),
    ['Error: --e2ee cannot be combined with --web-search or --web-results (E2EE does not support web search).']
  )
})

test('--web-results requires --provider openrouter', () => {
  assert.deepEqual(
    validateCliFlags(opts({ webResults: 5, provider: 'venice' }), { ...TTY, ...PROMPT() }),
    ['Error: --web-results is only available with --provider openrouter.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ webResults: 5, provider: 'venice' }), NO_TTY),
    ['Error: --web-results is only available with --provider openrouter.']
  )
  assert.deepEqual(validateCliFlags(opts({ webResults: 5 }), TTY), [])
  // A model and piped stdin make it a real run, not a set-and-exit dispatch, so
  // the provider check alone decides it: accepted on OpenRouter, and still
  // refused on Venice — a deferral that wrongly covered this shape would
  // return [] for both.
  assert.deepEqual(validateCliFlags(opts({ webResults: 5, model: 'org/model' }), NO_TTY), [])
  assert.deepEqual(
    validateCliFlags(opts({ webResults: 5, provider: 'venice', model: 'org/model' }), NO_TTY),
    ['Error: --web-results is only available with --provider openrouter.']
  )
  assert.deepEqual(validateCliFlags(opts({ webResults: 5 }), { ...TTY, ...PROMPT() }), [])
  // Only a resumed run defers (it executes on the provider saved in its
  // session, checked against the resolved provider in src/session-setup.js);
  // with the set-and-exit dispatch gone every other shape hits the gate.
  assert.deepEqual(validateCliFlags(opts({ webResults: 5, provider: 'venice', resume: 'id' }), TTY), [])
  assert.deepEqual(
    validateCliFlags(opts({ webResults: 5, provider: 'venice' }), TTY),
    ['Error: --web-results is only available with --provider openrouter.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ webResults: 5, provider: 'venice', aspectRatio: '1:1' }), NO_TTY),
    ['Error: --web-results is only available with --provider openrouter.']
  )
  // --rpg is a session route (the set-and-exit branch excludes it), so the
  // gate fires; --rpg --resume defers to the chapter's resolved provider.
  assert.deepEqual(
    validateCliFlags(opts({ webResults: 5, provider: 'venice', rpg: '/tmp/rpg' }), TTY),
    ['Error: --web-results is only available with --provider openrouter.']
  )
  assert.deepEqual(validateCliFlags(opts({ webResults: 5, provider: 'venice', rpg: '/tmp/rpg', resume: true }), TTY), [])
  // With a prompt the run reaches a session, so the gate fires and the e2ee
  // mutual-exclusion rule follows it.
  assert.deepEqual(
    validateCliFlags(opts({ webResults: 5, provider: 'venice', e2ee: true }), { ...TTY, ...PROMPT() }),
    [
      'Error: --web-results is only available with --provider openrouter.',
      'Error: --e2ee cannot be combined with --web-search or --web-results (E2EE does not support web search).',
    ]
  )
})

test('--rpg rejects --system-prompt and a session-id --resume', () => {
  assert.deepEqual(
    validateCliFlags(opts({ rpg: '/tmp/rpg', systemPrompt: '/tmp/system.md' }), TTY),
    ['Error: --rpg cannot be combined with --system-prompt.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ rpg: '/tmp/rpg', resume: 'x' }), TTY),
    ["Error: --rpg --resume does not take a session id (the story resumes from the RPG directory's chapter sessions, or its history.json for stories saved before that layout)."]
  )
  assert.deepEqual(validateCliFlags(opts({ rpg: '/tmp/rpg', resume: true }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ rpg: '/tmp/rpg', resume: true }), NO_TTY), [])
  assert.deepEqual(validateCliFlags(opts({ rpg: '/tmp/rpg', resume: true }), { ...TTY, ...PROMPT() }), [])
  assert.deepEqual(validateCliFlags(opts({ rpg: '/tmp/rpg' }), TTY), [])
})

test('--rpg rejects a flag-looking directory argument', () => {
  assert.deepEqual(
    validateCliFlags(opts({ rpg: '--debug' }), TTY),
    ['Error: --rpg expects a directory argument (got "--debug").']
  )
  assert.deepEqual(
    validateCliFlags(opts({ rpg: '-d' }), TTY),
    ['Error: --rpg expects a directory argument (got "-d").']
  )
})

test('--debug requires --rpg', () => {
  assert.deepEqual(
    validateCliFlags(opts({ debug: true }), TTY),
    ['Error: --debug requires --rpg.']
  )
  assert.deepEqual(validateCliFlags(opts({ debug: true, rpg: '/tmp/rpg' }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ rpg: '/tmp/rpg' }), TTY), [])
})

test('--e2ee rejects --attach', () => {
  assert.deepEqual(
    validateCliFlags(opts({ e2ee: true, provider: 'venice', attach: ['a.png'] }), { ...TTY, ...PROMPT() }),
    ['Error: --e2ee cannot be combined with --attach (E2EE does not support file uploads).']
  )
})

test('--e2ee rejects --image', () => {
  assert.deepEqual(
    validateCliFlags(opts({ e2ee: true, provider: 'venice', image: true }), TTY),
    ['Error: --e2ee cannot be combined with --image (E2EE is text-only).']
  )
})

test('--scrape requires the Venice provider', () => {
  assert.deepEqual(
    validateCliFlags(opts({ scrape: 'https://example.com' }), { ...TTY, ...PROMPT() }),
    ['Error: --scrape is only available with --provider venice.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ scrape: 'https://example.com', provider: 'venice' }), { ...TTY, ...PROMPT() }),
    []
  )
  // A resumed run executes on the provider saved in its session, so the gate
  // defers; the plain resume form still trips the session-flag exclusion,
  // while the chapter (--rpg) resume form reaches the scraping path itself.
  assert.deepEqual(
    validateCliFlags(opts({ scrape: 'https://example.com', resume: 'x' }), TTY),
    ['Error: --model, --output-dir, --attach and --scrape cannot be combined with --resume (resumed sessions keep their own model; --output-dir only applies to --export).']
  )
  assert.deepEqual(validateCliFlags(opts({ scrape: 'https://example.com', rpg: '/tmp/rpg', resume: true }), TTY), [])
})

test('--e2ee rejects --scrape', () => {
  assert.deepEqual(
    validateCliFlags(opts({ e2ee: true, provider: 'venice', scrape: 'https://example.com' }), { ...TTY, ...PROMPT() }),
    ['Error: --e2ee cannot be combined with --scrape (E2EE does not support web scraping).']
  )
})

test('--scrape is a session flag: conflicts with exit modes, export, delete and resume', () => {
  const scrape = { scrape: 'https://example.com', provider: 'venice' }
  assert.deepEqual(
    validateCliFlags(opts({ ...scrape, listModels: true }), TTY),
    ['Error: --model, --output-dir and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --list-* flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ ...scrape, export: 'x' }), TTY),
    ['Error: --model and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --export.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ ...scrape, delete: 'x' }), TTY),
    ['Error: --model, --output-dir and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --delete.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ ...scrape, deleteAllSessions: 'y' }), TTY),
    ['Error: --model, --output-dir and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --delete-all-sessions.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ ...scrape, resume: 'x' }), TTY),
    ['Error: --model, --output-dir, --attach and --scrape cannot be combined with --resume (resumed sessions keep their own model; --output-dir only applies to --export).']
  )
  assert.deepEqual(
    validateCliFlags(opts({ ...scrape, config: true }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ ...scrape, image: true }), TTY),
    ['Error: --image cannot be combined with chat session flags (--model, --attach, --system-prompt, --rpg, --temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --zdr, --scrape).']
  )
})

test('bare --config rejects --e2ee', () => {
  assert.deepEqual(
    validateCliFlags(opts({ config: true, e2ee: true, provider: 'venice' }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
  )
})

test('bare --config rejects --zdr', () => {
  assert.deepEqual(
    validateCliFlags(opts({ config: true, zdr: true }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
  )
})

test('rejects --resume combined with --export', () => {
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x', export: 'y' }), TTY),
    ['Error: Cannot use --resume and --export together. Use one at a time.']
  )
})

test('rejects --delete combined with --resume or --export', () => {
  assert.deepEqual(
    validateCliFlags(opts({ delete: 'x', resume: 'y' }), TTY),
    ['Error: Cannot use --delete with --resume or --export. Use one at a time.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ delete: 'x', export: 'y' }), TTY),
    ['Error: Cannot use --delete with --resume or --export. Use one at a time.']
  )
})

test('rejects --delete-all-sessions combined with --delete, --resume or --export', () => {
  for (const other of [{ delete: 'x' }, { resume: 'y' }, { export: 'y' }]) {
    assert.deepEqual(
      validateCliFlags(opts({ deleteAllSessions: 'y', ...other }), TTY),
      ['Error: Cannot use --delete-all-sessions with --resume, --export or --delete. Use one at a time.']
    )
  }
})

test('rejects --delete-all-sessions combined with a prompt argument', () => {
  assert.deepEqual(
    validateCliFlags(opts({ deleteAllSessions: 'y' }), { ...TTY, ...PROMPT() }),
    ['Cannot combine a prompt argument with --delete-all-sessions.']
  )
})

test('rejects --delete-all-sessions combined with --list-* flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ deleteAllSessions: 'y', listSessions: true }), TTY),
    ['Error: --delete-all-sessions cannot be combined with --list-* flags.']
  )
})

test('rejects --delete-all-sessions combined with session flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ deleteAllSessions: 'y', webSearch: 'auto' }), TTY),
    ['Error: --model, --output-dir and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --delete-all-sessions.']
  )
})

test('--delete-all-sessions y works with piped stdin; bare flag needs a TTY', () => {
  assert.deepEqual(validateCliFlags(opts({ deleteAllSessions: 'y' }), NO_TTY), [])
  assert.deepEqual(validateCliFlags(opts({ deleteAllSessions: 'y' }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ deleteAllSessions: true }), TTY), [])
  assert.deepEqual(
    validateCliFlags(opts({ deleteAllSessions: true }), NO_TTY),
    ['Error: bare --delete-all-sessions needs a TTY (pass y to confirm non-interactively).']
  )
})

test('rejects --delete-all-sessions combined with bare --config', () => {
  assert.deepEqual(
    validateCliFlags(opts({ deleteAllSessions: 'y', config: true }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
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

test('bare --resume, --export and --delete need a TTY; a session id does not', () => {
  const gates = [
    ['resume', 'Error: bare --resume needs a TTY (pass a session id to select non-interactively).'],
    ['export', 'Error: bare --export needs a TTY (pass a session id to select non-interactively).'],
    ['delete', 'Error: bare --delete needs a TTY (pass a session id to select non-interactively).'],
  ]
  for (const [flag, message] of gates) {
    assert.deepEqual(validateCliFlags(opts({ [flag]: true }), NO_TTY), [message])
    assert.deepEqual(validateCliFlags(opts({ [flag]: true }), TTY), [])
    // Only the picker form needs a TTY: an id selects without one, so a
    // scripted/CI caller can drive all three flags headless.
    assert.deepEqual(validateCliFlags(opts({ [flag]: '2026-01-01T00-00-00' }), NO_TTY), [])
  }
})

test('bare --rpg --resume stays exempt from the TTY gate', () => {
  // A piped chapter resume falls back to the most recent chapter instead of
  // opening the picker (src/commands/rpg-resume.js).
  assert.deepEqual(validateCliFlags(opts({ rpg: '/tmp/rpg', resume: true }), NO_TTY), [])
  assert.deepEqual(validateCliFlags(opts({ rpg: '/tmp/rpg', resume: 'x' }), NO_TTY), [
    "Error: --rpg --resume does not take a session id (the story resumes from the RPG directory's chapter sessions, or its history.json for stories saved before that layout).",
  ])
})

test('rejects exit-mode flags combined with session flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ listSessions: true, temperature: 0.5 }), TTY),
    ['Error: --model, --output-dir and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --list-* flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ listModels: true, model: 'm' }), TTY),
    ['Error: --model, --output-dir and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --list-* flags.']
  )
})

test('rejects exit-mode flags combined with --zdr or --e2ee', () => {
  assert.deepEqual(
    validateCliFlags(opts({ zdr: true, listModels: true }), TTY),
    ['Error: --zdr cannot be combined with --list-* flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ e2ee: true, provider: 'venice', listModels: true }), TTY),
    ['Error: --e2ee cannot be combined with --list-* flags.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ listSessions: true, zdr: true }), TTY),
    ['Error: --zdr cannot be combined with --list-* flags.']
  )
  // Both flags share one error, named in the order the flags are declared.
  // The provider and mutual-exclusion gates still come first.
  assert.deepEqual(
    validateCliFlags(opts({ e2ee: true, zdr: true, provider: 'venice', listModels: true }), TTY),
    [
      'Error: --zdr is only available with --provider openrouter.',
      'Error: --e2ee cannot be combined with --zdr.',
      'Error: --zdr and --e2ee cannot be combined with --list-* flags.',
    ]
  )
})

test('the --zdr provider gate still precedes the exit-mode error', () => {
  assert.deepEqual(
    validateCliFlags(opts({ zdr: true, provider: 'venice', listSessions: true }), TTY),
    [
      'Error: --zdr is only available with --provider openrouter.',
      'Error: --zdr cannot be combined with --list-* flags.',
    ]
  )
})

test('rejects --export, --delete and --delete-all-sessions combined with --zdr or --e2ee', () => {
  assert.deepEqual(
    validateCliFlags(opts({ export: 'x', zdr: true }), TTY),
    ['Error: --zdr cannot be combined with --export.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ delete: 'x', zdr: true }), TTY),
    ['Error: --zdr cannot be combined with --delete.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ deleteAllSessions: 'y', zdr: true }), TTY),
    ['Error: --zdr cannot be combined with --delete-all-sessions.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ export: 'x', e2ee: true, provider: 'venice' }), TTY),
    ['Error: --e2ee cannot be combined with --export.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ delete: 'x', e2ee: true, provider: 'venice' }), TTY),
    ['Error: --e2ee cannot be combined with --delete.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ deleteAllSessions: 'y', e2ee: true, provider: 'venice' }), TTY),
    ['Error: --e2ee cannot be combined with --delete-all-sessions.']
  )
})

test('the exit-path rule leaves --resume alone and keeps the provider gate first', () => {
  assert.deepEqual(validateCliFlags(opts({ resume: 'id', zdr: true }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ resume: 'id', e2ee: true, provider: 'venice' }), TTY), [])
  assert.deepEqual(
    validateCliFlags(opts({ export: 'x', zdr: true, provider: 'venice' }), TTY),
    [
      'Error: --zdr is only available with --provider openrouter.',
      'Error: --zdr cannot be combined with --export.',
    ]
  )
  assert.deepEqual(
    validateCliFlags(opts({ export: 'x', e2ee: true, zdr: true, provider: 'venice' }), TTY),
    [
      'Error: --zdr is only available with --provider openrouter.',
      'Error: --e2ee cannot be combined with --zdr.',
      'Error: --zdr and --e2ee cannot be combined with --export.',
    ]
  )
})

test('--e2ee on Venice without a list flag stays legal', () => {
  assert.deepEqual(validateCliFlags(opts({ e2ee: true, provider: 'venice', model: 'venice/model-x' }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ e2ee: true, provider: 'venice', model: 'venice/model-x' }), { ...TTY, ...PROMPT() }), [])
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
      'Error: --resume, --export and --delete cannot be combined with --list-* flags.',
    ]
  )
  assert.deepEqual(validateCliFlags(opts({ listEndpoints: 'm' }), NO_TTY), [])
  assert.deepEqual(validateCliFlags(opts({ resume: 'x' }), TTY), [])
})

test('rejects --export combined with session flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ export: 'x', temperature: 0.5 }), TTY),
    ['Error: --model and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --export.']
  )
})

test('rejects --delete combined with session flags', () => {
  assert.deepEqual(
    validateCliFlags(opts({ delete: 'x', attach: ['a.txt'] }), TTY),
    [
      'Error: --model, --output-dir and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --delete.',
      'Error: --attach requires a prompt argument or piped stdin.',
    ]
  )
})

test('rejects --resume combined with --model, --output-dir or --attach', () => {
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x', model: 'm' }), TTY),
    ['Error: --model, --output-dir, --attach and --scrape cannot be combined with --resume (resumed sessions keep their own model; --output-dir only applies to --export).']
  )
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x', attach: ['a.txt'] }), TTY),
    [
      'Error: --model, --output-dir, --attach and --scrape cannot be combined with --resume (resumed sessions keep their own model; --output-dir only applies to --export).',
      'Error: --attach requires a prompt argument or piped stdin.',
    ]
  )
})

test('--output-dir requires --export or --image', () => {
  const message = 'Error: --output-dir requires --export or --image.'
  assert.deepEqual(
    validateCliFlags(opts({ outputDir: '/x' }), NO_TTY),
    [message]
  )
  assert.deepEqual(
    validateCliFlags(opts({ outputDir: '/x' }), { ...TTY, ...PROMPT() }),
    [message]
  )
  // With the set-and-exit dispatch gone there is no bare setter form left: the
  // flag is legal only where a run can consume it.
  assert.deepEqual(validateCliFlags(opts({ outputDir: '/x' }), TTY), [message])
  assert.deepEqual(validateCliFlags(opts({ outputDir: '/x', export: 'y' }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ outputDir: '/x', image: true, imageModel: 'm' }), TTY), [])
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

test('bare --config rejects --no-safe-mode but --image accepts it', () => {
  assert.deepEqual(
    validateCliFlags(opts({ config: true, safeMode: false }), TTY),
    ['Error: bare --config (config view) cannot be combined with other flags.']
  )
  assert.deepEqual(validateCliFlags(opts({ image: true, safeMode: false, provider: 'venice' }), TTY), [])
})

test('rejects --attach without a prompt in a TTY', () => {
  assert.deepEqual(
    validateCliFlags(opts({ attach: ['a.txt'] }), TTY),
    ['Error: --attach requires a prompt argument or piped stdin.']
  )
  assert.deepEqual(validateCliFlags(opts({ attach: ['a.txt'] }), NO_TTY), [])
  assert.deepEqual(validateCliFlags(opts({ attach: ['a.txt'] }), { ...TTY, ...PROMPT() }), [])
})

test('--no-save requires a headless run', () => {
  const message = 'Error: --no-save requires a prompt argument or piped stdin (an interactive session always saves).'
  assert.deepEqual(validateCliFlags(opts({ save: false }), TTY), [message])
  assert.deepEqual(validateCliFlags(opts({ save: false }), NO_TTY), [])
  assert.deepEqual(validateCliFlags(opts({ save: false }), { ...TTY, ...PROMPT() }), [])
})

test('--no-save is rejected next to every exit path', () => {
  // Piped stdin keeps the rule under test the only one that fires.
  for (const [extra, expected] of [
    [{ listModels: true }, 'Error: --no-save cannot be combined with --list-* flags.'],
    [{ export: 'x' }, 'Error: --no-save cannot be combined with --export.'],
    [{ delete: 'x' }, 'Error: --no-save cannot be combined with --delete.'],
    [{ deleteAllSessions: 'y' }, 'Error: --no-save cannot be combined with --delete-all-sessions.'],
    [{ config: true }, 'Error: bare --config (config view) cannot be combined with other flags.'],
  ]) {
    assert.deepEqual(validateCliFlags(opts({ save: false, ...extra }), NO_TTY), [expected])
  }
})

test('--no-save rejects the image-default flags on a text run but not on --image', () => {
  const both = 'Error: --aspect-ratio and --image-format cannot be combined with --no-save on a text run (they only persist image defaults there).'
  assert.deepEqual(
    validateCliFlags(opts({ save: false, aspectRatio: '16:9' }), NO_TTY),
    ['Error: --aspect-ratio cannot be combined with --no-save on a text run (they only persist image defaults there).']
  )
  assert.deepEqual(
    validateCliFlags(opts({ save: false, imageFormat: 'png' }), NO_TTY),
    ['Error: --image-format cannot be combined with --no-save on a text run (they only persist image defaults there).']
  )
  assert.deepEqual(validateCliFlags(opts({ save: false, aspectRatio: '16:9', imageFormat: 'png' }), NO_TTY), [both])
  // On an --image run both flags shape the request, so --no-save only means
  // "do not persist the default they resolve".
  assert.deepEqual(validateCliFlags(opts({ save: false, image: true, aspectRatio: '16:9', imageFormat: 'png' }), NO_TTY), [])
  assert.deepEqual(validateCliFlags(opts({ save: false, image: true, aspectRatio: '16:9' }), { ...TTY, ...PROMPT() }), [])
})

test('reports every violated combination in order', () => {
  assert.deepEqual(
    validateCliFlags(opts({ resume: 'x', export: 'y', webSearch: 'bogus' }), TTY),
    [
      'Error: --web-search expects "auto", "always", "on", or "off" (bare flag = auto).',
      'Error: Cannot use --resume and --export together. Use one at a time.',
      'Error: --model and the session flags (--temperature, --top-p, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape) cannot be combined with --export.',
    ]
  )
})

test('predicates classify flags', () => {
  assert.equal(isInteractiveFlag(opts()), false)
  assert.equal(isInteractiveFlag(opts({ resume: 'x' })), true)
  assert.equal(isInteractiveFlag(opts({ export: 'x' })), true)
  assert.equal(isInteractiveFlag(opts({ delete: 'x' })), true)
  assert.equal(isInteractiveFlag(opts({ deleteAllSessions: 'y' })), false)

  assert.equal(isExitMode(opts()), false)
  assert.equal(isExitMode(opts({ listModels: true })), true)
  assert.equal(isExitMode(opts({ listEndpoints: 'm' })), true)
  assert.equal(isExitMode(opts({ listSessions: true })), true)

  assert.equal(isSessionOnly(opts()), false)
  assert.equal(isSessionOnly(opts({ temperature: 0.5 })), true)
  assert.equal(isSessionOnly(opts({ smoothStreaming: false })), true)
  assert.equal(isSessionOnly(opts({ systemPrompt: '/p' })), true)
  assert.equal(isSessionOnly(opts({ attach: ['a.txt'] })), true)
  assert.equal(isSessionOnly(opts({ scrape: 'https://example.com' })), true)

  assert.equal(hasAttachments(opts()), false)
  assert.equal(hasAttachments(opts({ attach: [] })), false)
  assert.equal(hasAttachments(opts({ attach: ['a.txt'] })), true)
})

test('a session-shaping flag next to --web-results surfaces the provider gate', () => {
  const venice = { provider: 'venice', webResults: 3, systemPrompt: '/p' }
  assert.deepEqual(validateCliFlags(opts(venice), { promptArg: undefined, isTTY: true }), [
    'Error: --web-results is only available with --provider openrouter.',
  ])
  assert.deepEqual(validateCliFlags(opts(venice), { promptArg: undefined, isTTY: false }), [
    'Error: --web-results is only available with --provider openrouter.',
  ])
})

test('pure setters are rejected next to an exit path instead of being ignored', () => {
  assert.deepEqual(validateCliFlags(opts({ listModels: true, watermark: false }), TTY), [
    'Error: --no-watermark cannot be combined with --list-* flags.',
  ])
  assert.deepEqual(validateCliFlags(opts({ listModels: true, safeMode: false, aspectRatio: '16:9' }), TTY), [
    'Error: --no-safe-mode and --aspect-ratio cannot be combined with --list-* flags.',
  ])
  assert.deepEqual(validateCliFlags(opts({ listSessions: true, imageFormat: 'png' }), TTY), [
    'Error: --image-format cannot be combined with --list-* flags.',
  ])
  assert.deepEqual(validateCliFlags(opts({ export: 'id', watermark: false }), TTY), [
    'Error: --no-watermark cannot be combined with --export.',
  ])
  assert.deepEqual(validateCliFlags(opts({ delete: 'id', aspectRatio: '16:9' }), TTY), [
    'Error: --aspect-ratio cannot be combined with --delete.',
  ])
})

test('the session-flags exclusion still precedes the pure-setter rule', () => {
  const errors = validateCliFlags(opts({ listModels: true, watermark: false, temperature: '0.5' }), TTY)
  assert.match(errors[0], /session flags/)
  assert.equal(errors[1], 'Error: --no-watermark cannot be combined with --list-* flags.')
})

test('--export-format requires --export and accepts only the two formats', () => {
  assert.deepEqual(
    validateCliFlags(opts({ exportFormat: 'jsonl' }), TTY),
    ['Error: --export-format requires --export.']
  )
  assert.deepEqual(
    validateCliFlags(opts({ exportFormat: 'csv', export: true }), TTY),
    ['Error: --export-format expects "markdown" or "jsonl".']
  )
  assert.deepEqual(validateCliFlags(opts({ exportFormat: 'jsonl', export: true }), TTY), [])
  assert.deepEqual(validateCliFlags(opts({ exportFormat: 'markdown', export: 'x' }), TTY), [])
})
