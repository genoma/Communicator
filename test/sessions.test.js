import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteSession, formatSessionItem, generateTitle, listSessions, saveSession, loadSession, generateSessionId, buildSessionPayload } from '../src/sessions.js'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function sessionData(overrides = {}) {
  return {
    model: 'test/model',
    providerName: 'TestProvider',
    providerType: 'openrouter',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ],
    ...overrides,
  }
}

test('saveSession writes file and sidecar entry', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, '2026-01-01T00-00-00', sessionData())

  const saved = JSON.parse(await readFile(join(dir, '2026-01-01T00-00-00.json'), 'utf-8'))
  assert.equal(saved.messages.length, 3)

  const index = JSON.parse(await readFile(join(dir, '.index.json'), 'utf-8'))
  const entry = index['2026-01-01T00-00-00']
  assert.equal(entry.model, 'test/model')
  assert.equal(entry.messageCount, 3)
  assert.equal(entry.preview, 'First question')
})

test('saveSession skips sessions with no user messages', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, 'empty', sessionData({ messages: [{ role: 'system', content: 'x' }] }))
  await assert.rejects(readFile(join(dir, 'empty.json')))
  await assert.rejects(readFile(join(dir, '.index.json')))
})

test('listSessions reads from sidecar without parsing session bodies', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, '2026-01-01T00-00-00', sessionData({ model: 'one' }))
  await saveSession(dir, '2026-01-02T00-00-00', sessionData({ model: 'two' }))

  const sessions = await listSessions(dir)
  assert.deepEqual(sessions.map((s) => s.id), ['2026-01-02T00-00-00', '2026-01-01T00-00-00'])
  assert.equal(sessions[0].model, 'two')
  assert.equal(sessions[0].preview, 'First question')
})

test('rebuilds sidecar from legacy session files when missing', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'legacy-1.json'), JSON.stringify(sessionData({ model: 'legacy' })))
  await writeFile(join(dir, '.hidden.json'), JSON.stringify({ not: 'a session' }))

  const sessions = await listSessions(dir)
  assert.deepEqual(sessions.map((s) => s.id), ['legacy-1'])
  assert.equal(sessions[0].model, 'legacy')

  const index = JSON.parse(await readFile(join(dir, '.index.json'), 'utf-8'))
  assert.ok(index['legacy-1'])
})

test('skips corrupt session files and filters empty sessions', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'corrupt.json'), '{ not json')
  await writeFile(join(dir, 'empty.json'), JSON.stringify(sessionData({ messages: [{ role: 'system', content: 'x' }] })))

  const sessions = await listSessions(dir)
  assert.deepEqual(sessions, [])
})

test('rebuilds sidecar when a session file is newer than the sidecar', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, '2026-01-01T00-00-00', sessionData({ model: 'old' }))
  await saveSession(dir, '2026-01-02T00-00-00', sessionData({ model: 'new' }))

  // simulate a legacy session file added after the sidecar was written
  await new Promise((r) => setTimeout(r, 10))
  await writeFile(join(dir, '2026-01-03T00-00-00.json'), JSON.stringify(sessionData({ model: 'late' })))

  const sessions = await listSessions(dir)
  assert.deepEqual(sessions.map((s) => s.model), ['late', 'new', 'old'])
})

test('loadSession returns full data for a known id', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, '2026-01-01T00-00-00', sessionData())
  const data = await loadSession(dir, '2026-01-01T00-00-00')
  assert.equal(data.model, 'test/model')
  assert.equal(data.messages.length, 3)
})

test('generateSessionId produces unique ids', async (t) => {
  const dir = await tempDir(t)
  const id = await generateSessionId(dir)
  await saveSession(dir, id, sessionData())
  const id2 = await generateSessionId(dir)
  assert.notEqual(id, id2)
})

test('missing dir yields empty listing', async (t) => {
  const dir = join(await mkdtemp(join(tmpdir(), 'communicator-test-')), 'nested', 'missing')
  await mkdir(dir, { recursive: true })
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sessions = await listSessions(dir)
  assert.deepEqual(sessions, [])
})

test('generateTitle collapses whitespace and truncates to 50 chars', () => {
  assert.equal(generateTitle([{ role: 'system' }, { role: 'user', content: '  Hello\n   world  ' }]), 'Hello world')
  const long = 'a'.repeat(80)
  const titled = generateTitle([{ role: 'user', content: long }])
  assert.equal(titled, 'a'.repeat(50) + '...')
  assert.equal(generateTitle([{ role: 'system', content: 'x' }]), '')
  assert.equal(generateTitle([]), '')
  assert.equal(generateTitle([{ role: 'user', content: '   \n  ' }]), '')
})

test('generateTitle reads text parts from attachment messages', () => {
  const messages = [
    { role: 'system', content: 'x' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is  this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      ],
    },
  ]
  assert.equal(generateTitle(messages), 'What is this')
})

test('sidecar preview reads text parts from attachment messages', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'parts.json'), JSON.stringify(sessionData({
    messages: [
      { role: 'system', content: 'x' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this chart' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
        ],
      },
    ],
  })))

  const sessions = await listSessions(dir)
  assert.equal(sessions[0].preview, 'Analyze this chart')
})

test('sidecar stores title and formatSessionItem prefers it over preview', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, '2026-01-01T00-00-00', sessionData({ title: 'My custom title' }))

  const index = JSON.parse(await readFile(join(dir, '.index.json'), 'utf-8'))
  assert.equal(index['2026-01-01T00-00-00'].title, 'My custom title')

  const sessions = await listSessions(dir)
  assert.equal(sessions[0].title, 'My custom title')
  assert.match(formatSessionItem(sessions[0]).line, /"My custom title"/)
})

