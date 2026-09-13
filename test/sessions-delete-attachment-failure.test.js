import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realFs from 'node:fs/promises'

let failRmPath = null
mock.module('node:fs/promises', {
  namedExports: {
    access: realFs.access,
    mkdir: realFs.mkdir,
    readdir: realFs.readdir,
    readFile: realFs.readFile,
    rename: realFs.rename,
    rm: async (path, options) => {
      if (failRmPath !== null && path === failRmPath) {
        const err = new Error('injected rm failure')
        err.code = 'EACCES'
        throw err
      }
      return realFs.rm(path, options)
    },
    stat: realFs.stat,
    writeFile: realFs.writeFile,
  },
})

const { deleteSessions, saveSession } = await import('../src/sessions.js')

const ID = '2026-01-05T00-00-00'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  t.after(() => realFs.rm(dir, { recursive: true, force: true }))
  return dir
}

function sessionWithImage() {
  const imageUrl = `data:image/png;base64,${Buffer.from('fake-png-content').toString('base64')}`
  return {
    model: 'test/model',
    providerName: 'TestProvider',
    providerType: 'openrouter',
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: imageUrl } }] },
      { role: 'assistant', content: 'an image' },
    ],
  }
}

test('deleteSessions warns and still drops the sidecar entry when the attachment dir cannot be removed', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, ID, sessionWithImage())
  const attachmentDir = join(dir, 'attachments', ID)
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })
  failRmPath = attachmentDir
  let result
  try {
    result = await deleteSessions(dir, [ID])
  } finally {
    failRmPath = null
  }

  assert.deepEqual(result, { removed: 1, failures: [] })
  assert.deepEqual(errors, [`Warning: could not remove attachments for session ${ID}`])
  // The injected EACCES really hit the attachment branch: the dir survives.
  await assert.doesNotReject(realFs.stat(attachmentDir))
  await assert.rejects(realFs.readFile(join(dir, `${ID}.json`), 'utf-8'), { code: 'ENOENT' })
  const index = JSON.parse(await realFs.readFile(join(dir, '.index.json'), 'utf-8'))
  assert.equal(index[ID], undefined)
})

test('deleteSessions does not warn about attachments when the attachment dir is removed', async (t) => {
  const dir = await tempDir(t)
  await saveSession(dir, ID, sessionWithImage())
  const errors = []
  t.mock.method(console, 'error', (line) => { errors.push(String(line)) })

  const result = await deleteSessions(dir, [ID])

  assert.deepEqual(result, { removed: 1, failures: [] })
  assert.deepEqual(errors.filter((e) => e.includes('could not remove attachments')), [])
  await assert.rejects(realFs.stat(join(dir, 'attachments', ID)), { code: 'ENOENT' })
  const index = JSON.parse(await realFs.readFile(join(dir, '.index.json'), 'utf-8'))
  assert.equal(index[ID], undefined)
})
