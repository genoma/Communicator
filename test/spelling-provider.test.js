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

test('a completion is requested word-aligned and answered from the cache', async () => {
  const backend = createBackend(async () => ({ words: ['reconciliation', 'reconnect'] }))
  const spelling = createSpellingProvider({ backend, features: { autocomplete: true }, debounceMs: 1 })
  const lines = ['please recon']

  assert.equal(spelling.getWordCompletion(lines, 0, 12), null, 'pending until the debounce runs')
  assert.equal(spelling.getWordCompletion(lines, 0, 12), null, 'a repaint before the result never spawns twice')
  await delay(20)

  assert.equal(spelling.getWordCompletion(lines, 0, 12), 'ciliation')
  assert.deepEqual(backend.calls.map((c) => c.request), [
    { op: 'completions', text: 'please recon', location: 7, length: 5 },
  ])
  assert.equal(spelling.getWordCompletion(lines, 0, 12), 'ciliation', 'a cached suffix is not re-spawned')
  assert.equal(backend.calls.length, 1)
  spelling.dispose()
})

test('a word the dictionary cannot extend is cached as a silent negative', async () => {
  const updates = []
  const backend = createBackend(async () => ({ words: ['worldly'] }))
  const spelling = createSpellingProvider({
    backend,
    features: { autocomplete: true },
    debounceMs: 1,
    onUpdate: () => updates.push('paint'),
  })
  const lines = ['please recon']

  assert.equal(spelling.getWordCompletion(lines, 0, 12), null)
  await delay(20)
  assert.equal(spelling.getWordCompletion(lines, 0, 12), null, 'the negative result is cached')
  assert.equal(backend.calls.length, 1, 'asked once, never again')
  assert.deepEqual(updates, [], 'a negative result is silent')
  spelling.dispose()
})

test('a completion must extend the typed word and stay on a single line', async () => {
  const words = { Recon: ['reconciled'], recon: ['recon', 'preconceive'], wrold: ['wrold\n'] }
  const backend = createBackend(async (request) => ({ words: words[request.text] ?? [] }))
  const spelling = createSpellingProvider({ backend, features: { autocomplete: true }, debounceMs: 1 })

  const ask = async (text) => {
    const lines = [text]
    const col = text.length
    const immediate = spelling.getWordCompletion(lines, 0, col)
    if (immediate !== null) return immediate
    await delay(20)
    return spelling.getWordCompletion(lines, 0, col)
  }

  assert.equal(await ask('Recon'), 'ciled', 'the prefix match is case-insensitive')
  assert.equal(await ask('recon'), null, 'a completion must be longer than the typed word')
  assert.equal(await ask('wrold'), null, 'a suffix with a control character is dropped')
  spelling.dispose()
})

test('no completion is asked for a caret that cannot end a prose word', async () => {
  const backend = createBackend(async () => ({ words: ['reconciliation'] }))
  const spelling = createSpellingProvider({ backend, features: { autocomplete: true }, debounceMs: 1 })

  assert.equal(spelling.getWordCompletion(['say reconx rest'], 0, 9), null, 'the caret sits inside a word')
  assert.equal(spelling.getWordCompletion(['x'], 0, 1), null, 'a one-character word is not completed')
  assert.equal(spelling.getWordCompletion(['say reconX'], 0, 10), null, 'camelCase is not prose')
  assert.equal(spelling.getWordCompletion(['say 12recon'], 0, 10), null, 'a digit is not prose')
  assert.equal(spelling.getWordCompletion(['/settings recon'], 0, 15), null, 'a command line is never completed')
  assert.equal(spelling.getWordCompletion(['recon'], 0, 6), null, 'a column past the line')
  await delay(20)
  assert.equal(backend.calls.length, 0, 'no completion is spawned for a caret that cannot be completed')
  spelling.dispose()
})

