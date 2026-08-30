import { confirm } from '@inquirer/prompts'
import { ensureSessionsDir, deleteAllSessions } from '../sessions.js'
import { CliError } from '../errors.js'

const YES_RE = /^(y|yes)$/i

export async function deleteAllSessionsCmd(value) {
  // A string value means the caller tried to pre-confirm: only y/yes passes,
  // and anything else (n, no, ...) cancels before any sessions dir access.
  // A bare flag arrives as boolean true and goes straight to the prompt.
  const preconfirmed = typeof value === 'string' && YES_RE.test(value.trim())
  if (typeof value === 'string' && !preconfirmed) {
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
  const { removed, failures } = await deleteAllSessions(dir)
  console.log(removed > 0 ? `Deleted ${removed} saved session(s).` : 'No saved sessions found.')
  if (failures.length > 0) {
    throw new CliError(`Error: could not remove ${failures.length} item(s): ${failures.join(', ')}`)
  }
}
