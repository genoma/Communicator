import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExitPromptError } from '@inquirer/core'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async () => { throw new ExitPromptError() },
    select: async () => { throw new ExitPromptError() },
    confirm: async () => false,
    checkbox: async () => { throw new ExitPromptError() },
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
  budget: undefined,
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

test('--delete-all-sessions y with a declined "Are you sure" leaves sessions intact', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-01-01T00-00-00')
  const { out } = await runAndExit(t, { deleteAllSessions: 'y' }, undefined, 0)
  assert.match(out.join('\n'), /Deletion cancelled\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.deepEqual((await listSessions(dir)).map((s) => s.id), ['2026-01-01T00-00-00'])
})

test('--delete-all-sessions bare with a declined "Are you sure" leaves sessions intact', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-01-02T00-00-00')
  const { out } = await runAndExit(t, { deleteAllSessions: true }, undefined, 0)
  assert.match(out.join('\n'), /Deletion cancelled\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.ok((await listSessions(dir)).some((s) => s.id === '2026-01-02T00-00-00'))
})
