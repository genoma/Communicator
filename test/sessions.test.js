import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listSessions, saveSession, loadSession, generateSessionId } from '../src/sessions.js'

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
