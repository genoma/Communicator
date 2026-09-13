import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realFs from 'node:fs/promises'

// Injected fs failure: `op` throws for every path containing `match`, so a
// test can break exactly one sidecar operation and observe the fallback.
const failure = { op: null, match: null }

function injected(op, path) {
  if (failure.op !== op || !String(path).includes(failure.match)) return null
  const err = new Error('injected failure')
  err.code = 'EACCES'
  return err
}

mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    readFile: async (path, ...rest) => {
      const err = injected('readFile', path)
      if (err) throw err
      return realFs.readFile(path, ...rest)
    },
    stat: async (path, ...rest) => {
      const err = injected('stat', path)
      if (err) throw err
      return realFs.stat(path, ...rest)
    },
    writeFile: async (path, ...rest) => {
      const err = injected('writeFile', path)
      if (err) throw err
      return realFs.writeFile(path, ...rest)
    },
  },
})

const { readSidecar, writeSidecar, sessionFileMtimes, sidecarMtimeMs, updateSidecar, dropSidecarEntry, reconcileSidecar } = await import('../src/session-sidecar.js')
const { listSessions } = await import('../src/sessions.js')

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-sidecar-test-'))
  t.after(() => realFs.rm(dir, { recursive: true, force: true }))
  return dir
}

async function withFailure(op, match, fn) {
  failure.op = op
  failure.match = match
  try {
    return await fn()
  } finally {
    failure.op = null
    failure.match = null
  }
}

function sessionFile(overrides = {}) {
  return JSON.stringify({
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
  }, null, 2) + '\n'
}

test('readSidecar treats invalid JSON as an absent index', async (t) => {
  const dir = await tempDir(t)
  await realFs.writeFile(join(dir, '.index.json'), '{ not json\n')
  assert.equal(await readSidecar(dir), null)
})

test('listSessions rebuilds a corrupt index from the session files', async (t) => {
  const dir = await tempDir(t)
  const id = '2026-01-01T00-00-00'
  await realFs.writeFile(join(dir, `${id}.json`), sessionFile())
  await realFs.writeFile(join(dir, '.index.json'), '{ not json\n')

  const sessions = await listSessions(dir)

  assert.deepEqual(sessions.map((s) => s.id), [id])
  const rebuilt = JSON.parse(await realFs.readFile(join(dir, '.index.json'), 'utf-8'))
  assert.equal(rebuilt[id].model, 'test/model')
  assert.equal(rebuilt[id].messageCount, 3)
})

test('writeSidecar swallows a failed sidecar write', async (t) => {
  const dir = await tempDir(t)
  await withFailure('writeFile', '.index.json', () => writeSidecar(dir, { sess: { model: 'm' } }))
  await assert.rejects(realFs.readFile(join(dir, '.index.json')), { code: 'ENOENT' })
})

test('sessionFileMtimes maps an unstattable session file to null', async (t) => {
  const dir = await tempDir(t)
  await realFs.writeFile(join(dir, 'present.json'), '{}')

  const mtimes = await withFailure('stat', 'vanished.json', () => sessionFileMtimes(dir, ['vanished.json', 'present.json']))

  assert.equal(mtimes.get('vanished.json'), null)
  assert.equal(typeof mtimes.get('present.json'), 'number')
})

test('sidecarMtimeMs returns null when the sidecar cannot be statted', async (t) => {
  const dir = await tempDir(t)
  await realFs.writeFile(join(dir, '.index.json'), '{}\n')
  assert.equal(await withFailure('stat', '.index.json', () => sidecarMtimeMs(dir)), null)
})

test('updateSidecar swallows a failed write and a malformed index', async (t) => {
  const dir = await tempDir(t)
  const original = '{\n  "keep": {\n    "model": "m"\n  }\n}\n'
  await realFs.writeFile(join(dir, '.index.json'), original)
  await withFailure('writeFile', '.index.json', () => updateSidecar(dir, { id: 'new', model: 'm2' }))
  assert.equal(await realFs.readFile(join(dir, '.index.json'), 'utf-8'), original)

  // A JSON scalar is not assignable-to: the entry write throws, and that
  // failure must stay swallowed too.
  await realFs.writeFile(join(dir, '.index.json'), '42\n')
  await updateSidecar(dir, { id: 'new', model: 'm2' })
  assert.equal(await realFs.readFile(join(dir, '.index.json'), 'utf-8'), '42\n')
})

test('dropSidecarEntry swallows a failed write and a malformed index', async (t) => {
  const dir = await tempDir(t)
  const original = '{\n  "sess": {\n    "model": "m"\n  }\n}\n'
  await realFs.writeFile(join(dir, '.index.json'), original)
  await withFailure('writeFile', '.index.json', () => dropSidecarEntry(dir, 'sess'))
  assert.equal(await realFs.readFile(join(dir, '.index.json'), 'utf-8'), original)

  // A JSON string index boxes into a String object whose index properties
  // cannot be deleted, so the drop throws before any write.
  await realFs.writeFile(join(dir, '.index.json'), '"abc"\n')
  await dropSidecarEntry(dir, '0')
  assert.equal(await realFs.readFile(join(dir, '.index.json'), 'utf-8'), '"abc"\n')
})

test('reconcileSidecar swallows a failed write and a malformed operation list', async (t) => {
  const dir = await tempDir(t)
  const original = '{\n  "sess": {\n    "model": "m"\n  }\n}\n'
  await realFs.writeFile(join(dir, '.index.json'), original)
  await withFailure('writeFile', '.index.json', () => reconcileSidecar(dir, { add: [{ id: 'new', model: 'm2' }], remove: ['ghost'] }))
  assert.equal(await realFs.readFile(join(dir, '.index.json'), 'utf-8'), original)

  // A non-iterable remove list throws before anything is written.
  await reconcileSidecar(dir, { remove: null, add: [{ id: 'new', model: 'm2' }] })
  assert.equal(await realFs.readFile(join(dir, '.index.json'), 'utf-8'), original)
})
