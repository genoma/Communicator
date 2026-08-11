import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realFs from 'node:fs/promises'

let failCode = null
mock.module('node:fs/promises', {
  namedExports: {
    access: realFs.access,
    mkdir: realFs.mkdir,
    readdir: realFs.readdir,
    readFile: realFs.readFile,
    rename: realFs.rename,
    rm: realFs.rm,
    stat: realFs.stat,
    writeFile: async (...args) => {
      if (failCode !== null) {
        const err = new Error('injected failure')
        err.code = failCode
        throw err
      }
      return realFs.writeFile(...args)
    },
  },
})

const { saveSession } = await import('../src/sessions.js')

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
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ],
    ...overrides,
  }
}

test('saveSession warns on disk-full writes and does not throw', async (t) => {
  const dir = await tempDir(t)
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  failCode = 'ENOSPC'
  try {
    await saveSession(dir, '2026-01-01T00-00-00', sessionData())
  } finally {
    failCode = null
  }
  assert.ok(errors.some((e) => e.includes('disk full')))
})

test('saveSession warns on other write failures and does not throw', async (t) => {
  const dir = await tempDir(t)
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  failCode = 'EACCES'
  try {
    await saveSession(dir, '2026-01-01T00-00-00', sessionData())
  } finally {
    failCode = null
  }
  assert.ok(errors.some((e) => e.includes('could not save session')))
})

test('a failed session save leaves the previous file intact and no temp file behind', async (t) => {
  const dir = await tempDir(t)
  t.mock.method(console, 'error', () => {})
  await saveSession(dir, '2026-01-01T00-00-00', sessionData())
  const original = await realFs.readFile(join(dir, '2026-01-01T00-00-00.json'), 'utf-8')

  failCode = 'ENOSPC'
  try {
    await saveSession(dir, '2026-01-01T00-00-00', sessionData({ title: 'changed title' }))
  } finally {
    failCode = null
  }

  const after = await realFs.readFile(join(dir, '2026-01-01T00-00-00.json'), 'utf-8')
  assert.equal(after, original)
  const leftovers = (await realFs.readdir(dir)).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})
