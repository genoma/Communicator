// Fixture for test/runner-console-guard.test.js: a test file whose console
// output starts like a runner frame ("zz" as the header, then a size of 0),
// which is what makes the parent runner deserialize a text block as a message.
// The async bodies and the repetition keep the child's writes interleaved with
// the runner's frames, the shape that races with the parent's reads.
// It lives outside test/ because `node --test` runs every .js file under a test
// directory as a test file of its own.
import test from 'node:test'

const NOISE = `zz${'\0'.repeat(4)}`

for (let i = 0; i < 500; i++) {
  test(`noise ${i}`, async () => {
    await new Promise((resolve) => setImmediate(resolve))
    for (let j = 0; j < 20; j++) console.log(NOISE)
  })
}
