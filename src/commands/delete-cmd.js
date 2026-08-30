import { confirm } from '@inquirer/prompts'
import { ensureSessionsDir, resolveSessionsInteractive, deleteSessions, listSessions } from '../sessions.js'
import { formatSessionItem } from '../ui/format.js'
import { CliError } from '../errors.js'

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

  const { removed, failures } = await deleteSessions(dir, matchedIds)
  if (failures.length > 0) {
    console.log(removed > 0 ? `Deleted ${removed} of ${matchedIds.length} sessions.` : 'No sessions were deleted.')
    throw new CliError(`Error: could not remove ${failures.length} session(s): ${failures.join(', ')}`)
  }
  console.log(matchedIds.length === 1 ? `Deleted session ${matchedIds[0]}` : `Deleted ${matchedIds.length} sessions`)
}
