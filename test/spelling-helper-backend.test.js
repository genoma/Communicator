import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access } from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHelperBackend } from '../src/spelling/helper-backend.js'
import { createSpellingProvider } from '../src/spelling/provider.js'
import { SPELLING_ABORTED } from '../src/spelling/osascript.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const SOURCE = fileURLToPath(new URL('../src/spelling/helper.m', import.meta.url))
const FALLBACK_REPLY = { ranges: [[0, 1]] }

// The spawn seam is the only place the backend touches the outside world, so a
// fake child covers the whole contract without a compiler, a helper binary or
// osascript. The spawned children are told apart by their command: the compiler
// carries `/usr/bin/cc`, the helper the cached binary path.
function createHarness({ writeError = null } = {}) {
  const children = []
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter()
    child.command = command
    child.args = args
    child.options = options
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.writes = []
    child.killSignals = []
    child.stdin = Object.assign(new EventEmitter(), {
      write(chunk, callback) {
        child.writes.push(chunk)
        callback?.(writeError)
        return true
      },
    })
    child.kill = (signal) => {
      child.killSignals.push(signal)
      child.emit('exit', null, signal)
      // A real child emits 'close' after 'exit'; the compiler path settles on it.
      child.emit('close', null, signal)
      return true
    }
    children.push(child)
    return child
  }
  const compiler = () => children.find((child) => !child.command.includes('spelling-helper-'))
  const helpers = () => children.filter((child) => child.command.includes('spelling-helper-'))
  // The build reads the source before it spawns the compiler, so the test waits
  // for that child instead of guessing a delay.
  const waitForCompiler = async () => {
    for (let i = 0; i < 200 && compiler() === undefined; i += 1) await delay(1)
    assert.ok(compiler(), 'the compile started')
    return compiler()
  }
  // The compiler is faked, so the test plays its part: write the binary it
  // would have produced, then report the exit status.
  const finishBuild = async (code = 0) => {
    const child = await waitForCompiler()
    if (code === 0) {
      await writeFile(child.args[child.args.indexOf('-o') + 1], 'helper binary', { mode: 0o755 })
    }
    child.emit('close', code)
  }
  return { children, spawnFn, compiler, helpers, waitForCompiler, finishBuild }
}

// The fallback stands in for the osascript backend: it answers, and counts.
function createFallback(reply = FALLBACK_REPLY) {
  const calls = []
  return {
    calls,
    run(request) {
      calls.push(request)
      return Promise.resolve(reply)
    },
  }
}

async function createHarnessBackend(overrides = {}, harnessOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-helper-test-'))
  // A fake developer directory, so the toolchain probe is deterministic on any
  // host (macOS without Command Line Tools, a CI Linux box, a sandbox) and the
  // tests never depend on the machine's own compiler.
  const toolchain = join(dir, 'toolchain')
  await mkdir(join(toolchain, 'usr/bin'), { recursive: true, mode: 0o700 })
  await writeFile(join(toolchain, 'usr/bin/clang'), '', { mode: 0o755 })
  const harness = createHarness(harnessOptions)
  const fallback = createFallback()
  const backend = createHelperBackend({
    spawnFn: harness.spawnFn,
    fallback,
    sourcePath: SOURCE,
    cacheDir: dir,
    toolchainDirs: [toolchain],
    ...overrides,
  })
  return { dir, harness, fallback, backend }
}

/** Drive a backend to the point where its compiled helper serves the requests */
async function buildHelper(harness, backend) {
  const ready = backend.whenReady()
  await harness.finishBuild()
  assert.equal(await ready, true)
}

