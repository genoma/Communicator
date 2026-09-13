import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Only chmod is intercepted, and only while a test asks for it: everything
// else delegates to the real module. The mock is registered before export.js
// is loaded so its top-level `chmod` import binds the stub.
let chmodErrorCode = null
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    chmod: async (...args) => {
      if (chmodErrorCode) {
        const err = new Error(`injected chmod failure (${chmodErrorCode})`)
        err.code = chmodErrorCode
        throw err
      }
      return realFs.chmod(...args)
    },
  },
})

const { exportSession } = await import('../src/export.js')

const ID = '2026-07-30T19-11-45'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-guard-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function filePart(filename, text) {
  return {
    type: 'file',
    file: { filename, file_data: `data:application/octet-stream;base64,${Buffer.from(text).toString('base64')}` },
  }
}

function session(content) {
  return {
    model: 'test/model',
    providerName: 'TestProvider',
    createdAt: '2026-07-30T19:11:45.000Z',
    messages: [{ role: 'user', content }],
  }
}

test('a chmod that only reports "no modes to set" does not fail the export', async (t) => {
  const dir = await tempDir(t)
  t.after(() => { chmodErrorCode = null })
  for (const code of ['EPERM', 'ENOTSUP', 'ENOSYS']) {
    chmodErrorCode = code
    const id = `${ID}-${code}`
    const folder = await exportSession(session([filePart('report.pdf', 'pdf-bytes')]), dir, id)
    assert.equal(folder, join(dir, `session-${id}`))
    await exportSession(session([filePart('report.pdf', 'pdf-bytes')]), dir, id, 'jsonl')

    assert.equal(await readFile(join(folder, 'attachments', 'report.pdf'), 'utf-8'), 'pdf-bytes')
    assert.match(await readFile(join(folder, `session-${id}.md`), 'utf-8'), /^# Chat Session/)
    assert.match(await readFile(join(folder, `session-${id}.jsonl`), 'utf-8'), /^\{/)
  }
})

test('a real chmod permission error still fails the export', async (t) => {
  const dir = await tempDir(t)
  t.after(() => { chmodErrorCode = null })
  chmodErrorCode = 'EACCES'

  await assert.rejects(
    exportSession(session('hi'), dir, ID),
    (err) => {
      assert.equal(err.code, 'EACCES')
      return true
    }
  )
  // The folder is created before the first chmod, but no cleartext export
  // file may be left behind by a failed run.
  assert.deepEqual(await readdir(join(dir, `session-${ID}`)), [])
})

test('strips directory separators out of attachment filenames', async (t) => {
  const dir = await tempDir(t)
  const folder = await exportSession(session([
    filePart('../../etc/passwd', 'traversal-bytes'),
    filePart('a\\b.png', 'windows-bytes'),
  ]), dir, ID)

  const attachments = join(folder, 'attachments')
  assert.deepEqual((await readdir(attachments)).sort(), ['....etcpasswd', 'ab.png'])
  assert.equal(await readFile(join(attachments, '....etcpasswd'), 'utf-8'), 'traversal-bytes')
  assert.equal(await readFile(join(attachments, 'ab.png'), 'utf-8'), 'windows-bytes')
  // Nothing escaped the export folder: the '../../etc/passwd' name must not
  // have created <outDir>/etc/passwd.
  assert.deepEqual(await readdir(dir), [`session-${ID}`])
})

test('strips control characters out of attachment filenames', async (t) => {
  const dir = await tempDir(t)
  const folder = await exportSession(session([
    filePart('evil\u0007\u001b.png', 'bell-esc-bytes'),
    filePart('del\u007f.png', 'del-bytes'),
  ]), dir, ID)

  const attachments = join(folder, 'attachments')
  assert.deepEqual((await readdir(attachments)).sort(), ['del.png', 'evil.png'])
  assert.equal(await readFile(join(attachments, 'evil.png'), 'utf-8'), 'bell-esc-bytes')
  assert.equal(await readFile(join(attachments, 'del.png'), 'utf-8'), 'del-bytes')
})

test('degenerate attachment filenames fall back to the fixed attachment label', async (t) => {
  const dir = await tempDir(t)
  const folder = await exportSession(session([
    filePart('.', 'dot-bytes'),
    filePart('..', 'dotdot-bytes'),
    filePart('\u0007\u001b', 'control-only-bytes'),
  ]), dir, ID)

  const attachments = join(folder, 'attachments')
  assert.deepEqual((await readdir(attachments)).sort(), ['attachment', 'attachment-2', 'attachment-3'])
  assert.equal(await readFile(join(attachments, 'attachment'), 'utf-8'), 'dot-bytes')
  assert.equal(await readFile(join(attachments, 'attachment-2'), 'utf-8'), 'dotdot-bytes')
  assert.equal(await readFile(join(attachments, 'attachment-3'), 'utf-8'), 'control-only-bytes')
})

test('an empty attachment filename lands on a safe fixed name', async (t) => {
  const dir = await tempDir(t)
  const folder = await exportSession(session([filePart('', 'empty-bytes')]), dir, ID)

  // partLabel owns the missing-name fallback, so an empty filename never
  // reaches sanitizeFilename's degenerate branch.
  const attachments = join(folder, 'attachments')
  assert.deepEqual(await readdir(attachments), ['file'])
  assert.equal(await readFile(join(attachments, 'file'), 'utf-8'), 'empty-bytes')
})
