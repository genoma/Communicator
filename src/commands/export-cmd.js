import { mkdir } from 'node:fs/promises'
import { ensureSessionsDir, resolveSessionsInteractive, loadSession } from '../sessions.js'
import { exportSession } from '../export.js'
import { fail } from '../cli-utils.js'

export async function exportCmd(partialId, outputDir) {
  const dir = await ensureSessionsDir()
  const matchedIds = await resolveSessionsInteractive(dir, partialId, { message: 'Select a session to export' })
  if (!matchedIds.length) {
    console.log('Export cancelled.')
    return
  }

  const exportDir = outputDir || process.cwd()
  await mkdir(exportDir, { recursive: true })

  for (const id of matchedIds) {
    const sessionData = await loadSession(dir, id)
    try {
      const folder = await exportSession(sessionData, exportDir, id)
      console.log(`Exported to ${folder}`)
    } catch (err) {
      fail(`Error: Export failed: ${err.message}`)
    }
  }
}
