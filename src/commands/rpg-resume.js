import { listSessions, loadSession } from '../sessions.js'
import { selectSession } from '../session-picker.js'
import { rpgSessionsDir } from '../rpg.js'

// Resolves the chapter a bare --rpg --resume continues: the only chapter is
// used directly, with more than one the same interactive picker as a normal
// -r chooses (piped one-shots fall back to the most recent chapter, the first
// in listSessions' activity order). Returns null when the RPG directory has
// no chapter sessions yet, so the caller can fall back to the legacy
// history.json story.
export async function resolveRpgResume(rpgDir, { pick = selectSession, interactive = process.stdin.isTTY } = {}) {
  const dir = rpgSessionsDir(rpgDir)
  const sessions = await listSessions(dir)
  if (sessions.length === 0) return null

  const id = sessions.length === 1 || !interactive
    ? sessions[0].id
    : await pick(sessions, { message: 'Select a session to resume' })
  const session = await loadSession(dir, id)
  return {
    sessionId: id,
    createdAt: session.createdAt ?? null,
    updatedAt: session.updatedAt ?? null,
    // Turns only: the system prompt is rebuilt from the current story files
    // on every launch, exactly like the history.json resume path.
    turns: session.messages.filter((m) => m.role !== 'system'),
  }
}
