import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

// The guard keeps application console output off the child's fd 1, where the
// parent runner parses that channel as v8 frames; the fixture emits output
// shaped like a frame boundary plus a size of 0, which the parent deserializes
// as a message and rejects ("Unable to deserialize cloned data due to invalid
// or unsupported version"). See scripts/test-child-console-guard.js.
const GUARD = fileURLToPath(new URL('../scripts/test-child-console-guard.js', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../scripts/fixtures/console-noise-child.js', import.meta.url))
const DESERIALIZE_ERROR = 'Unable to deserialize cloned data due to invalid or unsupported version.'

// This pin runs inside a test child itself, so it must not hand its own
// NODE_TEST_CONTEXT to the runner it spawns: the runner picks its reporter from
// that variable and would serialize its whole report instead of printing it.
const PARENT_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined }

test('the guard moves console output to stderr and leaves process.stdout alone', () => {
  const probe = "console.log('via-console'); process.stdout.write('via-stdout\\n')"
  const asChild = spawnSync(process.execPath, ['--import', GUARD, '--eval', probe], {
    encoding: 'utf8',
    env: { ...PARENT_ENV, NODE_TEST_CONTEXT: 'child-v8' },
  })
  assert.equal(asChild.status, 0)
  assert.match(asChild.stderr, /via-console/)
  assert.doesNotMatch(asChild.stdout, /via-console/)
  // process.stdout.write carries the runner's own protocol: patching it would
  // move every frame to stderr.
  assert.match(asChild.stdout, /via-stdout/)

  const asParent = spawnSync(process.execPath, ['--import', GUARD, '--eval', probe], {
    encoding: 'utf8',
    env: PARENT_ENV,
  })
  assert.equal(asParent.status, 0)
  assert.match(asParent.stdout, /via-console/)
  assert.match(asParent.stdout, /via-stdout/)
})

test('the guard keeps the fixture output off the runner protocol channel', () => {
  const guarded = spawnSync(
    process.execPath,
    ['--test', '--experimental-test-module-mocks', '--import', GUARD, FIXTURE],
    { encoding: 'utf8', env: PARENT_ENV },
  )
  assert.equal(guarded.status, 0, guarded.stderr)
  assert.doesNotMatch(guarded.stdout + guarded.stderr, /Unable to deserialize/)
  // The output is redirected, not dropped: the child's stderr is surfaced.
  assert.match(guarded.stdout, /zz/)
})

test('without the guard the fixture output fails the runner', (t) => {
  const attempts = []
  let failed = null
  for (let i = 0; i < 4 && failed === null; i++) {
    const raw = spawnSync(
      process.execPath,
      ['--test', '--experimental-test-module-mocks', FIXTURE],
      { encoding: 'utf8', env: PARENT_ENV },
    )
    attempts.push(raw.status)
    if ((raw.stdout + raw.stderr).includes(DESERIALIZE_ERROR)) failed = raw
  }
  t.diagnostic(`unguarded fixture runs: ${attempts.join(', ')} (exit codes; 1 = the reported failure)`)
  assert.notEqual(failed, null, `no run of ${FIXTURE} failed with ${DESERIALIZE_ERROR}`)
  assert.equal(failed.status, 1)
  const output = failed.stdout + failed.stderr
  assert.match(output, /console-noise-child\.js/)
  assert.match(output, /#processRawBuffer/)
})