test('replacements are looked up only for the flagged word at the caret', async () => {
  const backend = createBackend(async (request) =>
    request.op === 'check' ? { ranges: [[6, 5]] } : { words: ['world', 'word'] }
  )
  const spelling = createSpellingProvider({ backend, features: { typoDetection: true }, debounceMs: 1 })
  const guesses = () => backend.calls.filter((c) => c.request.op === 'guesses')

  assert.equal(await spelling.getWordReplacements(['hello wrold'], 0, 5), null, 'before the flagged range')
  assert.equal(await spelling.getWordReplacements(['hello wrold'], 0, 12), null, 'a column past the line')
  assert.equal(await spelling.getWordReplacements(['hello wrolds'], 0, 12), null, 'one past the end without a boundary character')
  assert.equal(await spelling.getWordReplacements(['hello wrold'], 1, 11), null, 'a row that does not exist')
  assert.equal(guesses().length, 0, 'a non-qualifying caret never spawns a lookup')

  const spaced = await spelling.getWordReplacements(['hello wrold '], 0, 12)
  assert.deepEqual(spaced, { line: 0, startCol: 6, endCol: 11, items: ['world', 'word'] })
  assert.deepEqual(guesses()[0].request, { op: 'guesses', text: 'hello wrold ', location: 6, length: 5 })

  const punctuated = await spelling.getWordReplacements(['hello wrold!'], 0, 12)
  assert.equal(punctuated.endCol, 11, 'a sentence boundary also counts as the caret word')
  assert.equal(guesses().length, 2)
  spelling.dispose()
})

test('replacement items are deduped, single-line and capped', async () => {
  const words = ['word0', 'broken\nword', '', ...Array.from({ length: 14 }, (_, i) => `word${i}`)]
  const backend = createBackend(async (request) =>
    request.op === 'check' ? { ranges: [[0, 5]] } : { words }
  )
  const spelling = createSpellingProvider({ backend, features: { typoDetection: true }, debounceMs: 1 })

  const result = await spelling.getWordReplacements(['wrold'], 0, 2)
  assert.equal(result.items.length, 10, 'the list is capped')
  assert.deepEqual(result.items.slice(0, 2), ['word0', 'word1'], 'duplicates and blanks are dropped')
  assert.ok(!result.items.includes('broken\nword'), 'a multi-line word is dropped')
  spelling.dispose()
})

test('the word ops are gated by their own feature flag', async () => {
  const backend = createBackend(async () => ({ words: ['world'] }))
  const spelling = createSpellingProvider({
    backend,
    features: { typoDetection: false, autocomplete: false },
    debounceMs: 1,
  })

  assert.equal(await spelling.getWordReplacements(['hello wrold'], 0, 8), null)
  assert.equal(spelling.getWordCompletion(['please recon'], 0, 12), null)
  await delay(20)
  assert.equal(backend.calls.length, 0)
  spelling.dispose()
})

test('a replacement lookup whose line changed while waiting resolves null', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async (request) => {
    if (request.op === 'check') await gate
    return request.op === 'check' ? { ranges: [[6, 5]] } : { words: ['world'] }
  })
  const spelling = createSpellingProvider({ backend, features: { typoDetection: true }, debounceMs: 1 })
  const lines = ['hello wrold']

  const pending = spelling.getWordReplacements(lines, 0, 11)
  await delay(5)
  lines[0] = 'hello world'
  release()

  assert.equal(await pending, null, 'the edited line drops the stale lookup')
  spelling.dispose()
})

test('dispose resolves a pending lookup with null and aborts the child', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async (request, _call, options) => {
    if (request.op === 'check') {
      // Mirror the real backend: an aborted call rejects instead of resolving.
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        gate.then(resolve)
      })
    }
    return { ranges: [[6, 5]] }
  })
  const spelling = createSpellingProvider({ backend, features: { typoDetection: true }, debounceMs: 1 })

  const pending = spelling.getWordReplacements(['hello wrold'], 0, 11)
  await delay(5)
  assert.equal(backend.calls.length, 1)

  spelling.dispose()
  assert.equal(backend.calls[0].signal.aborted, true, 'the in-flight child is aborted')
  assert.equal(await pending, null, 'the awaiting caller is not left hanging')
  release()
})

test('a newer completion request replaces the debounced one', async () => {
  const backend = createBackend(async () => ({ words: ['reconciliation'] }))
  const spelling = createSpellingProvider({ backend, features: { autocomplete: true }, debounceMs: 5 })

  assert.equal(spelling.getWordCompletion(['say recon'], 0, 9), null)
  assert.equal(spelling.getWordCompletion(['say reconc'], 0, 10), null)
  await delay(30)

  assert.deepEqual(backend.calls.map((c) => c.request.text), ['say reconc'])
  spelling.dispose()
})

