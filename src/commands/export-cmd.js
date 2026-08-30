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

  const failures = []
  for (const id of matchedIds) {
    try {
      const sessionData = await loadSession(dir, id)
      const folder = await exportSession(sessionData, exportDir, id, format)
      console.log(`Exported to ${folder}`)
    } catch {
      failures.push(id)
    }
  }
  if (failures.length > 0) {
    throw new CliError(`Error: could not export ${failures.length} session(s): ${failures.join(', ')}`)
  }
}
