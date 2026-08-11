import { rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// Writes a file atomically: the payload goes to a sibling temp file which is
// renamed over the target, so a crash or ENOSPC mid-write can never leave a
// truncated file behind (rename is atomic on POSIX). The temp file is removed
// again when the write itself fails.
export async function writeFileAtomic(filePath, data, { mode = 0o600 } = {}) {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}`)
  try {
    await writeFile(tmpPath, data, { encoding: 'utf-8', mode })
    await rename(tmpPath, filePath)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}
