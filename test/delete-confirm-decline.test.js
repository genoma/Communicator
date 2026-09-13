import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExitPromptError } from '@inquirer/core'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

let confirmImpl = async () => false
let checkboxImpl = async () => { throw new ExitPromptError() }
mock.module('node:os', { namedExports: { homedir: () => tempHome } })
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async () => { throw new ExitPromptError() },
    select: async () => { throw new ExitPromptError() },
    confirm: async (opts) => confirmImpl(opts),
    checkbox: async (opts) => checkboxImpl(opts),
  },
})

class ExitSignal {
  constructor(code) {
    this.code = code
  }
}

function sessionData(overrides = {}) {
  return {
    model: 'test/model',
    providerName: 'ProviderX',
    providerType: 'openrouter',
    reasoningEffort: 'low',
    temperature: 0.9,
    budget: 5,
    webSearch: 'off',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ],
    ...overrides,
  }
}

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
  delete: undefined,
  deleteAllSessions: undefined,
  attach: [],
}

function opts(overrides = {}) {
  return { ...BASE_OPTS, ...overrides }
}

async function runAndExit(t, overrides, promptArg, expectedCode) {
  let exitCode = null
  const out = []
  const err = []
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })
  t.mock.method(console, 'log', (msg) => out.push(String(msg)))
  t.mock.method(console, 'error', (msg) => err.push(String(msg)))
  const { runCli } = await import('../src/cli-main.js')
  await assert.rejects(
    runCli(opts(overrides), promptArg),
    (e) => e instanceof ExitSignal && e.code === expectedCode
  )
  return { exitCode, out, err }
}

function withTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original)
    else delete process.stdin.isTTY
  })
}

async function seedSession(id, data = {}) {
  const { ensureSessionsDir, saveSession } = await import('../src/sessions.js')
  const dir = await ensureSessionsDir()
  await saveSession(dir, id, sessionData(data))
  return dir
}

test('--delete <id> with a declined confirm keeps the session file and prints Deletion cancelled.', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-05-01T00-00-00')
  const confirmPrompts = []
  confirmImpl = async (opts) => {
    confirmPrompts.push(opts.message)
    return false
  }
  t.after(() => { confirmImpl = async () => false })

  const { out } = await runAndExit(t, { delete: '2026-05-01' }, undefined, 0)

  assert.deepEqual(confirmPrompts, ['Delete this session?'], 'the single-id TTY run must ask before deleting')
  assert.match(out.join('\n'), /Deletion cancelled\./)
  assert.ok(!out.join('\n').includes('Deleted session'), 'a declined run must not report a deletion')
  const files = await readdir(dir)
  assert.ok(files.includes('2026-05-01T00-00-00.json'), 'the declined session file must still exist')
})

test('--delete bare with a declined confirm keeps every selected session file.', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-05-02T00-00-00')
  await seedSession('2026-05-03T00-00-00')
  checkboxImpl = async () => ['2026-05-02T00-00-00', '2026-05-03T00-00-00']
  t.after(() => { checkboxImpl = async () => { throw new ExitPromptError() } })
  const confirmPrompts = []
  confirmImpl = async (opts) => {
    confirmPrompts.push(opts.message)
    return false
  }
  t.after(() => { confirmImpl = async () => false })

  const { out } = await runAndExit(t, { delete: true }, undefined, 0)

  assert.deepEqual(confirmPrompts, ['Delete these 2 sessions?'], 'the multi-select TTY run must confirm the whole selection')
  assert.match(out.join('\n'), /Deletion cancelled\./)
  assert.ok(!out.join('\n').includes('Deleted 2 sessions'), 'a declined run must not report a deletion')
  const files = await readdir(dir)
  assert.ok(files.includes('2026-05-02T00-00-00.json'), 'the first selected session file must still exist')
  assert.ok(files.includes('2026-05-03T00-00-00.json'), 'the second selected session file must still exist')
})
