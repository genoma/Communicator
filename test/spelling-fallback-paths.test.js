// The fallback and defensive paths of the spelling feature: a spawn, kill or
// stdin write that throws synchronously, a helper failure mid-session, a cache
// that cannot be listed, a malformed checker reply and the provider's range and
// LRU guards. Every case drives one seam (the spawn function, a fake child, the
// provider's backend function), so this file never runs osascript, the compiler
// or the network.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHelperBackend } from '../src/spelling/helper-backend.js'
import { createSpellingProvider } from '../src/spelling/provider.js'
import { createOsascriptBackend, SPELLING_ABORTED } from '../src/spelling/osascript.js'
import { isCheckableLine, isProseWord } from '../src/spelling/mask.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The build watchdog in src/spelling/helper-backend.js is unref'ed, so an await
// that only that timer can settle leaves Node 22's event loop empty and the
// runner cancels the test before the seam fires; the ref'ed ticker holds the
// loop open until the promise actually settles.
async function settle(promise) {
  const ticker = setInterval(() => {}, 5)
  try {
    return await promise
  } finally {
    clearInterval(ticker)
  }
}

const SOURCE = fileURLToPath(new URL('../src/spelling/helper.m', import.meta.url))
const FALLBACK_REPLY = { ranges: [[0, 1]] }

// --- the compiled helper's failure paths ---

// The spawn seam is the only place the helper backend touches the outside
// world: the compiler carries `/usr/bin/cc`, the helper the cached binary path,
// so the two kinds of fake child are told apart by their command.
function createHarness() {
  const harness = { children: [], throwOnHelperSpawn: false }
  harness.spawnFn = (command, args, options) => {
    if (harness.throwOnHelperSpawn && command.includes('spelling-helper-')) {
      throw new Error('spawn helper EACCES')
    }
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
        callback?.()
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
    harness.children.push(child)
    return child
  }
  harness.compiler = () => harness.children.find((child) => !child.command.includes('spelling-helper-'))
  harness.helpers = () => harness.children.filter((child) => child.command.includes('spelling-helper-'))
  harness.waitForCompiler = async () => {
    for (let i = 0; i < 500 && harness.compiler() === undefined; i += 1) await delay(1)
    assert.ok(harness.compiler(), 'the compile started')
    return harness.compiler()
  }
  // The compiler is faked, so the test plays its part: write the binary it
  // would have produced, then report the exit status.
  harness.finishBuild = async (code = 0) => {
    const child = await harness.waitForCompiler()
    if (code === 0) {
      await writeFile(child.args[child.args.indexOf('-o') + 1], 'helper binary', { mode: 0o755 })
    }
    child.emit('close', code)
  }
  return harness
}

// The fallback stands in for the osascript backend: it answers and counts.
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

async function createHelperHarness(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-spelling-fallback-'))
  // A fake developer directory keeps the toolchain probe deterministic, so no
  // case here depends on the host's own compiler.
  const toolchain = join(dir, 'toolchain')
  await mkdir(join(toolchain, 'usr/bin'), { recursive: true, mode: 0o700 })
  await writeFile(join(toolchain, 'usr/bin/clang'), '', { mode: 0o755 })
  const harness = createHarness()
  const fallback = createFallback()
  const backend = createHelperBackend({
    spawnFn: harness.spawnFn,
    fallback,
    sourcePath: SOURCE,
    cacheDir: dir,
    toolchainDirs: [toolchain],
    ...overrides,
  })
  return { dir, toolchain, harness, fallback, backend }
}

/** Drive a backend to the point where its compiled helper serves the requests */
async function buildHelper(harness, backend) {
  const ready = backend.whenReady()
  await harness.finishBuild()
  assert.equal(await ready, true)
}

