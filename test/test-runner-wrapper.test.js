import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const ROOT = new URL('..', import.meta.url)

test('npm test routes through the color-deterministic wrapper', async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT.pathname, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.js')
  assert.equal(packageJson.scripts['test:coverage'], 'node scripts/run-tests.js --experimental-test-coverage')
})

test('the wrapper forces plain styleText output before spawning the runner', async () => {
  const source = await readFile(join(ROOT.pathname, 'scripts', 'run-tests.js'), 'utf8')
  assert.match(source, /process\.env\.NO_COLOR = '1'/)
  assert.match(source, /delete process\.env\.FORCE_COLOR/)
  assert.match(source, /'--test'/)
  assert.match(source, /--experimental-test-module-mocks/)
})
