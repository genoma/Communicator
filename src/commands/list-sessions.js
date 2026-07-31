import { ensureSessionsDir, listSessions, formatSessionItem } from '../sessions.js'

export async function listSessionsCmd() {
  const dir = await ensureSessionsDir()
  const sessions = await listSessions(dir)
  if (!sessions.length) {
    console.log('No saved sessions found.')
    return
  }
  console.log(`${sessions.length} saved session(s):\n`)
  for (const s of sessions) {
    console.log(formatSessionItem(s).line)
  }
}
