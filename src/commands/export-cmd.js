import { mkdir } from 'node:fs/promises'
import { ensureSessionsDir, resolveSessionInteractive, loadSession } from '../sessions.js'
import { exportSession } from '../export.js'
import { fail } from '../cli-utils.js'

export async function exportCmd(partialId, outputDir) {
  const dir = await ensureSessionsDir()
  const matchedId = await resolveSessionInteractive(dir, partialId, { message: 'Select a session to export' })
  if (!matchedId) return

  const sessionData = await loadSession(dir, matchedId)
  const exportDir = outputDir || process.cwd()
  await mkdir(exportDir, { recursive: true })

  try {
    const folder = await exportSession(sessionData, exportDir, matchedId)
    console.log(`Exported to ${folder}`)
  } catch (err) {
    fail(`Error: Export failed: ${err.message}`)
  }
}
