import { rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

// Writes a file atomically: the payload goes to a sibling temp file which is
// renamed over the target, so a crash or ENOSPC mid-write can never leave a
// truncated file behind (rename is atomic on POSIX). The temp file is removed
// again when the write itself fails.
export async function writeFileAtomic(filePath, data, { mode = 0o600 } = {}) {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await writeFile(tmpPath, data, { encoding: 'utf-8', mode })
    await rename(tmpPath, filePath)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}

// Same guarantees as writeFileAtomic for the "a concurrent instance wrote
// this file" case: the payload is staged to a sibling temp file first, so a
// staging failure (e.g. ENOSPC) leaves the original untouched. Then
// `stageBackup` may move the existing target out of the way (returning its
// backup path, or null to continue), and finally the temp is renamed over
// the target. A final-rename failure restores the moved-away target.
export async function swapFileAtomic(filePath, data, { mode = 0o600, stageBackup = null } = {}) {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  let backup
  try {
    await writeFile(tmpPath, data, { encoding: 'utf-8', mode })
    backup = stageBackup ? await stageBackup() : null
    try {
      await rename(tmpPath, filePath)
    } catch (err) {
      if (backup) await rename(backup, filePath).catch(() => {})
      throw err
    }
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}
