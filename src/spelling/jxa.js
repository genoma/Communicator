// JXA program text for the macOS spelling backend (`osascript -l JavaScript`).
// The request travels as ONE JSON env var and the reply is a single JSON line
// on stdout: a stdin-driven helper never answers (verified), and argv is not
// reliably reachable from the JXA environment.
export const JXA_REQUEST_ENV = 'COMMUNICATOR_SPELLING'

// `check` passes a nil language on purpose: NSSpellChecker then consults the
// user's whole active dictionary set, so Italian/Russian prose stays unflagged
// while English typos are still caught (the explicit-English path flags every
// correctly spelled Italian word). The word-scoped operations (guesses /
// correction / completions, used from phase 2 on) must pass an explicit
// language instead — `completionsForPartialWordRange…` can hang for seconds on
// a nil language or a non-word-aligned range.
export const JXA_PROGRAM = `
ObjC.import('AppKit')
ObjC.import('Foundation')

// The nil-language scan only reports a hit for offset 0: a follow-up call with
// a non-zero startingAt answers NSNotFound, so the walk advances by re-checking
// the remaining SUBSTRING from 0 and rebasing the reported location.
function ranges(text) {
  const checker = $.NSSpellChecker.sharedSpellChecker
  const found = []
  let base = 0
  while (base < text.length) {
    const wordCount = Ref()
    const rest = text.substring(base)
    const range = checker.checkSpellingOfStringStartingAtLanguageWrapInSpellDocumentWithTagWordCount($(rest), 0, $(), false, 0, wordCount)
    const location = Number(range.location)
    const span = Number(range.length)
    if (span === 0) break
    found.push([base + location, span])
    base += location + span
  }
  return found
}

function words(list) {
  const out = []
  if (!list.isNil()) {
    for (let i = 0; i < list.count; i++) out.push(ObjC.unwrap(list.objectAtIndex(i)))
  }
  return out
}

function preferredLanguage() {
  const preferred = $.NSLocale.preferredLanguages
  if (preferred.count > 0) return preferred.objectAtIndex(0)
  return $.NSSpellChecker.sharedSpellChecker.language
}

function main() {
  const request = JSON.parse(ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('${JXA_REQUEST_ENV}')))
  const checker = $.NSSpellChecker.sharedSpellChecker
  if (request.op === 'check') {
    return { ranges: ranges(request.text) }
  }
  const text = $(request.text)
  const range = $.NSMakeRange(Number(request.location), Number(request.length))
  if (request.op === 'guesses') {
    return { words: words(checker.guessesForWordRangeInStringLanguageInSpellDocumentWithTag(range, text, preferredLanguage(), 0)) }
  }
  if (request.op === 'completions') {
    return { words: words(checker.completionsForPartialWordRangeInStringLanguageInSpellDocumentWithTag(range, text, preferredLanguage(), 0)) }
  }
  if (request.op === 'correction') {
    const fixed = checker.correctionForWordRangeInStringLanguageInSpellDocumentWithTag(range, text, preferredLanguage(), 0)
    return { correction: fixed.isNil() ? null : ObjC.unwrap(fixed) }
  }
  return { error: 'unknown op: ' + request.op }
}

let reply
try {
  reply = JSON.stringify(main())
} catch (err) {
  reply = JSON.stringify({ error: String(err) })
}
$.NSFileHandle.fileHandleWithStandardOutput.writeData($(reply + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
`.trim()
