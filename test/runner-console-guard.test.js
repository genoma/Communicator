import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

// The guard keeps application console output off the child's fd 1, the channel
// the runner frames its v8-serialized results on: text that reaches the parent
// in the same buffer as a message is parsed as a header plus a size and
// deserialized, which fails a whole file with "Unable to deserialize cloned
// data due to invalid or unsupported version" (see scripts/child-console-guard.js
// and KNOWN-ISSUES F42). The guard reaches `--import` as a file URL, the way the
// wrapper passes it: the ESM resolver only treats a specifier starting with `/`,
// `./` or `../` as a path, so a Windows drive letter would be read as a `c:` URL.
const GUARD = new URL('../scripts/child-console-guard.js', import.meta.url).href
const FIXTURE = fileURLToPath(new URL('../scripts/fixtures/console-noise-child.js', import.meta.url))
const PROPAGATION_FIXTURE = fileURLToPath(new URL('../scripts/fixtures/guard-propagation-child.js', import.meta.url))
const MAX_OUTPUT = 64 * 1024 * 1024
// One symptom of the exposure this pin covers is a child that stops making
// progress, so an unbounded spawn would stall the suite instead of failing it.
const CHILD_TIMEOUT = 30_000

// This pin runs inside a test child itself, so it must not hand its own
// NODE_TEST_CONTEXT to the runner it spawns: the runner picks its reporter from
// that variable and would serialize its whole report instead of printing it.
const PARENT_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined }

// The census the docs use: walk fd 1 for 2-byte serialization headers (FF 0F),
// hop by the 4-byte big-endian size at offset 2, and count every byte outside a
// well-framed message as application text.
function censusProtocolStream(raw) {
  let offset = 0
  let frames = 0
  let textBytes = 0
  while (offset < raw.length) {
    if (raw[offset] === 0xff && raw[offset + 1] === 0x0f) {
      // A trailing partial header is not a well-framed message either: count it
      // as text at the end of the walk instead of reading past the buffer.
      if (offset + 6 > raw.length) break
      const end = offset + 6 + raw.readUInt32BE(offset + 2)
      if (end > raw.length) break
      frames++
      offset = end
    } else {
      textBytes++
      offset++
    }
  }
  textBytes += raw.length - offset
  return { frames, textBytes }
}

function runAsChild({ withGuard }) {
  const args = ['--experimental-test-module-mocks']
  if (withGuard) args.push('--import', GUARD)
  args.push(FIXTURE)
  return spawnSync(process.execPath, args, {
    env: { ...PARENT_ENV, NODE_TEST_CONTEXT: 'child-v8' },
    maxBuffer: MAX_OUTPUT,
    timeout: CHILD_TIMEOUT,
  })
}

function failure(child) {
  return child.error?.message ?? child.stderr.toString()
}

test('the guard moves console output to stderr and leaves process.stdout alone', () => {
  const probe = "console.log('via-console'); process.stdout.write('via-stdout\\n')"
  const asChild = spawnSync(process.execPath, ['--import', GUARD, '--eval', probe], {
    encoding: 'utf8',
    env: { ...PARENT_ENV, NODE_TEST_CONTEXT: 'child-v8' },
    timeout: CHILD_TIMEOUT,
  })
  assert.equal(asChild.status, 0, failure(asChild))
  assert.match(asChild.stderr, /via-console/)
  assert.doesNotMatch(asChild.stdout, /via-console/)
  // process.stdout.write carries the runner's own protocol: patching it would
  // move every frame to stderr.
  assert.match(asChild.stdout, /via-stdout/)

  const asParent = spawnSync(process.execPath, ['--import', GUARD, '--eval', probe], {
    encoding: 'utf8',
    env: PARENT_ENV,
    timeout: CHILD_TIMEOUT,
  })
  assert.equal(asParent.status, 0, failure(asParent))
  assert.match(asParent.stdout, /via-console/)
  assert.match(asParent.stdout, /via-stdout/)
})

test('the runner forwards --import to the test children it spawns', () => {
  // The whole fix rests on the runner passing its own --import down to the
  // children (it filters only --test, the coverage/watch flags and the
  // reporter/seed value flags), so the fixture asserts the guard's effect from
  // inside the child. Only the runner's own stdout can be checked from here:
  // the reporter echoes a child's stderr and stdout alike.
  const guarded = spawnSync(process.execPath, ['--test', '--import', GUARD, PROPAGATION_FIXTURE], {
    encoding: 'utf8',
    env: PARENT_ENV,
    timeout: CHILD_TIMEOUT,
  })
  assert.equal(guarded.status, 0, failure(guarded))
  assert.match(guarded.stdout, /console guard is loaded in this child/)

  // Without the propagation the fixture's console.log lands on the child's fd 1
  // again, which is what makes the assertion above a real signal.
  const unguarded = spawnSync(process.execPath, ['--test', PROPAGATION_FIXTURE], {
    encoding: 'utf8',
    env: PARENT_ENV,
    timeout: CHILD_TIMEOUT,
  })
  assert.notEqual(unguarded.status, 0)
})

test('a guarded test child writes no application byte to its fd 1', () => {
  const child = runAsChild({ withGuard: true })
  assert.equal(child.status, 0, failure(child))
  const walk = censusProtocolStream(child.stdout)
  assert.ok(walk.frames > 0, 'the child framed its results on fd 1')
  assert.equal(walk.textBytes, 0, 'fd 1 carries runner frames only')
  // Redirected, not dropped: the same lines are surfaced as the child's stderr.
  assert.match(child.stderr.toString(), /Connected to Provider/)
  assert.match(child.stderr.toString(), /Hello world/)
})

test('the same child without the guard leaks application bytes onto fd 1', () => {
  const child = runAsChild({ withGuard: false })
  assert.equal(child.status, 0, failure(child))
  const walk = censusProtocolStream(child.stdout)
  assert.ok(walk.frames > 0, 'the child framed its results on fd 1')
  assert.ok(walk.textBytes > 0, 'unguarded console output stays on fd 1')
  assert.match(child.stdout.toString(), /Connected to Provider/)
})
