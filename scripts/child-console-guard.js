// A test child streams its results to the parent runner as v8 frames on fd 1,
// and the parent's FileTest parses that stream assuming a frame follows a
// frame. Application output on the same fd breaks the assumption: the parent
// reads a header and a size out of ordinary text, deserializes the garbage and
// fails the whole file with "Unable to deserialize cloned data due to invalid
// or unsupported version" (nodejs/node#62693, nodejs/node#48103). Moving the
// console object to stderr keeps app output off fd 1; the runner writes its
// protocol through process.stdout itself, so that stays untouched.
// The file must stay named without a `test-` prefix: the runner's default test
// discovery matches `**/test-*.js`, and a `test-` prefix beside scripts/ makes
// this helper a phantom test file in every suite run.
import { Console } from 'node:console'

// Only a test child carries NODE_TEST_CONTEXT; the parent runner's own console
// (and its reporter output) must keep writing to fd 1.
if (process.env.NODE_TEST_CONTEXT) {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
}