test('an abandon whose kill throws still hands the request to osascript', async () => {
  const { dir, harness, fallback, backend } = await createHelperHarness()
  await buildHelper(harness, backend)

  const first = backend.run({ op: 'check', text: 'a' })
  const helper = harness.helpers()[0]
  helper.stdout.emit('data', '{"id":1,"ranges":[]}\n')
  await first

  helper.kill = () => {
    throw new Error('kill ESRCH')
  }
  const pending = backend.run({ op: 'check', text: 'b' })
  helper.stdout.emit('data', 'not json at all\n')

  assert.deepEqual(await pending, FALLBACK_REPLY, 'the caller is not left waiting on the dead child')
  assert.deepEqual(
    fallback.calls.map((call) => call.text),
    ['b']
  )

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a helper that cannot be spawned falls back and spends its restart', async () => {
  const { dir, harness, fallback, backend } = await createHelperHarness()
  await buildHelper(harness, backend)
  harness.throwOnHelperSpawn = true

  assert.deepEqual(await backend.run({ op: 'check', text: 'a' }), FALLBACK_REPLY, 'the first spawn throw is swallowed')
  assert.deepEqual(await backend.run({ op: 'check', text: 'b' }), FALLBACK_REPLY, 'the second throw spends the restart')
  assert.equal(await backend.whenReady(), false, 'the spent restart latches the compiled path off')
  assert.deepEqual(await backend.run({ op: 'check', text: 'c' }), FALLBACK_REPLY)
  assert.equal(harness.helpers().length, 0, 'a throwing spawn never leaves a child behind')
  assert.deepEqual(
    fallback.calls.map((call) => call.text),
    ['a', 'b', 'c']
  )

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('an error on the helper stdin abandons it and re-runs the caller', async () => {
  const { dir, harness, fallback, backend } = await createHelperHarness()
  await buildHelper(harness, backend)

  const pending = backend.run({ op: 'check', text: 'a' })
  const helper = harness.helpers()[0]
  helper.stdin.emit('error', new Error('EPIPE'))

  assert.deepEqual(await pending, FALLBACK_REPLY)
  assert.deepEqual(helper.killSignals, ['SIGKILL'])
  assert.deepEqual(
    fallback.calls.map((call) => call.text),
    ['a']
  )

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a build timeout whose compiler kill throws stays on the fallback', async () => {
  const { dir, harness, fallback, backend } = await createHelperHarness({ buildTimeoutMs: 5 })

  const ready = backend.whenReady()
  const compiler = await harness.waitForCompiler()
  compiler.kill = () => {
    throw new Error('kill ESRCH')
  }

  assert.equal(await settle(ready), false, 'the expired build fails whether or not the kill landed')
  assert.deepEqual(await backend.run({ op: 'check', text: 'x' }), FALLBACK_REPLY)
  assert.equal(harness.helpers().length, 0)
  assert.equal(fallback.calls.length, 1)

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a synchronous stdin write throw re-runs the caller on osascript', async () => {
  const { dir, harness, fallback, backend } = await createHelperHarness()
  await buildHelper(harness, backend)

  const first = backend.run({ op: 'check', text: 'a' })
  const helper = harness.helpers()[0]
  helper.stdout.emit('data', '{"id":1,"ranges":[]}\n')
  await first

  helper.stdin.write = () => {
    throw new Error('write EPIPE')
  }
  assert.deepEqual(await backend.run({ op: 'check', text: 'b' }), FALLBACK_REPLY)
  assert.deepEqual(helper.killSignals, ['SIGKILL'])
  assert.deepEqual(
    fallback.calls.map((call) => call.text),
    ['b']
  )

  backend.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a cache that cannot be listed still starts the cached helper', async () => {
  const { dir, toolchain, harness, fallback, backend } = await createHelperHarness()
  await buildHelper(harness, backend)
  backend.dispose()

  // A cache directory without read permission: the binary can still be
  // executed, but the stale-binary sweep cannot list the directory.
  await chmod(dir, 0o111)
  const second = createHelperBackend({
    spawnFn: harness.spawnFn,
    fallback,
    sourcePath: SOURCE,
    cacheDir: dir,
    toolchainDirs: [toolchain],
  })

  assert.equal(await second.whenReady(), true, 'an unlistable cache is not a build failure')
  const pending = second.run({ op: 'check', text: 'a' })
  const helper = harness.helpers().at(-1)
  helper.stdout.emit('data', '{"id":1,"ranges":[]}\n')
  assert.deepEqual(await pending, { id: 1, ranges: [] })
  assert.equal(fallback.calls.length, 0)

  second.dispose()
  await chmod(dir, 0o700)
  await rm(dir, { recursive: true, force: true })
})

// --- the osascript backend's synchronous failures ---

function createOsascriptHarness() {
  const children = []
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter()
    child.command = command
    child.args = args
    child.options = options
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killSignals = []
    child.kill = (signal) => {
      child.killSignals.push(signal)
      return true
    }
    children.push(child)
    return child
  }
  return { children, spawnFn }
}

test('an osascript spawn that throws synchronously rejects with that error', async () => {
  const failure = new Error('spawn /usr/bin/osascript EACCES')
  const backend = createOsascriptBackend({
    spawnFn: () => {
      throw failure
    },
  })
  await assert.rejects(backend.run({ op: 'check', text: 'x' }), (error) => error === failure)
})

test('an osascript child whose kill throws still reports the abort', async () => {
  const { children, spawnFn } = createOsascriptHarness()
  const backend = createOsascriptBackend({ spawnFn })
  const controller = new AbortController()
  const pending = backend.run({ op: 'check', text: 'x' }, { signal: controller.signal })
  children[0].kill = () => {
    throw new Error('kill ESRCH')
  }

  controller.abort()
  await assert.rejects(pending, (error) => error.code === SPELLING_ABORTED)
})

// --- the platform gate composes the helper (darwin) or portable backend ---

// index.js must be loaded after the mocks so its `./helper-backend.js` and
// `./nspell.js` imports bind the factories below; the real modules stay bound
// to this file's static imports (see test/one-shot.test.js for the same
// pattern). The portable backend is faked here too, so the gate cases never
// load the real dictionary.
const helperBackends = []
mock.module(new URL('../src/spelling/helper-backend.js', import.meta.url).href, {
  namedExports: {
    createHelperBackend: () => {
      const backend = {
        runs: [],
        disposals: 0,
        run(request) {
          backend.runs.push(request)
          return Promise.resolve({ ranges: [[6, 5]] })
        },
        dispose() {
          backend.disposals += 1
        },
      }
      helperBackends.push(backend)
      return backend
    },
  },
})

const portableBackends = []
mock.module(new URL('../src/spelling/nspell.js', import.meta.url).href, {
  namedExports: {
    createNspellBackend: () => {
      const backend = {
        runs: [],
        run(request) {
          backend.runs.push(request)
          return Promise.resolve({ ranges: [[0, 1]] })
        },
      }
      portableBackends.push(backend)
      return backend
    },
  },
})

const { createPlatformSpellingProvider } = await import('../src/spelling/index.js')

test('on darwin the platform provider is built on the compiled-helper backend', async () => {
  const before = helperBackends.length
  const provider = createPlatformSpellingProvider({ platform: 'darwin', features: { typoDetection: true } })
  assert.equal(helperBackends.length, before + 1, 'the darwin gate constructs the helper backend')
  const backend = helperBackends.at(-1)

  assert.equal(provider.getTypoRanges('hello wrold'), undefined)
  for (let i = 0; i < 100 && backend.runs.length === 0; i += 1) await delay(10)
  assert.deepEqual(backend.runs, [{ op: 'check', text: 'hello wrold' }])
  await delay(20)
  assert.deepEqual(provider.getTypoRanges('hello wrold'), [[6, 11]], 'the helper reply is cached and painted')

  provider.dispose()
  assert.equal(backend.disposals, 1, 'dispose reaches the helper backend')
})

test('off darwin the platform provider is built on the portable backend', async () => {
  const beforeHelpers = helperBackends.length
  const beforePortable = portableBackends.length
  const provider = createPlatformSpellingProvider({ platform: 'linux', features: { typoDetection: true } })
  assert.equal(portableBackends.length, beforePortable + 1, 'the gate constructs the portable backend off darwin')
  assert.equal(helperBackends.length, beforeHelpers, 'the gate never constructs a helper off darwin')
  assert.equal(provider.completionsSupported, false, 'the portable backend answers no dictionary completions')
  const backend = portableBackends.at(-1)

  assert.equal(provider.getTypoRanges('hello wrold'), undefined)
  for (let i = 0; i < 100 && backend.runs.length === 0; i += 1) await delay(10)
  assert.deepEqual(backend.runs, [{ op: 'check', text: 'hello wrold' }])
  await delay(20)
  assert.deepEqual(provider.getTypoRanges('hello wrold'), [[0, 1]], 'the portable reply is cached and painted')

  provider.dispose()
})

// --- the provider's range, cache and dispose guards ---

// The backend seam keeps the provider cases free of osascript: `run` is a plain
// function returning the reply the JXA program would.
function createBackend(handler = async () => ({ ranges: [] })) {
  const calls = []
  return {
    calls,
    run(request, options = {}) {
      calls.push({ request, signal: options.signal })
      return handler(request, calls.length, options)
    },
  }
}

test('a non-string line is rejected before any range scan', async () => {
  assert.equal(isCheckableLine(null), false)
  assert.equal(isCheckableLine(undefined), false)
  assert.equal(isCheckableLine(42), false)
  assert.equal(isProseWord(null), false)

  const backend = createBackend()
  const spelling = createSpellingProvider({
    backend,
    features: { typoDetection: true, autocomplete: true, autocorrect: true },
    debounceMs: 1,
  })

  assert.equal(spelling.getTypoRanges(null), undefined)
  assert.equal(await spelling.getWordReplacements([null], 0, 0), null)
  assert.equal(spelling.getWordCompletion([42], 0, 0), null)
  assert.equal(await spelling.getAutocorrection([{}], 0, 0), null)
  await delay(20)
  assert.equal(backend.calls.length, 0, 'a non-string line never reaches a backend')
  spelling.dispose()
})

test('checker ranges are cached sorted by start', async () => {
  const backend = createBackend(async () => ({ ranges: [[6, 3], [0, 5]] }))
  const spelling = createSpellingProvider({ backend, features: { typoDetection: true }, debounceMs: 1 })
  const line = 'wrold teh x'

  assert.equal(spelling.getTypoRanges(line), undefined)
  await delay(20)
  assert.deepEqual(spelling.getTypoRanges(line), [[0, 5], [6, 9]], 'the later typo is sorted behind the earlier one')
  spelling.dispose()
})

test('malformed range entries never reach the cache', async () => {
  const line = 'wrold teh --rpg ok'
  const malformed = [
    '05', // a two-character string, not an entry array
    [6, 3, 0], // one element too many
    [6.5, 3], // a non-integer start
    [6, 3.5], // a non-integer span
    [-30, 5], // a start far before the line
    [6, 0], // a zero-length range
    [16, 5], // an end past the line
    [12, 3], // the "rpg" inside "--rpg", not prose
  ]
  const backend = createBackend(async (request) =>
    request.text === line ? { ranges: [...malformed, [6, 3]] } : { ranges: 42 }
  )
  const spelling = createSpellingProvider({ backend, features: { typoDetection: true }, debounceMs: 1 })

  assert.equal(spelling.getTypoRanges(line), undefined)
  await delay(20)
  assert.deepEqual(spelling.getTypoRanges(line), [[6, 9]], 'only the well-formed prose range survives')

  assert.equal(spelling.getTypoRanges('second wrold'), undefined)
  await delay(20)
  assert.deepEqual(spelling.getTypoRanges('second wrold'), [], 'a reply that is not an array caches no ranges')
  spelling.dispose()
})

test('a non-array words reply answers null for guesses and completions', async () => {
  const backend = createBackend(async (request) => {
    if (request.op === 'check') return { ranges: [[0, 5]] }
    if (request.op === 'guesses') return { words: 'world' }
    return { words: {} }
  })
  const spelling = createSpellingProvider({
    backend,
    features: { typoDetection: true, autocomplete: true },
    debounceMs: 1,
  })

  assert.equal(await spelling.getWordReplacements(['wrold'], 0, 2), null, 'a string is not a word list')

  const lines = ['say recon']
  assert.equal(spelling.getWordCompletion(lines, 0, 9), null)
  await delay(20)
  assert.equal(spelling.getWordCompletion(lines, 0, 9), null, 'an object is not a word list')
  await delay(20)
  assert.equal(
    backend.calls.filter((call) => call.request.op === 'completions').length,
    1,
    'the null answer is cached'
  )
  spelling.dispose()
})

test('a repeated typo read refreshes the line it re-reads', async () => {
  const backend = createBackend(async () => ({ ranges: [[0, 5]] }))
  const spelling = createSpellingProvider({
    backend,
    features: { typoDetection: true },
    debounceMs: 1,
    maxCacheEntries: 2,
  })

  for (const line of ['wrold one', 'wrold two']) {
    spelling.getTypoRanges(line)
    await delay(10)
  }
  assert.deepEqual(spelling.getTypoRanges('wrold one'), [[0, 5]], 'the re-read line is refreshed to the front')
  spelling.getTypoRanges('wrold three')
  await delay(10)

  assert.deepEqual(spelling.getTypoRanges('wrold one'), [[0, 5]], 'the refreshed line survived the eviction')
  assert.equal(spelling.getTypoRanges('wrold two'), undefined, 'the least recently read line was evicted')
  spelling.dispose()
})

test('a repeated completion read refreshes the word it re-reads', async () => {
  const backend = createBackend(async () => ({ words: ['reconciliation'] }))
  const spelling = createSpellingProvider({
    backend,
    features: { autocomplete: true },
    debounceMs: 1,
    maxCacheEntries: 2,
  })
  const ask = (line) => spelling.getWordCompletion([line], 0, line.length)
  const completions = () => backend.calls.filter((call) => call.request.op === 'completions').length

  assert.equal(ask('one recon'), null)
  await delay(20)
  assert.equal(ask('one recon'), 'ciliation')
  assert.equal(ask('two recon'), null)
  await delay(20)
  assert.equal(ask('two recon'), 'ciliation')
  assert.equal(ask('one recon'), 'ciliation', 'the re-read word is refreshed to the front')
  assert.equal(ask('three recon'), null)
  await delay(20)
  assert.equal(completions(), 3)

  assert.equal(ask('one recon'), 'ciliation', 'the refreshed word survived the eviction')
  assert.equal(ask('two recon'), null, 'the least recently read word was evicted')
  assert.equal(completions(), 3, 'a cache hit never spawns')
  await delay(20)
  assert.equal(completions(), 4, 'the evicted word is asked again')
  spelling.dispose()
})

test('a second dispose does not release the backend again', () => {
  const backend = createBackend()
  const released = []
  backend.dispose = () => released.push('dispose')
  const spelling = createSpellingProvider({ backend, debounceMs: 1 })

  spelling.dispose()
  spelling.dispose()
  assert.deepEqual(released, ['dispose'])
})
