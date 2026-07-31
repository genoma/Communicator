import { confirm } from '@inquirer/prompts'
import { ensureSessionsDir, resolveSessionInteractive, deleteSession } from '../sessions.js'

export async function deleteCmd(partialId) {
  const dir = await ensureSessionsDir()
  const matchedId = await resolveSessionInteractive(dir, partialId, { message: 'Select a session to delete' })
  if (!matchedId) return

  const confirmed = await confirm({ message: `Delete session ${matchedId}?`, default: false })
  if (!confirmed) {
    console.log('Deletion cancelled.')
    return
  }

  await deleteSession(dir, matchedId)
  console.log(`Deleted session ${matchedId}`)
}
