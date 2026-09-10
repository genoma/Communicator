import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSession } from '../src/sessions.js'
import { ensureRpgSessionsDir } from '../src/rpg.js'

// The picker import graph must not try to open a real prompt in tests.
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async () => { throw new Error('unexpected picker') },
    select: async () => { throw new Error('unexpected picker') },
    checkbox: async () => { throw new Error('unexpected picker') },
  },
})

const { resolveRpgResume } = await import('../src/commands/rpg-resume.js')

async function storyDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-resume-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function chapterPayload(id, { text, updatedAt } = {}) {
  return {
    model: 'org/model',
    providerName: 'openrouter',
    providerType: 'openrouter',
    reasoningEffort: 'high',
    temperature: 0.9,
    topP: 0.8,
    budget: 5,
    webSearch: 'auto',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    contextLength: 128000,
    supportsReasoning: true,
    reasoningMandatory: false,
    webSearchSupported: true,
    visionSupported: true,
    fileSupported: true,
    imageOutputSupported: false,
    e2ee: false,
    scrapes: 0,
    costSummary: null,
    // A stale stored story dir: resolution must always report the live one.
    rpgDir: '/tmp/stale-story',
    createdAt: `${id}T08:00:00.000Z`,
    updatedAt: updatedAt ?? `${id}T09:00:00.000Z`,
    messages: [
      { role: 'system', content: 'You are Kael.' },
      { role: 'user', content: text ?? `user msg ${id}` },
      { role: 'assistant', content: `assistant msg ${id}` },
    ],
  }
}

test('resolveRpgResume returns null when the RPG dir has no chapters', async (t) => {
  const dir = await storyDir(t)
  assert.equal(await resolveRpgResume(dir), null)
})

test('resolveRpgResume auto-resumes the only chapter and strips the system message', async (t) => {
  const dir = await storyDir(t)
  const sessionsDir = await ensureRpgSessionsDir(dir)
  await saveSession(sessionsDir, '2026-01-01T00-00-00', chapterPayload('2026-01-01'))

  const resumed = await resolveRpgResume(dir)
  assert.equal(resumed.sessionId, '2026-01-01T00-00-00')
  // A stale payload rpgDir never redirects saves: the live dir wins.
  assert.equal(resumed.rpgDir, dir)
  assert.equal(resumed.sessionCreatedAt, '2026-01-01T08:00:00.000Z')
  assert.equal(resumed.sessionUpdatedAt, '2026-01-01T09:00:00.000Z')
  assert.equal(resumed.modelId, 'org/model')
  assert.equal(resumed.temperature, 0.9)
  assert.equal(resumed.topP, 0.8)
  assert.equal(resumed.reasoningEffort, 'high')
  assert.equal(resumed.budget, 5)
  assert.equal(resumed.webSearch, 'auto')
  assert.equal(resumed.e2ee, false)
  assert.equal(resumed.rpgDir, dir)
  assert.deepEqual(resumed.turns, [
    { role: 'user', content: 'user msg 2026-01-01' },
    { role: 'assistant', content: 'assistant msg 2026-01-01' },
  ])
})

test('resolveRpgResume uses the shared picker when more than one chapter exists', async (t) => {
  const dir = await storyDir(t)
  const sessionsDir = await ensureRpgSessionsDir(dir)
  await saveSession(sessionsDir, '2026-01-01T00-00-00', chapterPayload('2026-01-01'))
  await saveSession(sessionsDir, '2026-01-02T00-00-00', chapterPayload('2026-01-02'))

  const picked = []
  const resumed = await resolveRpgResume(dir, {
    interactive: true,
    pick: async (sessions, opts) => {
      picked.push({ ids: sessions.map((s) => s.id), message: opts.message })
      return '2026-01-01T00-00-00'
    },
  })
  assert.deepEqual(picked, [{ ids: ['2026-01-02T00-00-00', '2026-01-01T00-00-00'], message: 'Select a session to resume' }])
  assert.equal(resumed.sessionId, '2026-01-01T00-00-00')
})

test('resolveRpgResume picks the most recent chapter without a TTY', async (t) => {
  const dir = await storyDir(t)
  const sessionsDir = await ensureRpgSessionsDir(dir)
  await saveSession(sessionsDir, '2026-01-01T00-00-00', chapterPayload('2026-01-01', { updatedAt: '2026-01-01T09:00:00.000Z' }))
  await saveSession(sessionsDir, '2026-01-02T00-00-00', chapterPayload('2026-01-02', { updatedAt: '2026-01-02T09:00:00.000Z' }))

  const resumed = await resolveRpgResume(dir, {
    interactive: false,
    pick: async () => { throw new Error('picker must not open without a TTY') },
  })
  assert.equal(resumed.sessionId, '2026-01-02T00-00-00', 'most recent chapter first in activity order')
})