test('requests before the build lands run on osascript and spawn no helper', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend()

  assert.deepEqual(await backend.run({ op: 'check', text: 'hello wrold' }), FALLBACK_REPLY)
  assert.deepEqual(fallback.calls, [{ op: 'check', text: 'hello wrold' }])
  assert.equal(harness.helpers().length, 0, 'nothing is spawned before the build lands')

  const compiler = await harness.waitForCompiler()
  assert.equal(compiler.command, '/usr/bin/cc')
  assert.deepEqual(compiler.args.slice(0, 5), ['-O2', '-fobjc-arc', '-framework', 'AppKit', '-o'])
  // A unique scratch name per process: two sessions sharing a cache entry must
  // never write the same file, or one can publish a byte-mix of both compiles.
  const scratch = compiler.args[5]
  assert.match(scratch, /\.\d+\.[0-9a-f]{8}\.tmp$/, 'the compile scratch name is unique per process')
  assert.equal(compiler.args[6], SOURCE)

  await buildHelper(harness, backend)
  const pending = backend.run({ op: 'check', text: 'hello wrold' })
  const helper = harness.helpers()[0]
  assert.equal(helper.command, scratch.replace(/\.\d+\.[0-9a-f]{8}\.tmp$/, ''), 'the helper runs the published binary')
  helper.stdout.emit('data', '{"id":1,"ranges":[[6,5]]}\n')
  assert.deepEqual(await pending, { id: 1, ranges: [[6, 5]] })

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('the helper answers by id over one newline-delimited stdin/stdout protocol', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)

  const pending = backend.run({ op: 'check', text: 'hello wrold' })
  const helper = harness.helpers()[0]
  assert.deepEqual(helper.writes, ['{"op":"check","text":"hello wrold","id":1}\n'])
  // The reply is reassembled from arbitrarily split reads.
  helper.stdout.emit('data', '{"id":1,"ra')
  helper.stdout.emit('data', 'nges":[[6,5]]}\n')
  assert.deepEqual(await pending, { id: 1, ranges: [[6, 5]] })
  assert.equal(fallback.calls.length, 0, 'a ready helper never reaches osascript')

  const second = backend.run({ op: 'guesses', text: 'teh', location: 0, length: 3 })
  assert.deepEqual(helper.writes[1], '{"op":"guesses","text":"teh","location":0,"length":3,"id":2}\n')
  helper.stdout.emit('data', '{"id":2,"words":["the"]}\n')
  assert.deepEqual(await second, { id: 2, words: ['the'] })

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a failed build keeps every request on the osascript fallback', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend()

  const ready = backend.whenReady()
  await harness.finishBuild(1)
  assert.equal(await ready, false)
  assert.deepEqual(harness.compiler().killSignals, [], 'the compiler exits on its own')

  assert.deepEqual(await backend.run({ op: 'check', text: 'x' }), FALLBACK_REPLY)
  assert.equal(harness.helpers().length, 0, 'a failed build spawns no helper')
  assert.deepEqual(await backend.run({ op: 'check', text: 'y' }), FALLBACK_REPLY)
  assert.equal(fallback.calls.length, 2)
  assert.equal(harness.children.length, 1, 'a failed build is never retried')

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a build that never finishes is killed and left on the fallback', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend({ buildTimeoutMs: 5 })

  const ready = backend.whenReady()
  const compiler = await harness.waitForCompiler()
  await delay(25)
  assert.equal(await ready, false)
  assert.deepEqual(compiler.killSignals, ['SIGKILL'])

  assert.deepEqual(await backend.run({ op: 'check', text: 'x' }), FALLBACK_REPLY)
  assert.equal(harness.helpers().length, 0)
  assert.equal(fallback.calls.length, 1)

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a cached binary is reused, so the helper is compiled once', async () => {
  const { dir, harness, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)
  const built = harness.children.length
  backend.dispose()

  const second = createHelperBackend({
    spawnFn: harness.spawnFn,
    fallback: createFallback(),
    sourcePath: SOURCE,
    cacheDir: dir,
  })
  assert.equal(await second.whenReady(), true)
  assert.equal(harness.children.length, built, 'a warm cache compiles nothing')
  second.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('the watchdog kills a hanging helper, falls back and latches off after one restart', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend({ timeoutMs: 5 })
  await buildHelper(harness, backend)

  const first = backend.run({ op: 'check', text: 'a' })
  const firstHelper = harness.helpers()[0]
  assert.deepEqual(await first, FALLBACK_REPLY, 'the timed-out request is re-run on osascript')
  assert.deepEqual(firstHelper.killSignals, ['SIGKILL'])
  assert.equal(harness.helpers().length, 1)

  const second = backend.run({ op: 'check', text: 'b' })
  const secondHelper = harness.helpers()[1]
  assert.notEqual(secondHelper, undefined, 'the session gets its one restart')
  assert.deepEqual(await second, FALLBACK_REPLY)
  assert.deepEqual(secondHelper.killSignals, ['SIGKILL'])

  assert.deepEqual(await backend.run({ op: 'check', text: 'c' }), FALLBACK_REPLY)
  assert.equal(harness.helpers().length, 2, 'the restart budget is gone: every later request is osascript')
  assert.deepEqual(
    fallback.calls.map((call) => call.text),
    ['a', 'b', 'c']
  )

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a malformed or over-long reply abandons the helper and falls back', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend({ maxBuffer: 64 })
  await buildHelper(harness, backend)

  const garbled = backend.run({ op: 'check', text: 'a' })
  const helper = harness.helpers()[0]
  helper.stdout.emit('data', 'not json at all\n')
  assert.deepEqual(await garbled, FALLBACK_REPLY)
  assert.deepEqual(helper.killSignals, ['SIGKILL'])

  const oversized = backend.run({ op: 'check', text: 'b' })
  const replaced = harness.helpers()[1]
  replaced.stdout.emit('data', `{"words":["${'x'.repeat(128)}"]}`)
  assert.deepEqual(await oversized, FALLBACK_REPLY, 'a reply over the buffer cap is a failure')
  assert.deepEqual(replaced.killSignals, ['SIGKILL'])
  assert.equal(fallback.calls.length, 2)

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('an error reply rejects the caller and keeps the helper alive', async () => {
  const { dir, harness, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)

  const unknown = backend.run({ op: 'nope', text: 'x' })
  const helper = harness.helpers()[0]
  helper.stdout.emit('data', '{"id":1,"error":"unknown op: nope"}\n')
  await assert.rejects(unknown, /unknown op: nope/)
  assert.deepEqual(helper.killSignals, [])

  const next = backend.run({ op: 'check', text: 'x' })
  helper.stdout.emit('data', '{"id":2,"ranges":[]}\n')
  assert.deepEqual(await next, { id: 2, ranges: [] })

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a crashed helper re-runs its pending request on osascript', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)

  const pending = backend.run({ op: 'check', text: 'a' })
  harness.helpers()[0].emit('exit', 1)
  assert.deepEqual(await pending, FALLBACK_REPLY)
  assert.deepEqual(
    fallback.calls.map((call) => call.text),
    ['a']
  )

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a superseded helper request rejects with the abort code and is forgotten', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)

  const controller = new AbortController()
  const pending = backend.run({ op: 'check', text: 'a' }, { signal: controller.signal })
  const helper = harness.helpers()[0]
  controller.abort()
  await assert.rejects(pending, (error) => error.code === SPELLING_ABORTED)
  assert.deepEqual(helper.killSignals, [], 'the helper survives a request nobody waits for')

  const already = new AbortController()
  already.abort()
  const abandoned = backend.run({ op: 'check', text: 'b' }, { signal: already.signal })
  await assert.rejects(abandoned, (error) => error.code === SPELLING_ABORTED)
  assert.equal(helper.writes.length, 1, 'an already-aborted request is never written')

  // The late reply of the dropped request matches no id and is dropped too.
  helper.stdout.emit('data', '{"id":1,"ranges":[[6,5]]}\n')
  const next = backend.run({ op: 'check', text: 'c' })
  const sent = JSON.parse(helper.writes[1])
  assert.equal(sent.text, 'c', 'the dropped requests never reach the helper')
  helper.stdout.emit('data', `${JSON.stringify({ id: sent.id, ranges: [] })}\n`)
  assert.deepEqual(await next, { id: sent.id, ranges: [] })
  assert.deepEqual(helper.killSignals, [])
  assert.equal(fallback.calls.length, 0)

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('dispose kills the helper and resolves every pending caller', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)

  const pending = backend.run({ op: 'check', text: 'a' })
  const helper = harness.helpers()[0]
  backend.dispose()
  assert.equal(await pending, null, 'no caller is left waiting')
  assert.deepEqual(helper.killSignals, ['SIGKILL'])
  assert.equal(await backend.run({ op: 'check', text: 'b' }), null, 'a disposed backend never spawns or falls back')
  assert.equal(fallback.calls.length, 0)

  await rm(dir, { recursive: true, force: true })
})

test('the provider drives the helper backend and kills it on dispose', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)

  const spelling = createSpellingProvider({ backend, features: { typoDetection: true }, debounceMs: 1 })

  assert.equal(spelling.getTypoRanges('hello wrold'), undefined)
  await delay(20)
  const helper = harness.helpers()[0]
  assert.deepEqual(helper.writes, ['{"op":"check","text":"hello wrold","id":1}\n'])
  helper.stdout.emit('data', '{"id":1,"ranges":[[6,5]]}\n')
  await delay(10)
  assert.deepEqual(spelling.getTypoRanges('hello wrold'), [[6, 11]])

  const replacement = spelling.getWordReplacements(['hello wrold'], 0, 8)
  const guesses = JSON.parse(helper.writes[1])
  assert.equal(guesses.op, 'guesses')
  assert.equal(guesses.location, 6)
  helper.stdout.emit('data', `${JSON.stringify({ id: guesses.id, words: ['world', 'wold'] })}\n`)
  assert.deepEqual(await replacement, { line: 0, startCol: 6, endCol: 11, items: ['world', 'wold'] })

  spelling.dispose()
  assert.deepEqual(helper.killSignals, ['SIGKILL'], 'disposing the provider releases the helper child')
  assert.equal(fallback.calls.length, 0)
  await rm(dir, { recursive: true, force: true })
})

