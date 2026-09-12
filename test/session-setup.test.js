import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const sessionSelection = { modelId: 'org/model', webSearchSupported: true, isImageModel: false }
mock.module(new URL('../src/model-selection.js', import.meta.url).href, {
  namedExports: {
    selectModelAndEndpoint: async () => sessionSelection,
    selectModelNonInteractive: async () => sessionSelection,
  },
})

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

test('buildSessionContext treats a --web-results run as an explicit web-search choice', async () => {
  const { buildSessionContext } = await import('../src/session-setup.js')
  const ctx = await buildSessionContext({
    provider: { meta: { name: 'openrouter' } },
    apiKey: 'k',
    opts: { model: 'org/model' },
    prefs: {},
    forcedEffort: undefined,
    forcedTemperature: undefined,
    forcedTopP: undefined,
    forcedWebResults: 5,
    zdr: false,
    e2ee: false,
  })

  assert.equal(ctx.webSearch, 'auto')
  assert.equal(ctx.webSearchExplicit, true)
})

test('a Venetian provider rejects --zdr and --web-results against the resolved provider', async () => {
  const { buildSessionContext, resumeSessionContext } = await import('../src/session-setup.js')
  const base = { provider: { meta: { name: 'venice' } }, apiKey: 'k', opts: {}, prefs: {} }
  await assert.rejects(
    buildSessionContext({ ...base, forcedWebResults: 5 }),
    /--web-results is only available with --provider openrouter/
  )
  await assert.rejects(
    buildSessionContext({ ...base, zdr: true }),
    /--zdr is only available with --provider openrouter/
  )
  // A resumed session executes on the provider saved in its file, so the
  // unresolved --provider cannot decide this.
  await assert.rejects(
    resumeSessionContext({ ...base, result: { modelId: 'org/model' }, forcedWebResults: 5 }),
    /--web-results is only available with --provider openrouter/
  )
  await assert.rejects(
    resumeSessionContext({ ...base, result: { modelId: 'org/model' }, zdr: true }),
    /--zdr is only available with --provider openrouter/
  )
})

test('the resolved-provider guard rejects --e2ee on a non-Venice provider', async () => {
  const { buildSessionContext, resumeSessionContext } = await import('../src/session-setup.js')
  const openrouter = { provider: { meta: { name: 'openrouter' } }, apiKey: 'k', opts: {}, prefs: {} }
  await assert.rejects(
    buildSessionContext({ ...openrouter, e2ee: true }),
    /--e2ee is only available with --provider venice/
  )
  await assert.rejects(
    resumeSessionContext({ ...openrouter, result: { modelId: 'org/model' }, e2ee: true }),
    /--e2ee is only available with --provider venice/
  )
  // Venice accepts --e2ee in both directions.
  const venice = { provider: { meta: { name: 'venice' } }, apiKey: 'k', opts: {}, prefs: {} }
  assert.equal((await buildSessionContext({ ...venice, e2ee: true })).webSearch, 'off')
  assert.equal((await resumeSessionContext({ ...venice, result: { modelId: 'org/model' }, e2ee: true })).webSearch, 'off')
})

test('the resolved-provider guard leaves OpenRouter and unflagged runs alone', async () => {
  const { buildSessionContext, resumeSessionContext } = await import('../src/session-setup.js')
  const openrouter = { provider: { meta: { name: 'openrouter' } }, apiKey: 'k', opts: {}, prefs: {} }
  assert.equal((await buildSessionContext({ ...openrouter, forcedWebResults: 5 })).webResults, 5)
  assert.equal((await buildSessionContext({ ...openrouter, zdr: true })).webSearch, 'off')
  const resumed = await resumeSessionContext({
    ...openrouter,
    result: { modelId: 'org/model', webSearchSupported: true },
    forcedWebResults: 5,
  })
  assert.equal(resumed.webSearch, 'auto')
  assert.equal(resumed.webResults, 5)
  const venice = await buildSessionContext({ provider: { meta: { name: 'venice' } }, apiKey: 'k', opts: {}, prefs: {} })
  assert.equal(venice.webSearch, 'off')
  assert.equal(venice.webResults, null)
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

test('resolveSessionFlags ignores a legacy prefs.budget and any opts.budget', async () => {
  const { resolveSessionFlags } = await import('../src/session-setup.js')
  const opts = { temperature: undefined, reasoningEffort: undefined, webResults: undefined, smoothSpeed: undefined, zdr: false }

  // 4.0.0 removed the --budget flag and the standing pref: a fresh session is
  // uncapped whatever the config file or a stale opts key says.
  for (const prefs of [{}, { budget: 0 }, { budget: 2.5 }, { budget: 'abc' }]) {
    assert.equal(resolveSessionFlags(opts, prefs).budget, null)
  }
  assert.equal(resolveSessionFlags({ ...opts, budget: '3' }, { budget: 0 }).budget, null)
})

test('resolveSessionFlags enables compact thinking from flag or preference', async () => {
  const { resolveSessionFlags } = await import('../src/session-setup.js')
  const opts = { budget: undefined, temperature: undefined, reasoningEffort: undefined, webResults: undefined, smoothSpeed: undefined, zdr: false }
  assert.equal(resolveSessionFlags({ ...opts, compactThinking: true }, {}).compactThinking, true)
  assert.equal(resolveSessionFlags(opts, { compactThinking: true }).compactThinking, true)
  assert.equal(resolveSessionFlags(opts, {}).compactThinking, false)
})
