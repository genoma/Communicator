import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPreferenceUpdates, loadSystemPrompt, getApiKey } from '../src/config.js'
import { CliError } from '../src/errors.js'

test('applyPreferenceUpdates merges per-model maps by spread', () => {
  const prefs = {
    reasoningEffort: { 'model-a': 'high' },
    temperature: { 'model-a': 1.1 },
    webSearch: { 'model-a': true },
  }
  const updated = applyPreferenceUpdates(prefs, {
    modelId: 'model-a',
    reasoningEffort: 'low',
    temperature: 0.5,
    webSearch: false,
  })

  assert.deepEqual(updated.reasoningEffort, { 'model-a': 'low' })
  assert.deepEqual(updated.temperature, { 'model-a': 0.5 })
  assert.deepEqual(updated.webSearch, { 'model-a': false })
})

test('applyPreferenceUpdates keeps other per-model entries untouched', () => {
  const prefs = {
    temperature: { 'model-a': 1.1, 'model-b': 0.2 },
  }
  const updated = applyPreferenceUpdates(prefs, { modelId: 'model-b', temperature: 1.5 })

  assert.deepEqual(updated.temperature, { 'model-a': 1.1, 'model-b': 1.5 })
})

test('applyPreferenceUpdates sets lastModel and lastProvider', () => {
  const updated = applyPreferenceUpdates({}, {
    modelId: 'm',
    lastModel: 'm',
    lastProvider: 'openrouter',
  })

  assert.equal(updated.lastModel, 'm')
  assert.equal(updated.lastProvider, 'openrouter')
})

test('applyPreferenceUpdates skips undefined fields', () => {
  const updated = applyPreferenceUpdates(
    { temperature: { m: 0.5 } },
    { modelId: 'm', lastModel: 'm', reasoningEffort: undefined, temperature: undefined, webSearch: undefined }
  )

  assert.deepEqual(Object.keys(updated).sort(), ['lastModel', 'temperature'])
  assert.deepEqual(updated.temperature, { m: 0.5 })
})

test('applyPreferenceUpdates preserves unrelated prefs keys', () => {
  const prefs = { theme: 'dark', lastModel: 'old', custom: { a: 1 } }
  const updated = applyPreferenceUpdates(prefs, { modelId: 'm', lastModel: 'new' })

  assert.equal(updated.theme, 'dark')
  assert.deepEqual(updated.custom, { a: 1 })
  assert.equal(updated.lastModel, 'new')
})

test('applyPreferenceUpdates returns a shallow copy for empty changes', () => {
  const prefs = { theme: 'dark', temperature: { m: 0.5 } }
  const updated = applyPreferenceUpdates(prefs, {})

  assert.notEqual(updated, prefs)
  assert.deepEqual(updated, prefs)
})

test('applyPreferenceUpdates does not mutate the input prefs', () => {
  const prefs = { temperature: { m: 0.5 } }
  applyPreferenceUpdates(prefs, { modelId: 'm', temperature: 1.0 })
  assert.deepEqual(prefs.temperature, { m: 0.5 })
})

test('applyPreferenceUpdates merges the global smoothStreaming key', () => {
  const prefs = { lastModel: 'm' }
  const updated = applyPreferenceUpdates(prefs, { modelId: 'm', smoothStreaming: false })

  assert.equal(updated.smoothStreaming, false)
  assert.equal(prefs.smoothStreaming, undefined)
})

test('applyPreferenceUpdates skips undefined smoothStreaming', () => {
  const updated = applyPreferenceUpdates({ lastModel: 'm' }, { modelId: 'm', smoothStreaming: undefined })

  assert.deepEqual(Object.keys(updated).sort(), ['lastModel'])
})

test('applyPreferenceUpdates merges the global smoothSpeed key', () => {
  const prefs = { lastModel: 'm' }
  const updated = applyPreferenceUpdates(prefs, { modelId: 'm', smoothSpeed: 'fast' })

  assert.equal(updated.smoothSpeed, 'fast')
  assert.equal(prefs.smoothSpeed, undefined)
})

test('applyPreferenceUpdates skips undefined smoothSpeed', () => {
  const updated = applyPreferenceUpdates({ lastModel: 'm' }, { modelId: 'm', smoothSpeed: undefined })

  assert.deepEqual(Object.keys(updated).sort(), ['lastModel'])
})

test('applyPreferenceUpdates merges global budget, webResults and outputDir keys', () => {
  const updated = applyPreferenceUpdates({ lastModel: 'm' }, {
    modelId: 'm',
    budget: 2.5,
    webResults: 5,
    outputDir: '/tmp/exports',
  })

  assert.equal(updated.budget, 2.5)
  assert.equal(updated.webResults, 5)
  assert.equal(updated.outputDir, '/tmp/exports')
})

test('applyPreferenceUpdates skips undefined budget, webResults and outputDir', () => {
  const updated = applyPreferenceUpdates({ lastModel: 'm' }, {
    modelId: 'm',
    budget: undefined,
    webResults: undefined,
    outputDir: undefined,
  })

  assert.deepEqual(Object.keys(updated).sort(), ['lastModel'])
})

test('applyPreferenceUpdates sets lastImageModel', () => {
  const updated = applyPreferenceUpdates({}, { lastImageModel: 'flux-1-1' })
  assert.equal(updated.lastImageModel, 'flux-1-1')
})

test('applyPreferenceUpdates skips undefined lastImageModel', () => {
  const updated = applyPreferenceUpdates({ lastImageModel: 'flux-1-1' }, { lastImageModel: undefined })
  assert.deepEqual(Object.keys(updated), ['lastImageModel'])
})

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('loadSystemPrompt returns the trimmed content of a custom file', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'prompt.md')
  await writeFile(file, '  You are a pirate.  \n\nSecond line  ')
  assert.equal(await loadSystemPrompt(file), 'You are a pirate.  \n\nSecond line')
})

test('loadSystemPrompt returns null for a missing custom file', async (t) => {
  const dir = await tempDir(t)
  assert.equal(await loadSystemPrompt(join(dir, 'missing.md')), null)
})

test('loadSystemPrompt returns null for an empty or whitespace-only file', async (t) => {
  const dir = await tempDir(t)
  const empty = join(dir, 'empty.md')
  await writeFile(empty, '')
  assert.equal(await loadSystemPrompt(empty), null)
  const blank = join(dir, 'blank.md')
  await writeFile(blank, '   \n \t ')
  assert.equal(await loadSystemPrompt(blank), null)
})

test('getApiKey throws a CliError when the environment variable is unset', () => {
  const previous = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    assert.throws(
      () => getApiKey(),
      (err) => err instanceof CliError && /OPENROUTER_API_KEY environment variable is not set/.test(err.message)
    )
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  }
})

test('getApiKey trims the value from the environment', () => {
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = '  key-123  '
  try {
    assert.equal(getApiKey(), 'key-123')
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  }
})
