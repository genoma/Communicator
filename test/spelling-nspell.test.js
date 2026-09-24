// The portable spelling backend (Linux/Windows): nspell over the English
// dictionary, answering the same `run(request, { signal })` contract as the
// macOS backends. The real dictionary is data shipped in node_modules, so these
// cases stay hermetic — no spawn, no compiler, no network, no API key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNspellBackend } from '../src/spelling/nspell.js'
import { createSpellingProvider } from '../src/spelling/provider.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// One dictionary instance for the cases that need the real English data; it
// loads lazily on the first request and is memoized after that.
const english = createNspellBackend()

const fakeDictionary = (accepted) => ({
  correct: (word) => accepted.has(word),
  suggest: () => [],
})

// The provider debounces a check and caches the mask-filtered ranges: poll
// until that result landed, like the provider suite does with its fake backend.
async function checkedRanges(spelling, line) {
  for (let i = 0; i < 200; i += 1) {
    const ranges = spelling.getTypoRanges(line)
    if (ranges !== undefined) return ranges
    await delay(5)
  }
  throw new Error(`the check for ${JSON.stringify(line)} never landed`)
}

test('check reports the dictionary-rejected words as code-unit ranges', async () => {
  assert.deepEqual(await english.run({ op: 'check', text: 'The quick brown fox wrold over teh lazy dog' }), {
    ranges: [[20, 5], [31, 3]],
  })
})

test('a non-ASCII word before the typo keeps the typo range on code units', async () => {
  const backend = createNspellBackend({ loadDictionary: async () => fakeDictionary(new Set(['città'])) })
  assert.deepEqual(await backend.run({ op: 'check', text: 'città wrold' }), { ranges: [[6, 5]] })
})

test('an emoji before the word keeps the token range on code units', async () => {
  const backend = createNspellBackend({ loadDictionary: async () => fakeDictionary(new Set()) })
  assert.deepEqual(await backend.run({ op: 'check', text: '😀 teh' }), { ranges: [[3, 3]] })
})

test('a token carries its internal apostrophe, a hyphenated token splits', async () => {
  assert.deepEqual(await english.run({ op: 'check', text: "don't" }), { ranges: [] })
  assert.deepEqual(await english.run({ op: 'check', text: 'deepseek-chat' }), { ranges: [[0, 8]] })
  assert.deepEqual(await english.run({ op: 'check', text: "it's wrold's" }), { ranges: [[5, 7]] })
})

test('a quoted typo reports the word alone, like the macOS backend', async () => {
  assert.deepEqual(await english.run({ op: 'check', text: "he said 'wrold' today" }), { ranges: [[9, 5]] })
})

test('the provider keeps only the portable ranges that are prose', async () => {
  const spelling = createSpellingProvider({ backend: english, features: { typoDetection: true }, debounceMs: 1 })

  assert.deepEqual((await english.run({ op: 'check', text: 'wrold src/chat.js --rpg' })).ranges, [[0, 5], [6, 3], [15, 2], [20, 3]])
  assert.deepEqual((await english.run({ op: 'check', text: 'https://example.com/a?b=1' })).ranges, [[0, 5]])
  assert.deepEqual(await checkedRanges(spelling, 'wrold src/chat.js --rpg'), [[0, 5]])
  assert.deepEqual(await checkedRanges(spelling, 'https://example.com/a?b=1'), [])
  assert.deepEqual(await checkedRanges(spelling, "he said 'wrold' today"), [[9, 14]])

  spelling.dispose()
})

test('guesses lead with the verified swap and correction applies only that swap', async () => {
  const guesses = await english.run({ op: 'guesses', text: 'teh', location: 0, length: 3 })
  assert.equal(guesses.words[0], 'the', 'the adjacent-swap fix leads the list')
  assert.ok(guesses.words.includes('ten'), 'the engine order is preserved behind it')
  assert.deepEqual(await english.run({ op: 'correction', text: 'teh ', location: 0, length: 3 }), { correction: 'the' })
  assert.deepEqual(await english.run({ op: 'correction', text: 'wrold ', location: 0, length: 5 }), { correction: 'world' })
  assert.deepEqual(await english.run({ op: 'correction', text: 'recieve ', location: 0, length: 7 }), { correction: 'receive' })
})

test('a typo without a verified swap gets no autocorrection', async () => {
  assert.deepEqual(await english.run({ op: 'correction', text: 'seperate ', location: 0, length: 8 }), { correction: null })
  const guesses = await english.run({ op: 'guesses', text: 'seperate', location: 0, length: 8 })
  assert.ok(guesses.words.includes('separate'), 'the replacement list still offers it')
})

test('smart-quoted contractions are one token, not a false typo', async () => {
  assert.deepEqual(await english.run({ op: 'check', text: 'it\u2019s fine, doesn\u2019t matter' }), { ranges: [] })
  assert.deepEqual(await english.run({ op: 'check', text: 'wrold\u2019s' }), { ranges: [[0, 7]] })
})

test('an aborted signal is ignored: the reply resolves for the provider to drop', async () => {
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await english.run({ op: 'check', text: 'wrold' }, { signal: controller.signal }), { ranges: [[0, 5]] })
})

test('completions answer without loading the dictionary', async () => {
  const backend = createNspellBackend({
    loadDictionary: async () => {
      throw new Error('must not be reached')
    },
  })
  assert.deepEqual(await backend.run({ op: 'completions', text: 'recon', location: 0, length: 5 }), { words: [] })
})

test('a correctly spelled word gets no correction', async () => {
  assert.deepEqual(await english.run({ op: 'correction', text: 'world ', location: 0, length: 5 }), { correction: null })
})

test('completions answer an empty list', async () => {
  assert.deepEqual(await english.run({ op: 'completions', text: 'recon', location: 0, length: 5 }), { words: [] })
})

test('the portable backend round-trips the replacement list and the autocorrection', async () => {
  const spelling = createSpellingProvider({
    backend: createNspellBackend(),
    features: { typoDetection: true, autocorrect: true },
    debounceMs: 1,
  })

  const replacements = await spelling.getWordReplacements(['teh '], 0, 3)
  assert.equal(replacements?.startCol, 0)
  assert.equal(replacements?.endCol, 3)
  assert.ok(replacements?.items.includes('the'))
  assert.deepEqual(await spelling.getAutocorrection(['recieve '], 0, 8), { startCol: 0, endCol: 8, insert: 'receive ' })

  spelling.dispose()
})

test('a dictionary that cannot load rejects instead of answering a clean line', async () => {
  const backend = createNspellBackend({
    loadDictionary: async () => {
      throw new Error('missing dictionary data')
    },
  })
  await assert.rejects(backend.run({ op: 'check', text: 'wrold' }), /spelling dictionary unavailable: missing dictionary data/)
  await assert.rejects(backend.run({ op: 'check', text: 'wrold' }), /spelling dictionary unavailable/)
})

test('a malformed request answers empty or rejects like the macOS backends', async () => {
  assert.deepEqual(await english.run({ op: 'check' }), { ranges: [] })
  assert.deepEqual(await english.run({ op: 'guesses' }), { words: [] })
  assert.deepEqual(await english.run({ op: 'correction' }), { correction: null })
  await assert.rejects(english.run({ op: 'nope' }), /unknown spelling op: nope/)
})
