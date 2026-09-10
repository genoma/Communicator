import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('npm test routes through the color-deterministic wrapper', async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.js')
  assert.equal(packageJson.scripts['test:coverage'], 'node scripts/run-tests.js --experimental-test-coverage')
})

test('the wrapper forces plain styleText output before spawning the runner', async () => {
  const source = await readFile(join(ROOT, 'scripts', 'run-tests.js'), 'utf8')
  assert.match(source, /process\.env\.NO_COLOR = '1'/)
  assert.match(source, /delete process\.env\.FORCE_COLOR/)
  assert.match(source, /'--test'/)
  assert.match(source, /--experimental-test-module-mocks/)
})

test('the wrapper runs every test file against a throwaway home', async () => {
  const source = await readFile(join(ROOT, 'scripts', 'run-tests.js'), 'utf8')
  assert.match(source, /process\.env\.HOME = /)
  assert.match(source, /process\.env\.USERPROFILE = /)

  // This file runs inside the spawned runner, so its home IS the throwaway
  // one: constants.js can no longer resolve the developer's real
  // ~/.communicator.json (run the suite through `npm test`, not bare node).
  assert.equal(homedir(), process.env.HOME)
  assert.ok(homedir().startsWith(tmpdir()), `tests must resolve the throwaway home, saw ${homedir()}`)
})
