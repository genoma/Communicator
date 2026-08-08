import { confirm } from '@inquirer/prompts'
import { ensureSessionsDir, resolveSessionsInteractive, deleteSession, listSessions, formatSessionItem } from '../sessions.js'

export async function deleteCmd(partialId) {
  const dir = await ensureSessionsDir()
  const matchedIds = await resolveSessionsInteractive(dir, partialId, { message: 'Select a session to delete' })
  if (!matchedIds.length) {
    console.log('Deletion cancelled.')
    return
  }

  const allSessions = await listSessions(dir)
  const matched = matchedIds.map((id) => allSessions.find((s) => s.id === id)).filter(Boolean)
  for (const s of matched) {
    const { time, model, preview } = formatSessionItem(s)
    const previewText = preview ? `  •  "${preview}"` : ''
    console.log(`  ${time}  ${model}${previewText}`)
  }

  const message = matchedIds.length === 1 ? 'Delete this session?' : `Delete these ${matchedIds.length} sessions?`
  const confirmed = await confirm({ message, default: false })
  if (!confirmed) {
    console.log('Deletion cancelled.')
    return
  }

  for (const id of matchedIds) {
    await deleteSession(dir, id)
  }
  console.log(matchedIds.length === 1 ? `Deleted session ${matchedIds[0]}` : `Deleted ${matchedIds.length} sessions`)
}
