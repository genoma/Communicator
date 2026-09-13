import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as realFs from 'node:fs/promises'

// sessions.js resolves SESSIONS_DIR from homedir() at module load, so the
// homedir mock must be registered before the src imports below.
const tempHome = await mkdtemp(join(tmpdir(), 'communicator-edge-home-'))

let failBackupRename = false
let failWrites = false
let failMkdir = false

mock.module('node:os', { namedExports: { homedir: () => tempHome } })
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    mkdir: async (...args) => {
      if (failMkdir) {
        const err = new Error('injected mkdir failure')
        err.code = 'EACCES'
        throw err
      }
      return realFs.mkdir(...args)
    },
    writeFile: async (...args) => {
      if (failWrites) {
        const err = new Error('injected write failure')
        err.code = 'ENOSPC'
        throw err
      }
      return realFs.writeFile(...args)
    },
    rename: async (...args) => {
      if (failBackupRename && String(args[1]).includes('.conflict-')) {
        const err = new Error('injected rename failure')
        err.code = 'EPERM'
        throw err
      }
      return realFs.rename(...args)
    },
  },
})

const { deleteAllSessions, deleteSession, deleteSessions, generateSessionId, listSessions, loadSession, persistSessionFile, persistSessionFileTo, resolveSessionInteractive, resolveSessionsInteractive, saveSession } = await import('../src/sessions.js')
const { SIDECAR_FILE } = await import('../src/session-sidecar.js')
const { SESSIONS_DIR } = await import('../src/constants.js')
const { CliError } = await import('../src/errors.js')

after(() => rm(tempHome, { recursive: true, force: true }))

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

test('bare session resolution throws when nothing is saved', async (t) => {
  const dir = await tempDir(t)

  await assert.rejects(
    resolveSessionInteractive(dir, undefined, { interactive: false }),
    (err) => err instanceof CliError && err.message === 'Error: No saved sessions found.'
  )
  await assert.rejects(
    resolveSessionsInteractive(dir, undefined, { interactive: false }),
    (err) => err instanceof CliError && err.message === 'Error: No saved sessions found.'
  )
})

test('bare resolveSessionInteractive hands the listing to the single-select picker', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, '2026-01-01T00-00-00', sessionData())

  const picked = []
  const pick = async (sessions, opts) => {
    picked.push({ ids: sessions.map((s) => s.id), message: opts.message })
    return sessions[0].id
  }

  assert.equal(
    await resolveSessionInteractive(dir, undefined, { pick, message: 'Select a session to resume' }),
    '2026-01-01T00-00-00'
  )
  assert.deepEqual(picked, [{ ids: ['2026-01-01T00-00-00'], message: 'Select a session to resume' }])
})

test('loadSession turns a non-missing read failure into an unreadable-file CliError', async (t) => {
  const dir = await tempDir(t)
  const id = '2026-06-01T00-00-00'
  const filePath = join(dir, `${id}.json`)
  // A directory named like a session file: readFile fails with EISDIR, which
  // is neither ENOENT nor a SyntaxError.
  await mkdir(filePath)

  await assert.rejects(
    loadSession(dir, id),
    (err) => err instanceof CliError && err.message.startsWith(`Error: Could not read session file: ${filePath} (`)
  )
})

test('persistSessionFileTo swallows a failing save', async (t) => {
  const dir = await tempDir(t)

  await assert.doesNotReject(persistSessionFileTo(dir, 'bad id', sessionData()))
  assert.deepEqual(await readdir(dir), [])
})

test('persistSessionFile swallows an uncreatable sessions dir and an invalid id', async () => {
  failMkdir = true
  try {
    await assert.doesNotReject(persistSessionFile('2026-07-01T00-00-00', sessionData()))
  } finally {
    failMkdir = false
  }
  await assert.rejects(stat(join(SESSIONS_DIR, '2026-07-01T00-00-00.json')), { code: 'ENOENT' })

  await assert.doesNotReject(persistSessionFile('bad id', sessionData()))
  assert.deepEqual(await readdir(SESSIONS_DIR), [])
})

