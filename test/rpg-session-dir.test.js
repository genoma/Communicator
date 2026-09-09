import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// SESSIONS_DIR is computed at module load from homedir(), so point the OS home
// at a temp dir BEFORE importing the modules that read it. This keeps the
// global sessions dir under tempHome and lets the test prove RPG runs never
// write there.
const tempHome = await mkdtemp(join(tmpdir(), 'communicator-rpg-home-'))
const rpgTmp = await mkdtemp(join(tmpdir(), 'communicator-rpg-story-'))
after(() => Promise.all([
  rm(tempHome, { recursive: true, force: true }),
  rm(rpgTmp, { recursive: true, force: true }),
]))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const { runChatSession } = await import('../src/chat.js')
const { loadSession, createNewSession, saveSession } = await import('../src/sessions.js')
const { ensureRpgSessionsDir, rpgSessionsDir } = await import('../src/rpg.js')

function fakeProvider() {
  const provider = {
    meta: { name: 'openrouter' },
    async chatCompletion() {
      return { content: 'hi', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    },
  }
  return { provider }
}

function fakeRenderer() {
  const render = () => {}
  render.markdown = true
  render.resetMessage = () => {}
  render.flush = () => {}
  return render
}

function baseCtx(provider, overrides = {}) {
  return {
    apiKey: 'test-key',
    model: 'org/model',
    endpointProviderName: 'openrouter',
    reasoningEffort: 'high',
    temperature: 1.1,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    provider,
    systemPrompt: 'You are helpful.',
    // Enough messages for the save path (a <=1-message session is dropped).
    initialMessages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    ...overrides,
  }
}

function makeDeps(overrides = {}) {
  return {
    readInput: async () => ({ cancelled: true }),
    renderer: fakeRenderer,
    stdout: { write() {} },
    exit: () => {},
    savePrefs: async () => {},
    onSignal: () => () => {},
    ...overrides,
  }
}

// Snapshot of the global sessions dir (values after the first call, so a
// directory that never existed stays distinguishable from an empty one).
const globalSessionsDir = join(tempHome, '.communicator', 'sessions')
async function globalSnapshot() {
  return await readdir(globalSessionsDir).catch(() => null)
}

test('rpg session files are written to <rpgdir>/sessions/ and not the global sessions dir', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.method(console, 'error', () => {})

  const globalBefore = await globalSnapshot()
  const { provider } = fakeProvider()
  const story = await mkdtemp(join(rpgTmp, 'story-'))
  const { dir, sessionId } = await createNewSession(await ensureRpgSessionsDir(story))
  assert.equal(dir, rpgSessionsDir(story))

  await runChatSession(baseCtx(provider, { rpgDir: story, rpgCharName: 'Kael', rpgUserName: 'Riv', sessionId, createdAt: new Date().toISOString() }), makeDeps())

  // The session file and sidecar land in the RPG folder's sessions subdir.
  const stored = await readFile(join(dir, `${sessionId}.json`), 'utf8')
  assert.ok(JSON.parse(stored).model === 'org/model')
  assert.ok(JSON.parse(stored).messages.length >= 3)
  const files = await readdir(dir)
  assert.ok(files.includes(`${sessionId}.json`), 'rpg session file missing')
  assert.ok(files.includes('.index.json'), 'rpg sidecar missing')

  // Nothing lands in the global sessions dir — same file set as before (the
  // dir itself must not even be created by an RPG run).
  assert.deepEqual(await globalSnapshot(), globalBefore)

  // Round-trip: the rpg session file is a normal, loadable session payload.
  const loaded = await loadSession(dir, sessionId)
  assert.equal(loaded.model, 'org/model')
  assert.ok(Array.isArray(loaded.messages) && loaded.messages.length >= 3)

  // M4 stores the RPG chapter identity on the payload so any resume path can
  // recover markers and the story directory.
  assert.equal(loaded.rpgDir, story)
  assert.equal(loaded.rpgCharName, 'Kael')
  assert.equal(loaded.rpgUserName, 'Riv')
  assert.equal(loaded.rpgFirstMessage, null)
})

test('rpg session attachments are stored under <rpgdir>/sessions/attachments/', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.method(console, 'error', () => {})

  const story = await mkdtemp(join(rpgTmp, 'story-'))
  const dir = await ensureRpgSessionsDir(story)
  const sessionId = '2026-01-02T11-11-11'
  const pngBytes = Buffer.from('fake-png-content')
  const imageUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
  await saveSession(dir, sessionId, {
    model: 'org/model',
    providerName: 'openrouter',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: imageUrl } }] },
      { role: 'assistant', content: 'an image' },
    ],
  })

  const raw = await readFile(join(dir, `${sessionId}.json`), 'utf8')
  assert.ok(raw.includes('ref://attachments/'))
  assert.ok(!raw.includes('data:image'))
  const blobDir = join(dir, 'attachments', sessionId)
  const blobFiles = await readdir(blobDir)
  assert.equal(blobFiles.length, 1)
  assert.deepEqual(await readFile(join(blobDir, blobFiles[0])), pngBytes)

  const loaded = await loadSession(dir, sessionId)
  assert.equal(loaded.messages[1].content[1].image_url.url, imageUrl)
})

test('/new in rpg mode claims and cleans up its session id inside <rpgdir>/sessions/', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.method(console, 'error', () => {})

  const globalBefore = await globalSnapshot()
  const { provider } = fakeProvider()
  const story = await mkdtemp(join(rpgTmp, 'story-'))
  const dir = await ensureRpgSessionsDir(story)
  const first = await createNewSession(dir)

  // Real newSessionId default (no dep stub), so /new claims its id in the
  // RPG sessions dir. Nothing typed after /new: the new id's empty claim
  // must be cleaned up by the exit save, not left behind.
  const message = { role: 'user', content: 'hi' }
  await runChatSession(baseCtx(provider, {
    rpgDir: story,
    sessionId: first.sessionId,
    createdAt: first.createdAt,
    updatedAt: new Date().toISOString(),
    initialMessages: [{ role: 'system', content: 'system' }, message, { role: 'assistant', content: 'hello' }],
    // /new saves the current session, then /quit exits; the post-/new empty
    // session (system only) must drop its claim.
  }), makeDeps({ readInput: (() => {
    const queue = ['/new', '/quit']
    return async () => {
      if (queue.length === 0) return { cancelled: true }
      return { value: queue.shift() }
    }
  })() }))

  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  assert.deepEqual(files, [`${first.sessionId}.json`], 'expected only the first chapter file; the /new claim leaked')
  assert.deepEqual(await globalSnapshot(), globalBefore)
})