test('an explicit enable of any feature retries the failure latch', async () => {
  const backend = createBackend(async () => {
    throw new Error('osascript died')
  })
  const spelling = createSpellingProvider({
    backend,
    features: { typoDetection: true, autocomplete: true },
    debounceMs: 1,
  })

  for (const line of ['wrold one', 'wrold two', 'wrold three']) {
    spelling.getTypoRanges(line)
    await delay(10)
  }
  assert.equal(backend.calls.length, 3)
  spelling.getWordCompletion(['please recon'], 0, 12)
  await delay(10)
  assert.equal(backend.calls.length, 3, 'the latch closes every op, not just checks')

  spelling.setFeatures({ autocomplete: true })
  spelling.getWordCompletion(['please recon'], 0, 12)
  await delay(10)
  assert.equal(backend.calls.length, 4, 'autocomplete on retries the latch too')
  spelling.dispose()
})

test('a queued completion starts before a queued check', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async () => {
    if (backend.calls.length === 1) await gate
    return { words: ['reconciliation'], ranges: [] }
  })
  const spelling = createSpellingProvider({
    backend,
    features: { typoDetection: true, autocomplete: true },
    debounceMs: 1,
  })

  spelling.getTypoRanges('line A wrold')
  await delay(20)
  assert.equal(backend.calls.length, 1, 'the first check is in flight')

  spelling.getTypoRanges('line B wrold')
  spelling.getWordCompletion(['please recon'], 0, 12)
  await delay(20)
  release()
  await delay(40)

  assert.deepEqual(backend.calls.map((c) => c.request.op), ['check', 'completions', 'check'], 'the completion outranks the check')
  spelling.dispose()
})

test('a feature toggle drops its queued jobs and resolves their callers', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async () => {
    if (backend.calls.length === 1) await gate
    return { ranges: [[6, 5]] }
  })
  const spelling = createSpellingProvider({ backend, features: { typoDetection: true }, debounceMs: 1 })
  const lines = ['hello wrold']

  spelling.getTypoRanges('line A wrold')
  await delay(20)
  const pending = spelling.getWordReplacements(lines, 0, 11)
  await delay(5)
  spelling.setFeatures({ typoDetection: false })
  release()

  assert.equal(await pending, null, 'the queued lookup resolves instead of hanging')
  spelling.dispose()
})

test('a correction is asked for the completed word and covers word plus boundary', async () => {
  const backend = createBackend(async () => ({ correction: 'world' }))
  const spelling = createSpellingProvider({ backend, features: { autocorrect: true }, debounceMs: 1 })

  const result = await spelling.getAutocorrection(['hello wrold '], 0, 12)
  assert.deepEqual(backend.calls.map((c) => c.request), [
    { op: 'correction', text: 'hello wrold ', location: 6, length: 5 },
  ])
  assert.deepEqual(result, { startCol: 6, endCol: 12, insert: 'world ' }, 'the boundary the user typed is part of the edit')
  assert.deepEqual(await spelling.getAutocorrection(['hello wrold.'], 0, 12), { startCol: 6, endCol: 12, insert: 'world.' })
  spelling.dispose()
})

