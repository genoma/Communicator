// Fixture for test/runner-console-guard.test.js: a test file that logs the way
// the application does — a provider banner, a box-drawing rule and the answer
// marker — from async tests, so its output interleaves with the runner's frames
// on fd 1 instead of landing in one leading block.
// It lives outside test/ because `node --test` runs every .js file under a test
// directory as a test file of its own.
import test from 'node:test'

const LINES = [
  '✓ Connected to Provider / org/model  [in $1.00 / out $2.00/M]  [thinking: High]',
  `${'─'.repeat(60)}`,
  '❯ Answer',
  'Hello world',
]

for (let i = 0; i < 20; i++) {
  test(`step ${i}`, async () => {
    await new Promise((resolve) => setImmediate(resolve))
    for (const line of LINES) console.log(line)
  })
}
