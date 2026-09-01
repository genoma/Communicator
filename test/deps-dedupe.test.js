import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// The app imports Separator from '@inquirer/core' and relies on the name-based
// isExitPromptError check (`error?.name === 'ExitPromptError'`) in every
// handler. If @inquirer/core is ever duplicated (a nested copy under a prompt
// package), `instanceof` would fail across module instances, but the name
// check matches the thrower's class regardless — and Separator identity
// requires the single copy. This pins the dedupe: exactly
// one top-level @inquirer/core, no nested copies, on v12 (which exports both).
test('@inquirer/core resolves to a single deduped version with no nested copy', async () => {
  const lockPath = fileURLToPath(new URL('../package-lock.json', import.meta.url))
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const packages = lock.packages || {}
  const allCores = Object.keys(packages).filter(
    (key) => /^node_modules\/@inquirer\/core$/.test(key) || /^node_modules\/@inquirer\/.+\/node_modules\/@inquirer\/core$/.test(key)
  )
  const topLevel = allCores.filter((key) => key === 'node_modules/@inquirer/core')
  const nested = allCores.filter((key) => key !== 'node_modules/@inquirer/core')

  assert.equal(topLevel.length, 1, 'the app must declare exactly one top-level @inquirer/core')
  assert.equal(nested.length, 0, `no nested @inquirer/core copies allowed; found: ${nested.join(', ') || 'none'}`)

  const { version } = packages['node_modules/@inquirer/core'] || {}
  const { dependencies } = JSON.parse(
    await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  )
  const declaredRange = dependencies?.['@inquirer/core'] || ''
  const declaredMajor = (declaredRange.match(/\^(\d+)/) || [])[1]
  assert.ok(declaredMajor, `package.json must declare an @inquirer/core range; got ${declaredRange}`)
  assert.match(version || '', new RegExp(`^${declaredMajor}`), `@inquirer/core resolved ${version} but package.json declares ${declaredRange}; the declared major must be what the lockfile resolves`)
})
