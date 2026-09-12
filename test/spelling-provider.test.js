import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSpellingProvider } from '../src/spelling/provider.js'
import { createPlatformSpellingProvider } from '../src/spelling/index.js'
import { MAX_BUFFER_LENGTH, MAX_LINE_LENGTH } from '../src/spelling/mask.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The backend seam keeps every provider test free of osascript and of the
// network: `run` is a plain function returning the reply the JXA program would.
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

test('a checked line is cached, reported once and never re-spawned', async () => {
  const backend = createBackend(async () => ({ ranges: [[6, 5]] }))
  const updates = []
  const spelling = createSpellingProvider({
    backend,
    features: { typoDetection: true },
    debounceMs: 1,
    onUpdate: () => updates.push('paint'),
  })

  assert.equal(spelling.getTypoRanges('hello wrold'), undefined)
  assert.equal(backend.calls.length, 0, 'the debounce runs before the first spawn')
  await delay(20)

  assert.deepEqual(spelling.getTypoRanges('hello wrold'), [[6, 11]])
  assert.deepEqual(backend.calls.map((c) => c.request.text), ['hello wrold'])
  assert.deepEqual(backend.calls.map((c) => c.request.op), ['check'])
  assert.deepEqual(updates, ['paint'])

  assert.deepEqual(spelling.getTypoRanges('hello wrold'), [[6, 11]])
  assert.equal(backend.calls.length, 1, 'a cached line is answered from the cache')
  spelling.dispose()
})

test('the debounce keeps only the last requested line', async () => {
  const backend = createBackend()
  const spelling = createSpellingProvider({ backend, debounceMs: 5 })

  spelling.getTypoRanges('wrold one')
  spelling.getTypoRanges('wrold two')
  spelling.getTypoRanges('wrold three')
  await delay(30)

  assert.deepEqual(backend.calls.map((c) => c.request.text), ['wrold three'])
  spelling.dispose()
})

test('one check runs at a time and the pending line follows it', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async (request) => {
    if (request.text === 'slow wrold') await gate
    return { ranges: [] }
  })
  const spelling = createSpellingProvider({ backend, debounceMs: 1 })

  spelling.getTypoRanges('slow wrold')
  await delay(20)
  assert.equal(backend.calls.length, 1, 'the first line is in flight')
  spelling.getTypoRanges('next wrold')
  await delay(20)
  assert.equal(backend.calls.length, 1, 'no second spawn while one is in flight')

  release()
  await delay(20)
  assert.deepEqual(backend.calls.map((c) => c.request.text), ['slow wrold', 'next wrold'])
  spelling.dispose()
})

test('three consecutive failures disable the feature for the session', async () => {
  const backend = createBackend(async () => { throw new Error('osascript died') })
  const updates = []
  const spelling = createSpellingProvider({ backend, debounceMs: 1, onUpdate: () => updates.push('paint') })

  for (const line of ['wrold one', 'wrold two', 'wrold three']) {
    assert.equal(spelling.getTypoRanges(line), undefined)
    await delay(10)
  }
  assert.equal(backend.calls.length, 3)

  assert.equal(spelling.getTypoRanges('wrold four'), undefined)
  await delay(10)
  assert.equal(backend.calls.length, 3, 'a disabled provider never spawns again')
  assert.deepEqual(updates, [], 'failures are silent')
  spelling.dispose()
})

test('a success between failures resets the counter', async () => {
  let calls = 0
  const backend = createBackend(async (request) => {
    if (request.text === 'wrold final') return { ranges: [] }
    calls += 1
    if (calls % 2 === 1) throw new Error('osascript died')
    return { ranges: [] }
  })
  const spelling = createSpellingProvider({ backend, debounceMs: 1 })

  for (let i = 0; i < 6; i++) {
    assert.equal(spelling.getTypoRanges(`wrold ${i}`), undefined)
    await delay(10)
  }
  assert.equal(backend.calls.length, 6, 'an alternating backend never reaches the limit')
  spelling.getTypoRanges('wrold final')
  await delay(20)
  assert.deepEqual(spelling.getTypoRanges('wrold final'), [], 'the feature is still alive')
  assert.equal(backend.calls.length, 7)
  spelling.dispose()
})

