import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The homedir mock must be registered before chat.js/sessions.js resolve
// SESSIONS_DIR at module load.
const tempHome = await mkdtemp(join(tmpdir(), 'communicator-chat-home-'))
mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const { runChatSession } = await import('../src/chat.js')
const { ensureSessionsDir, generateSessionId } = await import('../src/sessions.js')

after(() => rm(tempHome, { recursive: true, force: true }))

function harness() {
  const saveCalls = []
  const deps = {
    readInput: async () => ({ cancelled: true }),
    renderer: () => {
      const render = () => {}
      render.markdown = false
      render.flush = () => {}
      return render
    },
    stdout: { write() {} },
    exit: () => {},
    saveSession: async (id, payload) => saveCalls.push({ id, payload }),
    savePrefs: async () => {},
    onSignal: () => () => {},
  }
  return { deps, saveCalls }
}

function provider() {
  return { meta: { name: 'openrouter' } }
}

test('quitting without sending a message removes the empty session claim', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})

  const dir = await ensureSessionsDir()
  const sessionId = await generateSessionId(dir)
  assert.ok((await readdir(dir)).includes(`${sessionId}.json`), 'claim file must exist')

  const { deps, saveCalls } = harness()
  await runChatSession({
    apiKey: 'key',
    model: 'org/model',
    endpointProviderName: 'Provider',
    provider: provider(),
    sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
  }, deps)

  assert.ok(!(await readdir(dir)).includes(`${sessionId}.json`), 'empty claim file must be removed')
  assert.equal(saveCalls.length, 0)
})

test('a session with real messages still saves on quit', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})

  const dir = await ensureSessionsDir()
  const sessionId = await generateSessionId(dir)
  const { deps, saveCalls } = harness()

  await runChatSession({
    apiKey: 'key',
    model: 'org/model',
    endpointProviderName: 'Provider',
    provider: provider(),
    sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    initialMessages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  }, deps)

  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].id, sessionId)
})
