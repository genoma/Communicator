import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { ensureSessionsDir, resolveSessionInteractive, loadSession } from "../sessions.js"
import { exportSession } from "../export.js"

export async function exportCmd(partialId, outputDir) {
  const dir = await ensureSessionsDir()
  const matchedId = await resolveSessionInteractive(dir, partialId)
  if (!matchedId) return

  const sessionData = await loadSession(dir, matchedId)
  const exportDir = outputDir || process.cwd()
  await mkdir(exportDir, { recursive: true })
  const outputPath = join(exportDir, `session-${matchedId}.md`)

  try {
    await exportSession(sessionData, outputPath)
    console.log(`Exported to ${outputPath}`)
  } catch (err) {
    console.error(`Export failed: ${err.message}`)
    process.exit(1)
  }
}
