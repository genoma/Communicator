import { spawnSync } from 'node:child_process'

process.env.NO_COLOR = '1'
delete process.env.FORCE_COLOR

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
