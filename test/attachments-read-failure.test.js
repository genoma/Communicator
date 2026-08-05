import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realFs from 'node:fs/promises'

let failRead = false
mock.module('node:fs/promises', {
  exports: {
    readFile: async (...args) => {
      if (failRead) {
        const err = new Error('injected read failure')
        err.code = 'EACCES'
        throw err
      }
      return realFs.readFile(...args)
    },
    stat: realFs.stat,
    mkdir: realFs.mkdir,
  },
})

const { loadAttachment } = await import('../src/attachments.js')

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('loadAttachment reports an unreadable file as Cannot read attachment', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'locked.png')
  await realFs.writeFile(file, 'x')
  failRead = true
  try {
    await assert.rejects(loadAttachment(file), /Cannot read attachment/)
  } finally {
    failRead = false
  }
})
