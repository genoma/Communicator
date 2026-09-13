import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realFs from 'node:fs/promises'

// The serialization test stalls the first save's payload write: a save that
// goes through the per-id chain cannot reach its own file stat until that
// write is released, while an un-serialized one reaches it immediately. Both
// wrappers pass through untouched unless a race is armed.
const race = {
  active: false,
  filePath: null,
  tmpPrefix: null,
  holding: false,
  sawStatWhileHeld: false,
  firstWrite: null,
  heldStat: null,
  release: null,
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    stat: async (path, ...rest) => {
      if (race.active && race.holding && String(path) === race.filePath) {
        race.sawStatWhileHeld = true
        race.heldStat.resolve()
      }
      return realFs.stat(path, ...rest)
    },
    writeFile: async (path, ...rest) => {
      if (race.active && race.firstWrite && String(path).startsWith(race.tmpPrefix)) {
        const started = race.firstWrite
        race.firstWrite = null
        race.holding = true
        started.resolve()
        await race.release.promise
        race.holding = false
      }
      return realFs.writeFile(path, ...rest)
    },
  },
})

const { ensureSessionsDir, saveSession } = await import('../src/sessions.js')
const { savePreferences } = await import('../src/config.js')
const { attachmentDirFor, externalizeAttachments, REF_PREFIX } = await import('../src/attachment-store.js')

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  t.after(() => realFs.rm(dir, { recursive: true, force: true }))
  return dir
}

function sessionData(overrides = {}) {
  return {
    model: 'test/model',
    providerName: 'TestProvider',
    providerType: 'openrouter',
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ],
    ...overrides,
  }
}

test('a concurrent save of the same id waits for the in-flight save (no self-conflict backup, no warning)', async (t) => {
  const dir = await tempDir(t)
  const id = '2026-01-01T00-00-00'
  await saveSession(dir, id, sessionData({ model: 'baseline' }))

  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  race.active = true
  race.filePath = join(dir, `${id}.json`)
  race.tmpPrefix = join(dir, `.${id}.json.tmp-`)
  race.firstWrite = deferred()
  race.heldStat = deferred()
  race.release = deferred()

  const interrupt = saveSession(dir, id, sessionData({ model: 'interrupt' }))
  const exit = saveSession(dir, id, sessionData({ model: 'exit' }))

  await race.firstWrite.promise
  // The first save is stalled before its payload reaches disk. A chained
  // second save cannot start yet; an un-chained one stats the session file
  // straight away, which is what this wait detects.
  await Promise.race([race.heldStat.promise, delay(150)])
  const overlapped = race.sawStatWhileHeld
  race.release.resolve()
  await Promise.all([interrupt, exit])
  race.active = false

  assert.equal(overlapped, false, 'the second save started while the first was still writing')
  assert.deepEqual(errors, [])
  const entries = await realFs.readdir(dir)
  assert.equal(entries.filter((f) => f.includes('.conflict-')).length, 0)
  assert.deepEqual(entries.filter((f) => f.endsWith('.json') && !f.startsWith('.')), [`${id}.json`])
  assert.equal(JSON.parse(await realFs.readFile(race.filePath, 'utf-8')).model, 'exit')
})

test('concurrent saves preserve one foreign version once, not each other', async (t) => {
  const dir = await tempDir(t)
  const id = '2026-01-02T00-00-00'
  await saveSession(dir, id, sessionData({ model: 'baseline' }))

  const filePath = join(dir, `${id}.json`)
  await realFs.writeFile(filePath, JSON.stringify(sessionData({ model: 'other/instance' }), null, 2) + '\n')
  const future = new Date(Date.now() + 5000)
  await realFs.utimes(filePath, future, future)

  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  await Promise.all([
    saveSession(dir, id, sessionData({ model: 'interrupt' })),
    saveSession(dir, id, sessionData({ model: 'exit' })),
  ])

  assert.equal(errors.filter((line) => line.includes('changed on disk')).length, 1)
  const entries = await realFs.readdir(dir)
  assert.equal(entries.filter((f) => f.includes('.conflict-')).length, 1)
  assert.equal(JSON.parse(await realFs.readFile(filePath, 'utf-8')).model, 'exit')
})

test('prefs, sidecar, sessions dir and attachment blobs stay private', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await tempDir(t)
  const modeOf = async (path) => (await realFs.stat(path)).mode & 0o777

  const prefsFile = join(dir, 'prefs.json')
  await savePreferences({ lastModel: 'test/model' }, prefsFile)
  assert.equal(await modeOf(prefsFile), 0o600, 'prefs file mode')

  const id = '2026-01-03T00-00-00'
  await saveSession(dir, id, sessionData())
  assert.equal(await modeOf(join(dir, '.index.json')), 0o600, 'sidecar mode')

  assert.equal(await modeOf(await ensureSessionsDir()), 0o700, 'sessions dir mode')

  const imageUrl = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
  const externalized = await externalizeAttachments([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] },
  ], attachmentDirFor(dir, id))
  const ref = externalized[1].content[0].image_url.url
  const blobDir = attachmentDirFor(dir, id)
  assert.equal(await modeOf(blobDir), 0o700, 'attachment dir mode')
  assert.equal(await modeOf(join(blobDir, ref.slice(REF_PREFIX.length))), 0o600, 'attachment blob mode')
})
