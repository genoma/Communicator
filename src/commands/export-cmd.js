import { mkdir } from 'node:fs/promises'
import { ensureSessionsDir, resolveSessionsInteractive, loadSession } from '../sessions.js'
import { exportSession } from '../export.js'
import { CliError } from '../errors.js'

const EXPORT_FORMATS = new Set(['markdown', 'jsonl'])

export async function exportCmd(partialId, outputDir, format = 'markdown') {
  const dir = await ensureSessionsDir()
  const matchedIds = await resolveSessionsInteractive(dir, partialId, { message: 'Select a session to export' })
  if (!matchedIds.length) {
    console.log('Export cancelled.')
    return
  }
  if (!EXPORT_FORMATS.has(format)) {
    throw new CliError('Error: --export-format expects "markdown" or "jsonl".')
  }

  const exportDir = outputDir || process.cwd()
  await mkdir(exportDir, { recursive: true })

  for (const id of matchedIds) {
    const sessionData = await loadSession(dir, id)
    try {
      const folder = await exportSession(sessionData, exportDir, id, format)
      console.log(`Exported to ${folder}`)
    } catch (err) {
      throw new CliError(`Error: Export failed: ${err.message}`)
    }
  }
}