test('autocorrect is not asked for a caret that did not complete a prose word', async () => {
  const backend = createBackend(async () => ({ correction: 'world' }))
  const spelling = createSpellingProvider({ backend, features: { autocorrect: true }, debounceMs: 1 })

  assert.equal(await spelling.getAutocorrection(['hello wrold'], 0, 11), null, 'no boundary character')
  assert.equal(await spelling.getAutocorrection(['hello wrold '], 0, 11), null, 'the caret sits before the boundary')
  assert.equal(await spelling.getAutocorrection(['hello wrold '], 1, 12), null, 'a row that does not exist')
  assert.equal(await spelling.getAutocorrection(['hello wrold '], 0, 13), null, 'a column past the line')
  assert.equal(await spelling.getAutocorrection(['hello wrold '], 0, 0), null, 'the start of the line')
  assert.equal(await spelling.getAutocorrection(['src/wrold '], 0, 10), null, 'a path is not prose')
  assert.equal(await spelling.getAutocorrection(['--wrold '], 0, 8), null, 'a flag is not prose')
  assert.equal(await spelling.getAutocorrection(['/wrold '], 0, 7), null, 'a command line is never corrected')
  assert.equal(await spelling.getAutocorrection(['a'.repeat(MAX_LINE_LENGTH + 1) + ' '], 0, MAX_LINE_LENGTH + 2), null, 'an over-long line')
  assert.equal(await spelling.getAutocorrection(['wrold ', 'a'.repeat(MAX_BUFFER_LENGTH)], 0, 6), null, 'an oversized buffer')
  assert.equal(backend.calls.length, 0, 'a non-qualifying caret never spawns a correction')
  spelling.dispose()
})

test('an unusable correction reply is never applied', async () => {
  let reply = {}
  const backend = createBackend(async () => reply)
  const spelling = createSpellingProvider({ backend, features: { autocorrect: true }, debounceMs: 1 })
  const ask = () => spelling.getAutocorrection(['hello wrold '], 0, 12)

  assert.equal(await ask(), null, 'a reply with no correction key')
  reply = { correction: null }
  assert.equal(await ask(), null, 'a null correction')
  reply = { correction: '' }
  assert.equal(await ask(), null, 'an empty correction')
  reply = { correction: 'wrold' }
  assert.equal(await ask(), null, 'the word the user already typed')
  reply = { correction: 'world\n' }
  assert.equal(await ask(), null, 'a correction carrying a line break')
  reply = { correction: 'new york' }
  assert.equal(await ask(), null, 'a correction carrying whitespace')
  reply = { correction: 'World' }
  assert.deepEqual(await ask(), { startCol: 6, endCol: 12, insert: 'World ' }, 'the comparison is case-sensitive')
  assert.equal(backend.calls.length, 7, 'every reply in the list was really asked')
  spelling.dispose()
})

test('autocorrect is gated by its own feature flag and is opt-in', async () => {
  const backend = createBackend(async () => ({ correction: 'world' }))
  const off = createSpellingProvider({ backend, features: { autocorrect: false }, debounceMs: 1 })
  assert.equal(await off.getAutocorrection(['hello wrold '], 0, 12), null)

  const unset = createSpellingProvider({ backend, features: {}, debounceMs: 1 })
  assert.equal(await unset.getAutocorrection(['hello wrold '], 0, 12), null, 'an unset flag can never edit the buffer')
  await delay(20)
  assert.equal(backend.calls.length, 0, 'a feature that is not on never spawns')
  off.dispose()
  unset.dispose()
})

test('a correction whose line changed while waiting resolves null', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async () => {
    await gate
    return { correction: 'world' }
  })
  const spelling = createSpellingProvider({ backend, features: { autocorrect: true }, debounceMs: 1 })
  const lines = ['hello wrold ']

  const pending = spelling.getAutocorrection(lines, 0, 12)
  await delay(5)
  lines[0] = 'hello wrold x'
  release()

  assert.equal(await pending, null, 'the edited line drops the stale correction')
  spelling.dispose()
})

test('an in-flight correction is dropped when the feature is turned off', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async () => {
    await gate
    return { correction: 'world' }
  })
  const spelling = createSpellingProvider({ backend, features: { autocorrect: true }, debounceMs: 1 })

  const pending = spelling.getAutocorrection(['hello wrold '], 0, 12)
  await delay(5)
  spelling.setFeatures({ autocorrect: false })
  release()

  assert.equal(await pending, null, 'the correction never lands once the feature is off')
  spelling.dispose()
})

