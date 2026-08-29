import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// The app imports ExitPromptError / Separator from '@inquirer/core' and relies on
// `instanceof ExitPromptError` in several handlers. If @inquirer/core is ever
// duplicated (a nested copy under a prompt package), the nested class is a
// different identity and `instanceof` fails in production, turning a user's
// Ctrl+C at a picker into an uncaught exception. This pins the dedupe: exactly
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

  const version = packages['node_modules/@inquirer/core']?.version
  assert.match(version || '', /^12\./, `@inquirer/core must be v12 (which exports ExitPromptError/Separator); got ${version}`)
})
