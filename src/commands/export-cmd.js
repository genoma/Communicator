import { join } from "node:path"
import { ensureSessionsDir, resolveSessionInteractive, loadSession } from "../sessions.js"
import { exportSession } from "../export.js"

export async function exportCmd(partialId) {
  const dir = await ensureSessionsDir()
  const matchedId = await resolveSessionInteractive(dir, partialId)
  if (!matchedId) return

  const sessionData = await loadSession(dir, matchedId)
  const outputPath = join(process.cwd(), `session-${matchedId}.md`)

  try {
    await exportSession(sessionData, outputPath)
    console.log(`Exported to ${outputPath}`)
  } catch (err) {
    console.error(`Export failed: ${err.message}`)
    process.exit(1)
  }
}
