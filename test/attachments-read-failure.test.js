import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realFs from 'node:fs/promises'
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../src/constants.js'

let failRead = false
let fakeSize = null
let fakePayload = null
mock.module('node:fs/promises', {
  namedExports: {
    readFile: async (...args) => {
      if (failRead) {
        const err = new Error('injected read failure')
        err.code = 'EACCES'
        throw err
      }
      if (fakePayload) return fakePayload
      return realFs.readFile(...args)
    },
    stat: async (path, ...rest) => (fakeSize === null ? realFs.stat(path, ...rest) : { size: fakeSize }),
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

test('loadAttachment re-checks the limit on the bytes it actually read', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'grew.png')
  await realFs.writeFile(file, 'x')
  fakeSize = 1
  fakePayload = Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1)
  try {
    await assert.rejects(loadAttachment(file), /image limit is 20 MB/)
  } finally {
    fakeSize = null
    fakePayload = null
  }
})
