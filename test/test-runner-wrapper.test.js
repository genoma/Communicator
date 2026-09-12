import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('npm test routes through the color-deterministic wrapper', async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.js')
  assert.equal(packageJson.scripts['test:coverage'], 'node scripts/run-tests.js --experimental-test-coverage')
})

test('the wrapper clears the ambient color, key and debug environment before spawning the runner', async () => {
  const source = await readFile(join(ROOT, 'scripts', 'run-tests.js'), 'utf8')
  assert.match(source, /process\.env\.NO_COLOR = '1'/)
  assert.match(source, /delete process\.env\.FORCE_COLOR/)
  assert.match(source, /delete process\.env\.OPENROUTER_API_KEY/)
  assert.match(source, /delete process\.env\.VENICE_API_KEY/)
  // COMMUNICATOR_DEBUG makes debug() print error stacks, which would break the
  // tests asserting a run's exact stderr on a developer shell that exports it.
  assert.match(source, /delete process\.env\.COMMUNICATOR_DEBUG/)
  assert.match(source, /'--test'/)
  assert.match(source, /--experimental-test-module-mocks/)
})

test('the wrapper runs every test file against a throwaway home', (t) => {
  // This file runs inside the spawned runner, so its home IS the throwaway
  // directory the wrapper created: constants.js can no longer resolve the
  // developer's real ~/.communicator.json (run the suite through `npm test`,
  // not bare node). Both home sources must point at that same directory.
  // A bare `node --test` run is not a wrapper failure, so skip there instead
  // of reporting an unrelated red test.
  if (!/^communicator-test-home-/.test(basename(homedir()))) {
    return t.skip('not run through scripts/run-tests.js')
  }
  assert.equal(homedir(), process.env.HOME)
  assert.equal(homedir(), process.env.USERPROFILE)
})
