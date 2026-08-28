import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  const file = join(dir, 'config.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return file
}

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
    webSearchExplicit: true,
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    ...overrides,
  }
}

test('persistSession saves the session file and merges preferences', async (t) => {
  const { persistSession } = await import('../src/session-setup.js')
  const file = await tempConfig(t)
  await persistSession({ finalState: finalState(), prefs: { budget: 2 }, config: file })

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  assert.equal(files.length, 1)
  const saved = JSON.parse(await readFile(join(sessionsDir, '2026-01-01T00-00-00.json'), 'utf-8'))
  assert.equal(saved.model, 'org/model')
  assert.equal(saved.providerName, 'Provider')
  assert.equal(saved.providerType, 'openrouter')
  assert.equal(saved.messages.length, 3)

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastModel, 'org/model')
  assert.equal(prefs.lastProvider, 'Provider')
  assert.equal(prefs.budget, 2)
  assert.equal(prefs.temperature['org/model'], 1.1)
  assert.equal(prefs.reasoningEffort['org/model'], 'high')
  assert.equal(prefs.webSearch['org/model'], 'auto')
})

test('persistSession does not write webSearch when the session never set it explicitly', async (t) => {
  const { persistSession } = await import('../src/session-setup.js')
  const file = await tempConfig(t)
  const prefs = { webSearch: { 'org/model': 'auto' } }
  // finalState.webSearchExplicit is false (no /web-search, no --web-search);
  // a default/forced 'off' must not overwrite the user's per-model pref.
  await persistSession({ finalState: finalState({ webSearch: 'off', webSearchExplicit: false }), prefs, config: file })

  const saved = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(saved.webSearch['org/model'], 'auto')
})

test('persistSession skips the session file for empty sessions but still saves prefs', async (t) => {
  const { persistSession } = await import('../src/session-setup.js')
  const file = await tempConfig(t)
  await persistSession({ finalState: finalState({ sessionId: '2026-01-02T00-00-00', messages: [{ role: 'system', content: 'x' }] }), prefs: {}, config: file })

  await assert.rejects(readFile(join(tempHome, '.communicator', 'sessions', '2026-01-02T00-00-00.json')))
  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastModel, 'org/model')
})

test('persistSession does not clobber mid-session prefs changes', async (t) => {
  const { syncPreferenceUpdates } = await import('../src/config.js')
  const { persistSession } = await import('../src/session-setup.js')
  const file = await tempConfig(t)
  const prefs = { lastModel: 'org/model' }
  // Mid-session saves keep the shared prefs object current (chat.js
  // savePrefsFile, /smooth, /budget, /web-results).
  syncPreferenceUpdates(prefs, { smoothStreaming: true, smoothSpeed: 500, budget: 2, webResults: 5 })
  await persistSession({ finalState: finalState(), prefs, config: file })

  const saved = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(saved.smoothStreaming, true)
  assert.equal(saved.smoothSpeed, 500)
  assert.equal(saved.budget, 2)
  assert.equal(saved.webResults, 5)
})

test('persistSession survives a failed session save', async (t) => {
  const { persistSession } = await import('../src/session-setup.js')
  const file = await tempConfig(t)
  await persistSession({ finalState: finalState({ sessionId: '' }), prefs: {}, config: file })

  const prefs = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(prefs.lastModel, 'org/model')
})

test('resolveSessionFlags treats an invalid configured budget as unset', async () => {
  const { resolveSessionFlags } = await import('../src/session-setup.js')
  const opts = { budget: undefined, temperature: undefined, reasoningEffort: undefined, webResults: undefined, smoothSpeed: undefined, zdr: false }

  assert.equal(resolveSessionFlags(opts, { budget: 0 }).budget, null)
  assert.equal(resolveSessionFlags(opts, { budget: -1 }).budget, null)
  assert.equal(resolveSessionFlags(opts, { budget: 'abc' }).budget, null)
  assert.equal(resolveSessionFlags(opts, { budget: 2.5 }).budget, 2.5)
  assert.equal(resolveSessionFlags(opts, {}).budget, null)
})

test('resolveSessionFlags lets an explicit CLI budget win over an invalid pref', async () => {
  const { resolveSessionFlags } = await import('../src/session-setup.js')
  const opts = { budget: '3', temperature: undefined, reasoningEffort: undefined, webResults: undefined, smoothSpeed: undefined, zdr: false }
  assert.equal(resolveSessionFlags(opts, { budget: 0 }).budget, 3)
})

test('resolveSessionFlags enables compact thinking from flag or preference', async () => {
  const { resolveSessionFlags } = await import('../src/session-setup.js')
  const opts = { budget: undefined, temperature: undefined, reasoningEffort: undefined, webResults: undefined, smoothSpeed: undefined, zdr: false }
  assert.equal(resolveSessionFlags({ ...opts, compactThinking: true }, {}).compactThinking, true)
  assert.equal(resolveSessionFlags(opts, { compactThinking: true }).compactThinking, true)
  assert.equal(resolveSessionFlags(opts, {}).compactThinking, false)
})
