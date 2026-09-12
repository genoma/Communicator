// Platform-free spelling core. The macOS osascript backend is injected (see
// osascript.js), so the core is testable on any platform and can never spawn a
// child by itself. The feature object is shared with the caller: `setFeatures`
// merges into the same object `/settings` holds, so a toggle applies to the
// next check without a second source of truth.
import { MAX_BUFFER_LENGTH, isCheckableLine, isProseRange } from './mask.js'

const SPELLING_DEBOUNCE_MS = 250

const MAX_CACHE_ENTRIES = 256
const MAX_CONSECUTIVE_FAILURES = 3

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
 * `getTypoRanges(line, bufferLength)` answers with the cached ranges of a line
 * (`[[start, end], ...]`, code units in the source line) or `undefined` while a
 * check is pending — the grid paints plain until the async result lands. One
 * check runs at a time; a newer request replaces the pending one (last-request-
 * wins) and `onUpdate` fires whenever a result lands, so the editor repaints.
 */
export function createSpellingProvider({
  backend,
  features = {},
  onUpdate = null,
  debounceMs = SPELLING_DEBOUNCE_MS,
  maxCacheEntries = MAX_CACHE_ENTRIES,
} = {}) {
  const cache = new Map()
  let disabled = false
  let failures = 0
  let disposed = false
  let debounceTimer = null
  let pendingLine = null
  let pendingReady = false
  let inFlightLine = null

  const notify = () => {
    if (disposed) return
    try {
      if (typeof provider.onUpdate === 'function') provider.onUpdate()
    } catch {
      // A repainting failure is not a backend failure.
    }
  }

  const store = (line, ranges) => {
    cache.set(line, ranges)
    if (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value)
    notify()
  }

  const stopPending = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    pendingLine = null
    pendingReady = false
  }

  const runCheck = async (line) => {
    const controller = new AbortController()
    inFlightLine = { line, controller }
    try {
      const reply = await backend.run({ op: 'check', text: line }, { signal: controller.signal })
      if (disposed || disabled) return
      failures = 0
      store(line, proseRanges(line, reply?.ranges))
    } catch {
      if (!disposed && !disabled) {
        failures += 1
        // Three consecutive failures (a broken osascript, a hang killed by the
        // timeout) disable the feature for the session, silently.
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          disabled = true
          stopPending()
        }
      }
    } finally {
      if (inFlightLine?.controller === controller) inFlightLine = null
      flush()
    }
  }

  // One child at a time: a request that lands while a check runs waits in the
  // single pending slot (last-request-wins) and starts once it has been quiet
  // for the debounce — a result-triggered repaint must not spawn one check per
  // keystroke.
  const flush = () => {
    if (disposed || disabled || inFlightLine !== null || pendingLine === null || !pendingReady) return
    const line = pendingLine
    pendingLine = null
    pendingReady = false
    void runCheck(line)
  }

  const request = (line) => {
    if (disposed || disabled) return
    if (inFlightLine?.line === line || pendingLine === line) return
    pendingLine = line
    pendingReady = false
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      pendingReady = true
      flush()
    }, debounceMs)
    // A debounce must never keep the process alive past the prompt.
    debounceTimer.unref?.()
  }

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
      const cached = cache.get(line)
      if (cached !== undefined) {
        // LRU: a re-read of the line that is being edited keeps it alive.
        cache.delete(line)
        cache.set(line, cached)
        return cached
      }
      request(line)
      return undefined
    },

    setFeatures(next = {}) {
      if (next.typoDetection !== undefined) {
        const enabled = next.typoDetection === true
        // An explicit enable after the failure latch is also the retry, so the
        // setting can never read "on" while the provider stays dead.
        if (enabled && disabled) {
          disabled = false
          failures = 0
        }
        features.typoDetection = enabled
      }
      if (next.autocomplete !== undefined) features.autocomplete = next.autocomplete === true
      if (next.autocorrect !== undefined) features.autocorrect = next.autocorrect === true
      if (features.typoDetection === false) stopPending()
    },

    dispose() {
      if (disposed) return
      disposed = true
      stopPending()
      inFlightLine?.controller.abort()
      inFlightLine = null
      // The editor is gone: a late result must not repaint a dead block.
      provider.onUpdate = null
    },
  }

  return provider
}