// --- Toolchain probe and untested failure paths ---

test('a machine without a toolchain stays on osascript and never runs the compiler shim', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend({ toolchainDirs: [] })

  assert.equal(await backend.whenReady(), false)
  assert.deepEqual(await backend.run({ op: 'check', text: 'x' }), FALLBACK_REPLY)
  assert.equal(harness.children.length, 0, 'no compiler and no helper is ever spawned')
  assert.equal(fallback.calls.length, 1, 'the request still answers, through osascript')

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a developer directory without clang counts as no compiler', async () => {
  const { dir, harness, backend } = await createHarnessBackend({ toolchainDirs: ['/nonexistent-developer-dir'] })

  assert.equal(await backend.whenReady(), false)
  assert.equal(harness.children.length, 0)

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a compiler that cannot be spawned stays on the fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-helper-test-'))
  const toolchain = join(dir, 'toolchain')
  await mkdir(join(toolchain, 'usr/bin'), { recursive: true, mode: 0o700 })
  await writeFile(join(toolchain, 'usr/bin/clang'), '', { mode: 0o755 })
  const fallback = createFallback()
  const backend = createHelperBackend({
    spawnFn: () => {
      throw new Error('spawn /usr/bin/cc ENOENT')
    },
    fallback,
    sourcePath: SOURCE,
    cacheDir: dir,
    toolchainDirs: [toolchain],
  })

  assert.equal(await backend.whenReady(), false)
  assert.deepEqual(await backend.run({ op: 'check', text: 'x' }), FALLBACK_REPLY)
  assert.equal(fallback.calls.length, 1)

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('an unusable cache directory stays on the fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-helper-test-'))
  const toolchain = join(dir, 'toolchain')
  await mkdir(join(toolchain, 'usr/bin'), { recursive: true, mode: 0o700 })
  await writeFile(join(toolchain, 'usr/bin/clang'), '', { mode: 0o755 })
  await writeFile(join(dir, 'blocker'), 'not a directory')
  const fallback = createFallback()
  const backend = createHelperBackend({
    spawnFn: createHarness().spawnFn,
    fallback,
    sourcePath: SOURCE,
    cacheDir: join(dir, 'blocker', 'cache'),
    toolchainDirs: [toolchain],
  })

  assert.equal(await backend.whenReady(), false)
  assert.deepEqual(await backend.run({ op: 'check', text: 'x' }), FALLBACK_REPLY)
  assert.equal(fallback.calls.length, 1)

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a helper spawn error mid-request re-runs the caller on osascript', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)

  const pending = backend.run({ op: 'check', text: 'a' })
  harness.helpers()[0].emit('error', new Error('EPIPE'))
  assert.deepEqual(await pending, FALLBACK_REPLY)
  assert.deepEqual(
    fallback.calls.map((call) => call.text),
    ['a']
  )

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a failed helper write re-runs the caller on osascript', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend({}, { writeError: new Error('EPIPE') })
  await buildHelper(harness, backend)

  assert.deepEqual(await backend.run({ op: 'check', text: 'a' }), FALLBACK_REPLY)
  assert.deepEqual(harness.helpers()[0].killSignals, ['SIGKILL'])
  assert.equal(fallback.calls.length, 1)

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('dispose during the build kills the compiler and keeps the fallback', async () => {
  const { dir, harness, backend } = await createHarnessBackend()

  const ready = backend.whenReady()
  const compiler = await harness.waitForCompiler()
  backend.dispose()
  assert.deepEqual(compiler.killSignals, ['SIGKILL'], 'the in-flight compiler is killed too')
  assert.equal(await ready, false)
  assert.equal(harness.helpers().length, 0, 'no helper is ever spawned after dispose')

  await rm(dir, { recursive: true, force: true })
})

