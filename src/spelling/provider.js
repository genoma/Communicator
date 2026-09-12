// Platform-free spelling core. The macOS osascript backend is injected (see
// osascript.js), so the core is testable on any platform and can never spawn a
// child by itself. The feature object is shared with the caller: `setFeatures`
// merges into the same object `/settings` holds, so a toggle applies to the
// next request without a second source of truth.
import { MAX_BUFFER_LENGTH, isCheckableLine, isProseRange } from './mask.js'

const SPELLING_DEBOUNCE_MS = 250

const MAX_CACHE_ENTRIES = 256
const MAX_CONSECUTIVE_FAILURES = 3
const MAX_WORD_REPLACEMENTS = 10

// Every word this provider shows OR inserts (a replacement row, the ghost hint,
// the corrected word) has to stay on one line: one carrying whitespace or a
// control character would break the row and the grid arithmetic.
const SINGLE_LINE_WORD = /^[^\s\p{Cc}]+$/u
// The caret also counts as inside a flagged range one character past its end,
// when that character ends a sentence ("wrold" with the caret after the space).
// The same class is the boundary character that completes a word for
// autocorrect, so the two paths share one spelling of "sentence boundary".
const WORD_BOUNDARY = /[\s.,;:!?"\])}]/u
// The partial word ending at the caret, and the test for a caret that sits
// INSIDE a word, where the dictionary would complete something other than the
// word on screen.
const PARTIAL_WORD = /[\p{L}\p{M}']+$/u
const WORD_CONTINUATION = /^[\p{L}\p{M}']/u

// Job kinds, most urgent first: a replacement list the user waits on, then the
// caret-row completion, then the correction of the word a boundary character
// just completed, then the debounced typo check the grid repaints with.
const JOB_ORDER = ['guesses', 'completions', 'correction', 'check']

/** Keep only ranges that are inside the line and sit in prose */
function proseRanges(line, reported) {
  if (!Array.isArray(reported)) return []
  const ranges = []
  for (const entry of reported) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const start = Number(entry[0])
    const span = Number(entry[1])
    if (!Number.isInteger(start) || !Number.isInteger(span) || start < 0 || span <= 0) continue
    const end = start + span
    if (end > line.length) continue
    if (!isProseRange(line, start, end)) continue
    ranges.push([start, end])
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

/**
 * The line a word-scoped request is about, or null when it may not be checked:
 * the typo-check skip rules (a command line, an over-long line, an over-long
 * buffer) apply to guesses and completions too.
 */
function checkableLine(lines, row) {
  if (!Array.isArray(lines)) return null
  const line = lines[row]
  if (typeof line !== 'string' || !isCheckableLine(line)) return null
  let bufferLength = 0
  for (const entry of lines) bufferLength += (typeof entry === 'string' ? entry.length : 0) + 1
  if (bufferLength > MAX_BUFFER_LENGTH) return null
  return line
}

/** The deduped, single-line replacements of a `guesses` reply, capped like the list */
function replacementItems(words) {
  if (!Array.isArray(words)) return null
  const seen = new Set()
  const items = []
  for (const word of words) {
    if (typeof word !== 'string' || !SINGLE_LINE_WORD.test(word) || seen.has(word)) continue
    seen.add(word)
    items.push(word)
    if (items.length >= MAX_WORD_REPLACEMENTS) break
  }
  return items.length === 0 ? null : items
}

/** The suffix of the first completion that extends the typed word, or null */
function completionSuffix(prefix, words) {
  if (!Array.isArray(words)) return null
  const lowered = prefix.toLocaleLowerCase()
  for (const word of words) {
    if (typeof word !== 'string' || word.length <= prefix.length) continue
    if (!word.toLocaleLowerCase().startsWith(lowered)) continue
    const suffix = word.slice(prefix.length)
    if (SINGLE_LINE_WORD.test(suffix)) return suffix
  }
  return null
}

/**
 * `getTypoRanges(line, bufferLength)` answers with the cached ranges of a line
 * (`[[start, end], ...]`, code units in the source line) or `undefined` while a
 * check is pending — the grid paints plain until the async result lands.
 *
 * `getWordCompletion(lines, row, col)` answers with the cached completion
 * suffix for the word before the caret (or null while pending / when there is
 * nothing to complete) and `getWordReplacements(lines, row, col)` with the
 * replacement list of the flagged word at the caret; `getAutocorrection(lines,
 * row, col)` is the one lookup that edits the buffer, so it is strictly
 * opt-in. All three are word-scoped and behind their own feature gate.
 *
 * One child runs at a time for every kind, with one pending slot per kind
 * (a newer request of the same kind replaces the pending one) and every caller
 * holding a promise that resolves the reply's value or null when its request was
 * superseded, dropped or failed.
 */
export function createSpellingProvider({
  backend,
  features = {},
  onUpdate = null,
  debounceMs = SPELLING_DEBOUNCE_MS,
  maxCacheEntries = MAX_CACHE_ENTRIES,
} = {}) {
  const typoCache = new Map()
  const completionCache = new Map()
  const queue = new Map()
  let inFlight = null
  let disabled = false
  let failures = 0
  let disposed = false

  const notify = () => {
    if (disposed) return
    try {
      if (typeof provider.onUpdate === 'function') provider.onUpdate()
    } catch {
      // A repainting failure is not a backend failure.
    }
  }

  const remember = (cache, key, value) => {
    cache.set(key, value)
    if (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value)
  }

  /** Drop the queued jobs of the given kinds, resolving their callers with null */
  const dropQueued = (kinds = [...queue.keys()]) => {
    for (const kind of kinds) {
      const job = queue.get(kind)
      if (!job) continue
      if (job.timer) clearTimeout(job.timer)
      queue.delete(kind)
      job.resolve(null)
    }
  }

  /** Start the most urgent ready job; a job that is not ready yet waits its debounce */
  const flush = () => {
    if (disposed || disabled || inFlight !== null) return
    for (const kind of JOB_ORDER) {
      const job = queue.get(kind)
      if (!job || !job.ready) continue
      queue.delete(kind)
      void start(job)
      return
    }
  }

  const start = (job) => {
    const controller = new AbortController()
    const entry = { kind: job.kind, key: job.key, controller, promise: null }
    inFlight = entry
    entry.promise = (async () => {
      let value = null
      try {
        const reply = await backend.run(job.request(), { signal: controller.signal })
        if (!disposed && !disabled) {
          failures = 0
          value = job.read(reply)
        }
      } catch {
        if (!disposed && !disabled) {
          failures += 1
          // Three consecutive failures (a broken osascript, a hang killed by the
          // timeout) disable the feature for the session, silently.
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            disabled = true
            dropQueued()
          }
        }
      } finally {
        if (inFlight === entry) inFlight = null
        job.resolve(value)
        flush()
      }
      return value
    })()
    return entry.promise
  }

  /**
   * Queue one request under its kind: an identical pending or in-flight request
   * is shared instead of spawned twice, a different one takes the kind's single
   * pending slot (last-request-wins, the superseded caller resolving null), and
   * `delay` debounces the start without ever keeping the process alive past the
   * prompt.
   */
  const schedule = (kind, key, delay, { request, read }) => {
    if (disposed || disabled) return Promise.resolve(null)
    if (inFlight?.kind === kind && inFlight.key === key) return inFlight.promise
    const waiting = queue.get(kind)
    if (waiting?.key === key) return waiting.promise
    let resolve = null
    const promise = new Promise((settle) => {
      resolve = settle
    })
    const job = { kind, key, request, read, resolve, promise, ready: delay <= 0, timer: null }
    if (!job.ready) {
      job.timer = setTimeout(() => {
        job.timer = null
        job.ready = true
        flush()
      }, delay)
      job.timer.unref?.()
    }
    if (waiting) {
      if (waiting.timer) clearTimeout(waiting.timer)
      queue.delete(kind)
      waiting.resolve(null)
    }
    queue.set(kind, job)
    flush()
    return promise
  }

  const checkLine = (line, delay) =>
    schedule('check', line, delay, {
      request: () => ({ op: 'check', text: line }),
      read: (reply) => {
        const ranges = proseRanges(line, reply?.ranges)
        remember(typoCache, line, ranges)
        notify()
        return ranges
      },
    })

  /** Whether the line an async lookup was asked about is still the caller's line */
  const lineUnchanged = (lines, row, line) =>
    !disposed && !disabled && Array.isArray(lines) && lines[row] === line

  /** The phase-1/2 dirty guard: the line is unchanged and typo detection is on */
  const stillCurrent = (lines, row, line) => lineUnchanged(lines, row, line) && features.typoDetection !== false

  const provider = {
    onUpdate,
    // The editor bounds its per-paint request set to this many lines. A buffer
    // larger than the cache can never settle: each landed result evicts a line
    // another paint still asks about, so the spawn+repaint cycle would repeat
    // forever. The cache capacity is the invariant, so the two share one bound.
    maxCheckedLines: maxCacheEntries,

    getTypoRanges(line, bufferLength = 0) {
      if (disposed || disabled || features.typoDetection === false) return undefined
      if (!isCheckableLine(line) || bufferLength > MAX_BUFFER_LENGTH) return undefined
      const cached = typoCache.get(line)
      if (cached !== undefined) {
        // LRU: a re-read of the line that is being edited keeps it alive.
        typoCache.delete(line)
        typoCache.set(line, cached)
        return cached
      }
      void checkLine(line, debounceMs)
      return undefined
    },

    /**
     * The cached completion suffix of the prose word ending at `(row, col)`, or
     * null while the request is pending, when the caret does not end a prose
     * word of at least two characters, when the backend knows no completion or
     * when the feature is off. Asking also schedules the request, and a suffix
     * repaints the block when it lands.
     */
    getWordCompletion(lines, row, col) {
      if (disposed || disabled || features.autocomplete === false) return null
      const line = checkableLine(lines, row)
      if (line === null || col <= 0 || col > line.length) return null
      if (WORD_CONTINUATION.test(line.slice(col))) return null
      const match = PARTIAL_WORD.exec(line.slice(0, col))
      if (!match || match[0].length < 2) return null
      const start = col - match[0].length
      if (!isProseRange(line, start, col)) return null
      const prefix = match[0]
      const key = `${start}:${prefix}:${line}`
      if (completionCache.has(key)) {
        const cached = completionCache.get(key)
        // LRU: the caret row asks about the same word on every repaint.
        completionCache.delete(key)
        completionCache.set(key, cached)
        return cached
      }
      void schedule('completions', key, debounceMs, {
        request: () => ({ op: 'completions', text: line, location: start, length: prefix.length }),
        read: (reply) => {
          const suffix = completionSuffix(prefix, reply?.words)
          remember(completionCache, key, suffix)
          // A word the dictionary cannot extend is cached silently: there is
          // nothing new to paint.
          if (suffix !== null) notify()
          return suffix
        },
      })
      return null
    },

    /**
     * The replacement list of the flagged word at `(row, col)`:
     * `{ line, startCol, endCol, items }` where `line` is the row index, so the
     * caller can re-check the row after the await. Null when no flagged prose
     * word covers the caret, the feature is off, the reply was empty or the
     * caller's line changed while waiting (a newer `check` supersedes this one).
     */
    async getWordReplacements(lines, row, col) {
      if (disposed || disabled || features.typoDetection === false) return null
      const line = checkableLine(lines, row)
      if (line === null || col < 0 || col > line.length) return null
      let ranges = typoCache.get(line)
      if (ranges === undefined) ranges = await checkLine(line, 0)
      if (!stillCurrent(lines, row, line)) return null
      if (!ranges || ranges.length === 0) return null
      const range = ranges.find(
        ([start, end]) => col >= start && (col <= end || (col === end + 1 && WORD_BOUNDARY.test(line[end] ?? '')))
      )
      if (!range) return null
      const items = await schedule('guesses', `${range[0]}:${range[1]}:${line}`, 0, {
        // A word-scoped op needs the flagged word's own range and an explicit
        // language (see jxa.js): a wrong range can hang the checker.
        request: () => ({ op: 'guesses', text: line, location: range[0], length: range[1] - range[0] }),
        read: (reply) => replacementItems(reply?.words),
      })
      if (!stillCurrent(lines, row, line)) return null
      if (!items || items.length === 0) return null
      return { line: row, startCol: range[0], endCol: range[1], items }
    },

    /**
     * The correction of the prose word the just-typed boundary character
     * completed: `{ startCol, endCol, insert }`, where `insert` is the
     * correction PLUS that boundary character and `endCol` covers both, so the
     * caller replaces exactly the range it was handed and nothing else.
     *
     * Null when the feature is not explicitly on, the caret did not just
     * complete a prose word (a letter, a code-ish token, a `/`-command line,
     * an over-long line or buffer), the checker answered nothing usable, or the
     * caller's line changed while waiting.
     */
    async getAutocorrection(lines, row, col) {
      if (disposed || disabled || features.autocorrect !== true) return null
      const line = checkableLine(lines, row)
      if (line === null || col <= 0 || col > line.length) return null
      const boundary = line[col - 1]
      if (!WORD_BOUNDARY.test(boundary)) return null
      const match = PARTIAL_WORD.exec(line.slice(0, col - 1))
      if (match === null) return null
      // The checker answers for WORD-ALIGNED ranges only, and the range must be
      // the word itself: a leading/trailing apostrophe (`he said 'wrold `)
      // belongs to the quoting, not to the word, and sweeping it into the
      // replaced range would rewrite text the user typed. Trim to the word, so
      // the request is answerable (an untrimmed quoted range gets no correction
      // at all) and the quotes survive the edit.
      const raw = match[0]
      const leading = (raw.match(/^'+/) ?? [''])[0].length
      const trailing = (raw.match(/'+$/) ?? [''])[0].length
      const word = raw.slice(leading, raw.length - trailing)
      if (word.length < 2) return null
      const end = col - 1 - trailing
      const start = end - word.length
      if (!isProseRange(line, start, end)) return null
      const quotes = raw.slice(raw.length - trailing)
      const correction = await schedule('correction', `${start}:${end}:${line}`, 0, {
        // A word-scoped op needs the word's own range and an explicit language
        // (see jxa.js): a wrong range can hang the checker.
        request: () => ({ op: 'correction', text: line, location: start, length: word.length }),
        read: (reply) => {
          const fixed = reply?.correction
          if (typeof fixed !== 'string' || fixed === '' || fixed === word) return null
          if (!SINGLE_LINE_WORD.test(fixed)) return null
          return { startCol: start, endCol: col, insert: `${fixed}${quotes}${boundary}` }
        },
      })
      if (!lineUnchanged(lines, row, line) || features.autocorrect !== true) return null
      return correction
    },

    setFeatures(next = {}) {
      // An explicit enable of ANY feature after the failure latch is also the
      // retry (the latch is provider-wide, not per feature), so no setting can
      // read "on" while the provider stays dead.
      if (disabled && (next.typoDetection === true || next.autocomplete === true || next.autocorrect === true)) {
        disabled = false
        failures = 0
      }
      if (next.typoDetection !== undefined) features.typoDetection = next.typoDetection === true
      if (next.autocomplete !== undefined) features.autocomplete = next.autocomplete === true
      if (next.autocorrect !== undefined) features.autocorrect = next.autocorrect === true
      if (features.typoDetection === false) dropQueued(['check', 'guesses'])
      if (features.autocomplete === false) dropQueued(['completions'])
      if (features.autocorrect !== true) dropQueued(['correction'])
    },

    dispose() {
      if (disposed) return
      disposed = true
      dropQueued()
      inFlight?.controller.abort()
      inFlight = null
      // A backend holding a long-lived resource (the compiled helper child)
      // releases it here; the abort above already covers osascript's per-call
      // child.
      backend.dispose?.()
      // The editor is gone: a late result must not repaint a dead block.
      provider.onUpdate = null
    },
  }

  return provider
}
