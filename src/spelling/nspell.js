// Portable spelling backend for every platform without a system checker:
// nspell over a pure-JS English dictionary, loaded lazily on the first request.
// It answers the same `run(request, { signal })` contract as the macOS
// backends, so src/spelling/index.js can select it without another seam.
// nspell checks word-aligned ranges only, so the tokenizer lives here: it walks
// the line once and reports the tokens the dictionary rejects in code units,
// and the provider's mask decides which of those ranges are prose.
const WORD_TOKEN = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu

const loadEnglishDictionary = async () => {
  const [{ default: nspell }, { default: dictionary }] = await Promise.all([import('nspell'), import('dictionary-en')])
  return nspell(dictionary)
}

/** The `[[start, span], ...]` code-unit ranges of the tokens the dictionary rejects */
function rejectedTokens(spell, text) {
  if (typeof text !== 'string') return []
  const ranges = []
  for (const match of text.matchAll(WORD_TOKEN)) {
    if (!spell.correct(match[0])) ranges.push([match.index, match[0].length])
  }
  return ranges
}

/** The word a word-scoped request asks about, or '' for a request without a usable range */
function requestedWord(request) {
  const { text, location, length } = request
  if (typeof text !== 'string' || !Number.isInteger(location) || !Number.isInteger(length)) return ''
  return text.slice(location, location + length)
}

/**
 * nspell ranks a one-character replacement above an adjacent transposition, so
 * "teh" suggests "ten" before "the". A swap the dictionary accepts AND the
 * engine itself suggests is a certain typo fix: it is the only correction this
 * backend applies, and it leads the replacement list. Everything else stays a
 * suggestion the user picks explicitly.
 */
function swappedSuggestion(spell, word, suggestions) {
  for (let i = 0; i + 1 < word.length; i += 1) {
    const candidate = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2)
    if (suggestions.includes(candidate) && spell.correct(candidate)) return candidate
  }
  return null
}

export function createNspellBackend({ loadDictionary = loadEnglishDictionary } = {}) {
  let loaded = null

  // The 0.6 MB dictionary is parsed once, on the first request. A failed load
  // is not cached: the next request retries instead of answering an empty
  // success the provider would cache as a clean line.
  const load = () => {
    if (loaded === null) {
      loaded = Promise.resolve()
        .then(() => loadDictionary())
        .catch((error) => {
          loaded = null
          throw new Error(`spelling dictionary unavailable: ${error instanceof Error ? error.message : String(error)}`)
        })
    }
    return loaded
  }

  return {
    async run(request) {
      if (request.op === 'completions') return { words: [] }
      const spell = await load()
      if (request.op === 'check') return { ranges: rejectedTokens(spell, request.text) }
      const word = requestedWord(request)
      if (request.op === 'guesses') {
        const suggestions = spell.suggest(word)
        const swapped = swappedSuggestion(spell, word, suggestions)
        return { words: swapped ? [swapped, ...suggestions.filter((item) => item !== swapped)] : suggestions }
      }
      if (request.op === 'correction') {
        return { correction: spell.correct(word) ? null : swappedSuggestion(spell, word, spell.suggest(word)) }
      }
      throw new Error(`unknown spelling op: ${request.op}`)
    },
  }
}
