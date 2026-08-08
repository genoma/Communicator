import { confirm } from '@inquirer/prompts'
import { ensureSessionsDir, resolveSessionsInteractive, deleteSession } from '../sessions.js'

export async function deleteCmd(partialId) {
  const dir = await ensureSessionsDir()
  const matchedIds = await resolveSessionsInteractive(dir, partialId, { message: 'Select a session to delete' })
  if (!matchedIds.length) {
    console.log('Deletion cancelled.')
    return
  }

  const message = matchedIds.length === 1 ? `Delete session ${matchedIds[0]}?` : `Delete ${matchedIds.length} sessions?`
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
