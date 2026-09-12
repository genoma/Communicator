import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NO_COLOR = '1'
delete process.env.FORCE_COLOR

// The suite must behave the same with or without provider keys: a test that
// needs one stubs it itself (withApiKey), and a developer shell that exports
// the real keys must not change the outcome (CI has none). Clearing them here
// makes `npm test` match CI exactly.
delete process.env.OPENROUTER_API_KEY
delete process.env.VENICE_API_KEY

// src/constants.js resolves DATA_DIR and DEFAULT_CONFIG_FILE from the home
// directory at module load, so every unhomed test file would read and write
// the developer's real ~/.communicator.json and ~/.communicator/. Pointing
// HOME (POSIX) and USERPROFILE (Windows) at a throwaway directory makes the
// whole run hermetic instead of relying on each file's node:os mock.
const home = mkdtempSync(join(tmpdir(), 'communicator-test-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A leftover temp directory must never fail the run's exit code.
  }
})

const result = spawnSync(
  process.execPath,
  ['--test', '--experimental-test-module-mocks', ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