test('generateSessionId retries past a claimed id and its -2 sibling', async (t) => {
  const dir = await tempDir(t)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-02-03T04:05:06.789Z') })
  try {
    const base = '2026-02-03T04-05-06'
    await writeFile(join(dir, `${base}.json`), '', { flag: 'wx' })
    await writeFile(join(dir, `${base}-2.json`), '', { flag: 'wx' })

    assert.equal(await generateSessionId(dir), `${base}-3`)
    assert.equal((await stat(join(dir, `${base}-3.json`))).size, 0)
  } finally {
    t.mock.timers.reset()
  }
})

test('listSessions keeps a covered entry whose legacy cost replay fails', async (t) => {
  const dir = await tempDir(t)
  const id = '2026-08-01T00-00-00'
  await saveSession(dir, id, sessionData({ model: 'indexed/model' }))

  // Corrupt the body while keeping the sidecar entry covered, its recorded
  // mtime newer than the file and the sidecar the newest file of all, so the
  // fast path replays the cost from a file it cannot parse.
  await writeFile(join(dir, `${id}.json`), '{ not json')
  const sidecarPath = join(dir, SIDECAR_FILE)
  const index = JSON.parse(await readFile(sidecarPath, 'utf-8'))
  index[id].mtimeMs = Date.now() + 60_000
  await writeFile(sidecarPath, JSON.stringify(index, null, 2) + '\n')

  const sessions = await listSessions(dir)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, id)
  assert.equal(sessions[0].model, 'indexed/model')
  assert.equal(sessions[0].costSummary, null)
})

test('saveSession warns and overwrites when a conflict backup cannot be moved aside', async (t) => {
  const dir = await tempDir(t)
  const id = '2026-04-05T00-00-00'
  await saveSession(dir, id, sessionData({ model: 'first/writer' }))

  const filePath = join(dir, `${id}.json`)
  await writeFile(filePath, JSON.stringify(sessionData({ model: 'other/instance' }), null, 2) + '\n')
  const future = new Date(Date.now() + 5000)
  await utimes(filePath, future, future)

  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  failBackupRename = true
  try {
    await saveSession(dir, id, sessionData({ model: 'this/instance' }))
  } finally {
    failBackupRename = false
  }

  assert.ok(errors.some((e) => e.includes('could not be preserved')))
  assert.equal(JSON.parse(await readFile(filePath, 'utf-8')).model, 'this/instance')
  assert.deepEqual((await readdir(dir)).filter((f) => f.includes('.conflict-')), [])
})

test('deleteSession tolerates a missing sessions directory', async (t) => {
  const base = await tempDir(t)
  const dir = join(base, 'missing')

  await assert.doesNotReject(deleteSession(dir, '2026-01-01T00-00-00'))
  await assert.rejects(stat(dir), { code: 'ENOENT' })
})

test('deleteSessions processes a duplicated id once', async (t) => {
  const dir = await tempDir(t)
  const id = '2026-01-02T00-00-00'
  await saveSession(dir, id, sessionData())

  const { removed, failures } = await deleteSessions(dir, [id, id])
  assert.equal(removed, 1)
  assert.deepEqual(failures, [])
  assert.deepEqual(await listSessions(dir), [])
})

test('deleteSessions reports a failed sidecar rewrite as a failure', async (t) => {
  const dir = await tempDir(t)
  const id = '2026-01-07T00-00-00'
  await saveSession(dir, id, sessionData())

  failWrites = true
  let result
  try {
    result = await deleteSessions(dir, [id])
  } finally {
    failWrites = false
  }

  assert.equal(result.removed, 1)
  assert.deepEqual(result.failures, [SIDECAR_FILE])
  // The session file is gone but its sidecar entry survives the failed
  // rewrite, so the delete stays retryable.
  assert.equal(JSON.parse(await readFile(join(dir, SIDECAR_FILE), 'utf-8'))[id].model, 'test/model')
})

test('deleteAllSessions leaves files with an unusable session stem in place', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, '2026-01-01T00-00-00', sessionData())
  await writeFile(join(dir, 'bad id.json'), '{}')
  await writeFile(join(dir, 'a..b.json'), '{}')

  const { removed, failures } = await deleteAllSessions(dir)

  assert.equal(removed, 1)
  assert.deepEqual(failures, [])
  assert.deepEqual((await readdir(dir)).sort(), ['a..b.json', 'bad id.json'])
})