test('turning autocorrect off drops a queued correction', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async (request) => {
    if (request.op === 'check') await gate
    return request.op === 'correction' ? { correction: 'world' } : { ranges: [] }
  })
  const spelling = createSpellingProvider({
    backend,
    features: { typoDetection: true, autocorrect: true },
    debounceMs: 1,
  })

  spelling.getTypoRanges('line A wrold')
  await delay(20)
  assert.equal(backend.calls.length, 1, 'the check holds the single child slot')
  const pending = spelling.getAutocorrection(['hello wrold '], 0, 12)
  await delay(5)
  assert.equal(backend.calls.length, 1, 'the correction is queued behind it')

  spelling.setFeatures({ autocorrect: false })
  release()

  assert.equal(await pending, null, 'the queued correction resolves instead of hanging')
  await delay(20)
  assert.equal(backend.calls.filter((c) => c.request.op === 'correction').length, 0, 'and it is never spawned')
  spelling.dispose()
})

test('dispose resolves a pending correction with null and aborts the child', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async (_request, _call, options) => {
    // Mirror the real backend: an aborted call rejects instead of resolving.
    await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      gate.then(resolve)
    })
    return { correction: 'world' }
  })
  const spelling = createSpellingProvider({ backend, features: { autocorrect: true }, debounceMs: 1 })

  const pending = spelling.getAutocorrection(['hello wrold '], 0, 12)
  await delay(5)
  assert.equal(backend.calls.length, 1)

  spelling.dispose()
  assert.equal(backend.calls[0].signal.aborted, true, 'the in-flight child is aborted')
  assert.equal(await pending, null, 'the awaiting caller is not left hanging')
  release()
})

test('a quoted word is corrected without touching its quotes', async () => {
  const backend = createBackend(async (request) =>
    request.op === 'correction' ? { correction: 'world' } : { ranges: [] }
  )
  const spelling = createSpellingProvider({ backend, features: { autocorrect: true }, debounceMs: 1 })

  const quoted = "he said 'wrold "
  assert.deepEqual(await spelling.getAutocorrection([quoted], 0, quoted.length), {
    startCol: 9,
    endCol: quoted.length,
    insert: 'world ',
  })
  assert.deepEqual(backend.calls[0].request, { op: 'correction', text: quoted, location: 9, length: 5 })

  // A closing quote sits between the word and the boundary: the range still
  // starts at the word and the quote is written back after the correction.
  const both = "he said 'wrold' "
  assert.deepEqual(await spelling.getAutocorrection([both], 0, both.length), {
    startCol: 9,
    endCol: both.length,
    insert: "world' ",
  })
  assert.deepEqual(backend.calls[1].request, { op: 'correction', text: both, location: 9, length: 5 })
  spelling.dispose()
})

test('a correction carrying nothing but quotes is never applied', async () => {
  const backend = createBackend(async () => ({ correction: 'world' }))
  const spelling = createSpellingProvider({ backend, features: { autocorrect: true }, debounceMs: 1 })

  assert.equal(await spelling.getAutocorrection(["he said '' "], 0, 10), null)
  await delay(10)
  assert.equal(backend.calls.length, 0, 'a word of quotes alone is not a word')
  spelling.dispose()
})

test('a queued correction starts before a queued check', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const backend = createBackend(async (request) => {
    if (backend.calls.length === 1) await gate
    return request.op === 'correction' ? { correction: 'world' } : { ranges: [] }
  })
  const spelling = createSpellingProvider({
    backend,
    features: { typoDetection: true, autocorrect: true },
    debounceMs: 1,
  })

  spelling.getTypoRanges('line A wrold')
  await delay(20)
  assert.equal(backend.calls.length, 1, 'the first check is in flight')

  spelling.getTypoRanges('line B wrold')
  const correction = spelling.getAutocorrection(['hello wrold '], 0, 12)
  await delay(20)
  release()
  await delay(40)

  assert.deepEqual(backend.calls.map((c) => c.request.op), ['check', 'correction', 'check'], 'the correction outranks the check')
  assert.deepEqual(await correction, { startCol: 6, endCol: 12, insert: 'world ' })
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
  assert.equal(typeof provider.getWordCompletion, 'function')
  assert.equal(typeof provider.getWordReplacements, 'function')
  assert.equal(typeof provider.getAutocorrection, 'function')
  assert.equal(typeof provider.setFeatures, 'function')
  assert.equal(typeof provider.dispose, 'function')
  assert.equal(provider.maxCheckedLines, 256)
  assert.equal(provider.onUpdate, null)
  // Dispose without ever asking: nothing was spawned, so this is a plain no-op.
  provider.dispose()
})