test('results are keyed by line content, never applied to another line', async () => {
  const backend = createBackend(async () => ({ ranges: [[0, 5]] }))
  const spelling = createSpellingProvider({ backend, debounceMs: 1 })

  assert.equal(spelling.getTypoRanges('wrold'), undefined)
  await delay(20)
  assert.deepEqual(spelling.getTypoRanges('wrold'), [[0, 5]])
  assert.equal(spelling.getTypoRanges('wrold!'), undefined, 'a newer line has no result yet')
  assert.deepEqual(spelling.getTypoRanges('wrold'), [[0, 5]])
  spelling.dispose()
})

test('non-prose ranges are dropped before they are cached', async () => {
  const backend = createBackend(async () => ({
    ranges: [[0, 5], [6, 9], [16, 3], [30, 4], [40, 5]],
  }))
  const spelling = createSpellingProvider({ backend, debounceMs: 1 })

  const line = 'wrold src/chat.js --rpg 1234 ok'
  assert.equal(spelling.getTypoRanges(line), undefined)
  await delay(20)
  // "wrold" is prose, the path/flag/digit ranges are not, and the last range
  // runs past the end of the line.
  assert.deepEqual(spelling.getTypoRanges(line), [[0, 5]])
  spelling.dispose()
})

test('uncheckable lines and oversized buffers never spawn', async () => {
  const backend = createBackend()
  const spelling = createSpellingProvider({ backend, debounceMs: 1 })

  assert.equal(spelling.getTypoRanges(''), undefined)
  assert.equal(spelling.getTypoRanges('   '), undefined)
  assert.equal(spelling.getTypoRanges('/settings typo on'), undefined)
  assert.equal(spelling.getTypoRanges('a'.repeat(MAX_LINE_LENGTH + 1)), undefined)
  assert.equal(spelling.getTypoRanges('wrold', MAX_BUFFER_LENGTH + 1), undefined)
  await delay(20)
  assert.equal(backend.calls.length, 0)
  spelling.dispose()
})

test('setFeatures gates live toggling', async () => {
  const backend = createBackend()
  const features = { typoDetection: true, autocomplete: true, autocorrect: false }
  const spelling = createSpellingProvider({ backend, features, debounceMs: 1 })

  spelling.setFeatures({ typoDetection: false })
  assert.equal(features.typoDetection, false)
  assert.equal(spelling.getTypoRanges('hello wrold'), undefined)
  await delay(20)
  assert.equal(backend.calls.length, 0, 'a disabled feature never spawns')

  spelling.setFeatures({ typoDetection: true, autocorrect: true })
  assert.equal(features.typoDetection, true)
  assert.equal(features.autocorrect, true)
  spelling.getTypoRanges('hello wrold')
  await delay(20)
  assert.equal(backend.calls.length, 1)
  spelling.dispose()
})

test('dispose clears the timer, aborts the child and silences the repaint', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async (request) => {
    if (request.text === 'wrold one') await gate
    return { ranges: [] }
  })
  const spelling = createSpellingProvider({ backend, debounceMs: 5, onUpdate: () => {} })
  let repaints = 0
  spelling.onUpdate = () => { repaints += 1 }

  spelling.getTypoRanges('wrold one')
  await delay(20)
  assert.equal(backend.calls.length, 1)
  spelling.getTypoRanges('wrold two')

  spelling.dispose()
  assert.equal(spelling.onUpdate, null)
  assert.equal(backend.calls[0].signal.aborted, true, 'the in-flight call is aborted')
  assert.equal(spelling.getTypoRanges('wrold one'), undefined, 'a disposed provider is inert')

  release()
  await delay(20)
  assert.equal(backend.calls.length, 1, 'the pending debounce is dropped')
  assert.equal(repaints, 0)
})

