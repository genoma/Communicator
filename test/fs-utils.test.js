import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failFinalRename = false
mock.module('node:fs/promises', {
  namedExports: {
    writeFile: realFs.writeFile,
    readFile: realFs.readFile,
    readdir: realFs.readdir,
    stat: realFs.stat,
    rm: realFs.rm,
    mkdir: realFs.mkdir,
    rename: async (...args) => {
      if (failFinalRename && args[0].includes('.tmp-') && args[1] === join(CURRENT_DIR, 'x.json')) {
        const err = new Error('injected rename failure')
        err.code = 'EIO'
        throw err
      }
      return realFs.rename(...args)
    },
  },
})

let CURRENT_DIR = null

const { swapFileAtomic } = await import('../src/fs-utils.js')

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-fs-utils-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('swapFileAtomic writes the payload when no backup is staged', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'x.json')
  await swapFileAtomic(file, 'new')
  assert.equal(await readFile(file, 'utf-8'), 'new')
})

test('swapFileAtomic stages the payload before moving the target aside', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'x.json')
  await writeFile(file, 'old')
  let tmpSeenAtStage = false
  const stageBackup = async () => {
    // At stage time the temp payload must already exist on disk (the old
    // file is only moved away after staging succeeded).
    tmpSeenAtStage = (await readdir(dir)).some((f) => f.includes('.tmp-'))
    const backup = `${file}.conflict`
    await rename(file, backup)
    return backup
  }
  await swapFileAtomic(file, 'new', { stageBackup })
  assert.equal(tmpSeenAtStage, true)
  assert.equal(await readFile(file, 'utf-8'), 'new')
  // The backup keeps the previous version.
  assert.equal(await readFile(`${file}.conflict`, 'utf-8'), 'old')
})

test('swapFileAtomic restores the backup when the final rename fails', async (t) => {
  const dir = await tempDir(t)
  CURRENT_DIR = dir
  failFinalRename = true
  t.after(() => {
    failFinalRename = false
  })
  const file = join(dir, 'x.json')
  await writeFile(file, 'old')
  let hadStage = false
  const stageBackup = async () => {
    hadStage = true
    const backup = `${file}.conflict`
    await rename(file, backup)
    return backup
  }
  await assert.rejects(
    swapFileAtomic(file, 'new', { stageBackup }),
    (err) => {
      assert.equal(hadStage, true)
      assert.equal(err.code, 'EIO')
      return true
    }
  )
  // The live session is restored from the backup.
  assert.equal(await readFile(file, 'utf-8'), 'old')
})
