import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import * as realFs from 'node:fs/promises'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

const failPaths = new Set()
const tempOf = (p) => join(dirname(p), `.${basename(p)}.tmp-`)
mock.module('node:os', { namedExports: { homedir: () => tempHome } })
mock.module('node:fs/promises', {
  namedExports: {
    access: realFs.access,
    copyFile: realFs.copyFile,
    mkdir: realFs.mkdir,
    readdir: realFs.readdir,
    readFile: realFs.readFile,
    rename: realFs.rename,
    rm: realFs.rm,
    stat: realFs.stat,
    writeFile: async (...args) => {
      // Atomic writes land in a sibling temp file first; inject the failure
      // on the temp write of any target in failPaths.
      const target = String(args[0])
      if ([...failPaths].some((p) => target.startsWith(tempOf(p)))) {
        const err = new Error('injected failure')
        err.code = 'EACCES'
        throw err
      }
      return realFs.writeFile(...args)
    },
  },
})

const { persistSession } = await import('../src/session-setup.js')
const { finalizeImageSession } = await import('../src/commands/image-gen.js')

function finalState(overrides = {}) {
  return {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ],
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelId: 'org/model',
    endpointProviderName: 'Provider',
    providerType: 'openrouter',
    reasoningEffort: 'high',
    temperature: 1.1,
    budget: 5,
    webSearch: 'auto',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    ...overrides,
  }
}

test('persistSession warns and keeps the session save when the prefs write fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  const file = join(dir, 'config.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  failPaths.add(file)
  try {
    await persistSession({ finalState: finalState(), prefs: { budget: 2 }, config: file })
  } finally {
    failPaths.delete(file)
  }
  assert.ok(errors.some((e) => e.includes('could not save preferences')))

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const files = (await realFs.readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  assert.equal(files.length, 1)
  const saved = JSON.parse(await realFs.readFile(join(sessionsDir, '2026-01-01T00-00-00.json'), 'utf-8'))
  assert.equal(saved.model, 'org/model')
  assert.equal(saved.messages.length, 3)
})

test('finalizeImageSession warns instead of throwing when the prefs write fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  const file = join(dir, 'config.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const warnings = []
  t.mock.method(console, 'warn', (line) => { warnings.push(String(line)) })
  const outcome = {
    modelId: 'flux-1-1',
    endpointProviderName: 'venice',
    pricing: null,
    savedPaths: [],
  }
  failPaths.add(file)
  try {
    await finalizeImageSession({
      prefs: {},
      opts: {},
      config: file,
      sessionId: '2026-01-02T00-00-00',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'a red cat' },
        { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } }] },
      ],
      outcome,
      createdAt: '2026-01-02T00:00:00.000Z',
      providerName: 'venice',
    })
  } finally {
    failPaths.delete(file)
  }
  assert.ok(warnings.some((w) => w.includes('could not save preferences')))

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const saved = JSON.parse(await realFs.readFile(join(sessionsDir, '2026-01-02T00-00-00.json'), 'utf-8'))
  assert.equal(saved.model, 'flux-1-1')
})