test('failure of the repaint callback is not counted as a backend failure', async () => {
  const backend = createBackend(async () => ({ ranges: [[0, 5]] }))
  const spelling = createSpellingProvider({
    backend,
    debounceMs: 1,
    onUpdate: () => { throw new Error('repaint blew up') },
  })

  spelling.getTypoRanges('wrold')
  await delay(20)
  assert.deepEqual(spelling.getTypoRanges('wrold'), [[0, 5]], 'a repaint throw is swallowed')
  spelling.dispose()
})

test('a result-triggered repaint cannot spawn a second check for the same pass', async () => {
  const backend = createBackend(async () => ({ ranges: [] }))
  const seen = []
  let spelling = null
  spelling = createSpellingProvider({
    backend,
    debounceMs: 5,
    onUpdate: () => seen.push(spelling.getTypoRanges('wrold')),
  })

  spelling.getTypoRanges('wrold')
  await delay(40)

  assert.equal(backend.calls.length, 1, 'the repaint re-reads the cached line instead of re-requesting it')
  assert.deepEqual(seen, [[]], 'the landed result repaints exactly once')
  spelling.dispose()
})

test('the cache is bounded, so the oldest line is evicted and checked again', async () => {
  const backend = createBackend(async () => ({ ranges: [] }))
  const spelling = createSpellingProvider({ backend, debounceMs: 1, maxCacheEntries: 3 })
  assert.equal(spelling.maxCheckedLines, 3, 'the editor bound follows the cache capacity')

  for (const line of ['wrold one', 'wrold two', 'wrold three']) {
    assert.equal(spelling.getTypoRanges(line), undefined)
    await delay(10)
  }
  assert.equal(backend.calls.length, 3)

  assert.equal(spelling.getTypoRanges('wrold four'), undefined)
  await delay(10)
  assert.deepEqual(spelling.getTypoRanges('wrold four'), [])
  assert.equal(spelling.getTypoRanges('wrold one'), undefined, 'the oldest line left the cache')
  spelling.dispose()
})

test('an explicit re-enable retries the failure latch', async () => {
  let failing = true
  const backend = createBackend(async () => {
    if (failing) throw new Error('osascript died')
    return { ranges: [[0, 5]] }
  })
  const spelling = createSpellingProvider({ backend, debounceMs: 1 })

  for (const line of ['wrold one', 'wrold two', 'wrold three']) {
    spelling.getTypoRanges(line)
    await delay(10)
  }
  assert.equal(backend.calls.length, 3)
  spelling.getTypoRanges('wrold four')
  await delay(10)
  assert.equal(backend.calls.length, 3, 'three failures latched the feature off')

  failing = false
  spelling.setFeatures({ typoDetection: true })
  assert.equal(spelling.getTypoRanges('wrold five'), undefined)
  await delay(10)
  assert.equal(backend.calls.length, 4, 'the explicit enable retried the backend')
  assert.deepEqual(spelling.getTypoRanges('wrold five'), [[0, 5]])
  spelling.dispose()
})

test('off darwin the platform provider is a complete no-op', () => {
  for (const platform of ['linux', 'win32', 'freebsd']) {
    assert.equal(createPlatformSpellingProvider({ platform, features: {} }), null)
  }
})

test('on darwin the platform provider exposes the provider contract', () => {
  const provider = createPlatformSpellingProvider({ platform: 'darwin', features: { typoDetection: true } })
  assert.equal(typeof provider.getTypoRanges, 'function')
  assert.equal(typeof provider.setFeatures, 'function')
  assert.equal(typeof provider.dispose, 'function')
  assert.equal(provider.onUpdate, null)
  // Dispose without ever asking: nothing was spawned, so this is a plain no-op.
  provider.dispose()
})
