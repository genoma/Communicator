import { listSessions, loadSession } from '../sessions.js'
import { selectSession } from '../session-picker.js'
import { rpgSessionsDir } from '../rpg.js'
import { sessionToResumeResult } from './resume.js'

// Resolves the chapter a bare --rpg --resume continues: the only chapter is
// used directly, with more than one the same interactive picker as a normal
// -r chooses (piped one-shots fall back to the most recent chapter, the first
// in listSessions' activity order). Returns null when the RPG directory has
// no chapter sessions yet, so the caller can fall back to the legacy
// history.json story. The result carries the full resume shape (settings,
// identity) plus the chapter's turns and the story directory it belongs to.
export async function resolveRpgResume(rpgDir, { pick = selectSession, interactive = process.stdin.isTTY } = {}) {
  const dir = rpgSessionsDir(rpgDir)
  const sessions = await listSessions(dir)
  if (sessions.length === 0) return null

  const id = sessions.length === 1 || !interactive
    ? sessions[0].id
    : await pick(sessions, { message: 'Select a session to resume' })
  const session = await loadSession(dir, id)
  return {
    ...sessionToResumeResult(session, id),
    // Turns only: the system prompt is rebuilt from the current story files
    // on every launch, exactly like the history.json resume path.
    turns: session.messages.filter((m) => m.role !== 'system'),
    // Saving always targets the dir the chapter was actually loaded from
    // (the live --rpg <dir>), never a stale path stored in the payload.
    rpgDir,
  }
}
