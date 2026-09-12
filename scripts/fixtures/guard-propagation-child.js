// Fixture for test/runner-console-guard.test.js: a real test child that reports
// whether the console guard reached it. It spies on process.stdout.write — the
// channel the guard must leave alone — and fails when console.log output lands
// there, so running it through the real runner pins that the runner forwards
// the wrapper's `--import` to the children it spawns.
// It lives outside test/ because `node --test` runs every .js file under a test
// directory as a test file of its own.
import test from 'node:test'
import assert from 'node:assert/strict'

const writes = []
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => {
  writes.push(String(chunk))
  return realWrite(chunk, ...rest)
}
console.log('guard-propagation-probe')

test('the console guard is loaded in this child', () => {
  assert.ok(
    !writes.some((chunk) => chunk.includes('guard-propagation-probe')),
    'console.log reached process.stdout, so the guard did not load',
  )
})