test('legacy session files without title fall back to empty string', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'legacy-1.json'), JSON.stringify(sessionData()))
  const sessions = await listSessions(dir)
  assert.equal(sessions[0].title, '')
  assert.match(formatSessionItem(sessions[0]).line, /"First question"/)
})

test('deleteSession removes the session file and sidecar entry', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, '2026-01-01T00-00-00', sessionData())
  await saveSession(dir, '2026-01-02T00-00-00', sessionData())

  await deleteSession(dir, '2026-01-01T00-00-00')

  await assert.rejects(readFile(join(dir, '2026-01-01T00-00-00.json')))
  const index = JSON.parse(await readFile(join(dir, '.index.json'), 'utf-8'))
  assert.deepEqual(Object.keys(index), ['2026-01-02T00-00-00'])
  const sessions = await listSessions(dir)
  assert.deepEqual(sessions.map((s) => s.id), ['2026-01-02T00-00-00'])
})

test('deleteSession tolerates missing files and unknown ids', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, '2026-01-01T00-00-00', sessionData())
  await deleteSession(dir, '2026-01-01T00-00-00')
  await deleteSession(dir, '2026-01-01T00-00-00')
  await deleteSession(dir, 'never-existed')
  const sessions = await listSessions(dir)
  assert.deepEqual(sessions, [])
})

test('buildSessionPayload returns the full save object shape', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hi' },
  ]
  const payload = buildSessionPayload({
    messages,
    modelId: 'org/model',
    endpointProviderName: 'Provider',
    providerType: 'openrouter',
    reasoningEffort: 'high',
    temperature: 1.1,
    budget: 5,
    webSearch: 'auto',
    webResults: 3,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    createdAt: '2026-01-01T00:00:00.000Z',
  })

  assert.deepEqual(Object.keys(payload).sort(), [
    'budget',
    'createdAt',
    'messages',
    'model',
    'pricing',
    'providerName',
    'providerType',
    'reasoningEffort',
    'temperature',
    'title',
    'updatedAt',
    'webResults',
    'webSearch',
  ])
  assert.equal(payload.model, 'org/model')
  assert.equal(payload.providerName, 'Provider')
  assert.equal(payload.providerType, 'openrouter')
  assert.equal(payload.reasoningEffort, 'high')
  assert.equal(payload.temperature, 1.1)
  assert.equal(payload.budget, 5)
  assert.equal(payload.webSearch, 'auto')
  assert.equal(payload.webResults, 3)
  assert.deepEqual(payload.pricing, { prompt: 0.000001, completion: 0.000002 })
  assert.equal(payload.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(payload.title, 'Hi')
  assert.deepEqual(payload.messages, messages)
  assert.ok(payload.updatedAt)
})

test('buildSessionPayload truncates the title to 50 chars plus ellipsis', () => {
  const long = 'a'.repeat(80)
  const payload = buildSessionPayload({
    messages: [{ role: 'user', content: long }],
    modelId: 'm',
    endpointProviderName: null,
    providerType: 'openrouter',
    reasoningEffort: null,
    temperature: 0.7,
    budget: null,
    webSearch: false,
    webResults: null,
    pricing: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(payload.title, 'a'.repeat(50) + '...')
})

test('buildSessionPayload passes nulls through for optional fields', () => {
  const payload = buildSessionPayload({
    messages: [],
    modelId: 'm',
    endpointProviderName: null,
    providerType: 'openrouter',
    reasoningEffort: null,
    temperature: 0.7,
    budget: null,
    webSearch: false,
    webResults: null,
    pricing: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(payload.reasoningEffort, null)
  assert.equal(payload.budget, null)
  assert.equal(payload.webResults, null)
  assert.equal(payload.pricing, null)
  assert.equal(payload.providerName, null)
  assert.equal(payload.title, '')
})

test('buildSessionPayload fills createdAt when missing and defaults undefined fields to null', () => {
  const payload = buildSessionPayload({
    messages: [{ role: 'user', content: 'Hi' }],
    modelId: 'm',
    endpointProviderName: 'P',
    providerType: 'venice',
    temperature: 0.7,
    webSearch: false,
  })
  assert.ok(payload.createdAt)
  assert.equal(payload.reasoningEffort, null)
  assert.equal(payload.budget, null)
  assert.equal(payload.webResults, null)
  assert.equal(payload.pricing, null)
})

test('buildSessionPayload output round-trips through saveSession and loadSession', async (t) => {
  const dir = await tempDir(t)
  const payload = buildSessionPayload({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ],
    modelId: 'test/model',
    endpointProviderName: 'TestProvider',
    providerType: 'openrouter',
    reasoningEffort: 'medium',
    temperature: 0.7,
    budget: 2.5,
    webSearch: 'always',
    webResults: 5,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    createdAt: '2026-01-01T00:00:00.000Z',
  })

  await saveSession(dir, '2026-01-01T00-00-00', payload)
  const loaded = await loadSession(dir, '2026-01-01T00-00-00')
  assert.equal(loaded.model, 'test/model')
  assert.equal(loaded.providerName, 'TestProvider')
  assert.equal(loaded.reasoningEffort, 'medium')
  assert.equal(loaded.budget, 2.5)
  assert.equal(loaded.webSearch, 'always')
  assert.equal(loaded.webResults, 5)
  assert.deepEqual(loaded.pricing, { prompt: 0.000001, completion: 0.000002 })
  assert.equal(loaded.title, 'First question')
  assert.equal(loaded.messages.length, 3)

  const sessions = await listSessions(dir)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].model, 'test/model')
  assert.equal(sessions[0].messageCount, 3)
  assert.equal(sessions[0].preview, 'First question')
})