test('a reply line without an id, or a non-object line, is a protocol violation', async () => {
  const { dir, harness, fallback, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)

  const idless = backend.run({ op: 'check', text: 'a' })
  const helper = harness.helpers()[0]
  helper.stdout.emit('data', '{"ranges":[]}\n')
  assert.deepEqual(await idless, FALLBACK_REPLY)
  assert.deepEqual(helper.killSignals, ['SIGKILL'])

  const nonObject = backend.run({ op: 'check', text: 'b' })
  const replaced = harness.helpers()[1]
  replaced.stdout.emit('data', '[]\n')
  assert.deepEqual(await nonObject, FALLBACK_REPLY)
  assert.deepEqual(replaced.killSignals, ['SIGKILL'])
  assert.equal(fallback.calls.length, 2)

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('two replies in one chunk are both delivered, a stale id is ignored and multibyte replies reassemble', async () => {
  const { dir, harness, backend } = await createHarnessBackend()
  await buildHelper(harness, backend)
  const first = backend.run({ op: 'check', text: 'a' })
  const second = backend.run({ op: 'guesses', text: 'café', location: 0, length: 4 })
  const helper = harness.helpers()[0]
  helper.stdout.emit('data', '{"id":99,"ranges":[]}\n{"id":1,"ranges":[[6,5]]}\n{"id":2,"words":["caf')
  assert.deepEqual(await first, { id: 1, ranges: [[6, 5]] })
  helper.stdout.emit('data', 'é"]}\n')
  assert.deepEqual(await second, { id: 2, words: ['café'] })
  assert.deepEqual(helper.killSignals, [], 'a stale id is not a failure')

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('the cached binary is dropped when the helper latches off, so the next session rebuilds', async () => {
  const { dir, harness, backend } = await createHarnessBackend({ timeoutMs: 5 })
  await buildHelper(harness, backend)

  const first = backend.run({ op: 'check', text: 'a' })
  const binary = harness.helpers()[0].command

  assert.deepEqual(await first, FALLBACK_REPLY, 'the first failure spends the restart')
  assert.deepEqual(await backend.run({ op: 'check', text: 'b' }), FALLBACK_REPLY, 'the second latches osascript back in')
  assert.equal(await backend.whenReady(), false, 'whenReady reports the live state, not the memoised build')
  assert.deepEqual(await backend.run({ op: 'check', text: 'c' }), FALLBACK_REPLY)
  assert.equal(harness.helpers().length, 2, 'no further helper is spawned')
  await delay(10)
  assert.equal(await access(binary).then(() => true, () => false), false, 'a suspect binary is not kept in the cache')

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})
