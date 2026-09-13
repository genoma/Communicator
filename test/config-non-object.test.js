import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPreferences } from '../src/config.js'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function assertQuarantined(t, content, label) {
  const dir = await tempDir(t)
  const file = join(dir, 'prefs.json')
  await writeFile(file, content)
  const warnings = []
  t.mock.method(console, 'error', (message) => warnings.push(message))

  const result = await loadPreferences(file)

  assert.deepEqual(result, {}, `${label}: expected empty preferences`)
  await assert.rejects(readFile(file, 'utf-8'), /ENOENT/, `${label}: original file must be gone`)
  const backups = (await readdir(dir)).filter((entry) => entry.includes('.corrupt-'))
  assert.equal(backups.length, 1, `${label}: expected exactly one quarantine backup`)
  assert.match(backups[0], /^prefs\.json\.corrupt-/, `${label}: backup name`)
  assert.equal(await readFile(join(dir, backups[0]), 'utf-8'), content, `${label}: backup content`)
  assert.equal(warnings.length, 1, `${label}: expected exactly one warning`)
  assert.match(warnings[0], /is corrupt \(.*\); it was moved to /, `${label}: warning wording`)
  assert.ok(warnings[0].includes(file), `${label}: warning names the file`)
}

test('loadPreferences quarantines a JSON null preferences file', async (t) => {
  await assertQuarantined(t, 'null', 'null')
})

test('loadPreferences quarantines a JSON array preferences file', async (t) => {
  await assertQuarantined(t, '[]', 'array')
})

test('loadPreferences quarantines a JSON number preferences file', async (t) => {
  await assertQuarantined(t, '5', 'number')
})

test('loadPreferences quarantines a JSON boolean preferences file', async (t) => {
  await assertQuarantined(t, 'true', 'boolean')
})
