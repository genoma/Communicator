import { confirm } from '@inquirer/prompts'
import { ensureSessionsDir, deleteAllSessions } from '../sessions.js'

const YES_RE = /^(y|yes)$/i

export async function deleteAllSessionsCmd(value) {
  if (typeof value !== 'string' || !YES_RE.test(value.trim())) {
    console.log('Deletion cancelled.')
    return
  }
  const dir = await ensureSessionsDir()
  if (process.stdin.isTTY) {
    const sure = await confirm({
      message: 'Are you sure you want to delete ALL saved sessions? This cannot be undone.',
      default: false,
    })
    if (!sure) {
      console.log('Deletion cancelled.')
      return
    }
  }
  const count = await deleteAllSessions(dir)
  console.log(count > 0 ? `Deleted ${count} saved session(s).` : 'No saved sessions found.')
}
