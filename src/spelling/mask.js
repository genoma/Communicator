// Prose masking for the spelling provider: which checked words may be
// underlined. Flags, paths, urls, model ids, code and emoji must never be
// flagged — the spell checker has no idea what they are, it only knows they are
// not in a dictionary (npm, openai). Italian and Russian prose is left to the
// checker (see jxa.js).
const CODEISH_CHARACTERS = /[\\/@_=:{}[\]<>]/u
const UNPROSE_CHARACTERS = /[.~$%#]/u
const DIGIT = /\d/u
const CAMEL_CASE = /\p{Ll}\p{Lu}/u
const LETTER = /\p{L}/u
const WHITESPACE = /\s/u
// Sentence punctuation is not a code marker: "teh." at the end of a sentence is
// still a typo ("github.com" keeps its inner dot and stays rejected).
const TRAILING_PUNCTUATION = /[.,!?;:'"»”’)\]}…]+$/u
const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]*/u

export const MAX_LINE_LENGTH = 1000
export const MAX_BUFFER_LENGTH = 20000

/** True when a whole token may be spell-checked as prose */
export function isProseWord(token) {
  if (typeof token !== 'string' || token === '') return false
  const word = token.replace(TRAILING_PUNCTUATION, '')
  if (word === '' || !LETTER.test(word)) return false
  if (CODEISH_CHARACTERS.test(word) || UNPROSE_CHARACTERS.test(word)) return false
  if (DIGIT.test(word) || CAMEL_CASE.test(word)) return false
  const leading = word.match(LEADING_PUNCTUATION)[0]
  return !leading.includes('-') && !leading.includes('+')
}

/**
 * True when the checker's range at [start, end) sits in a prose token. The
 * checker reports word-aligned ranges that can still belong to a longer
 * code-ish token (`--rpg` is reported as `rpg`, `src/chat.js` as `chat.js`), so
 * the whitespace-delimited token around the range decides.
 */
export function isProseRange(line, start, end) {
  let from = start
  let to = end
  while (from > 0 && !WHITESPACE.test(line[from - 1])) from -= 1
  while (to < line.length && !WHITESPACE.test(line[to])) to += 1
  return isProseWord(line.slice(from, to))
}

/** True when a prompt line is worth handing to the spell checker at all */
export function isCheckableLine(line) {
  if (typeof line !== 'string' || line.length > MAX_LINE_LENGTH) return false
  const trimmed = line.trim()
  return trimmed !== '' && !trimmed.startsWith('/')
}
