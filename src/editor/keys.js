/* eslint-disable no-control-regex */
// Raw-mode input consumer: reassembles escape sequences split across chunks,
// handles bracketed-paste markers, routes DSR replies and dispatchable keys,
// and inserts printable runs into the model one character at a time.

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const ESC_TIMEOUT = 50 // ms — lone Escape / escape sequence split across reads
const PASTE_TAIL_TIMEOUT = 1500 // ms — recovery if a paste-end marker never completes

/**
 * The longest suffix of seq that could still be a prefix of a paste marker.
 * Returns "" when seq does not end inside a marker.
 */
function markerTail(seq, marker) {
  const limit = Math.min(seq.length, marker.length - 1)
  for (let i = limit; i > 0; i--) {
    if (marker.startsWith(seq.slice(seq.length - i))) return seq.slice(seq.length - i)
  }
  return ''
}

/**
 * Length of the escape sequence starting at seq[start], or 0 when the sequence
 * is incomplete and more bytes are expected. A control byte inside a CSI makes
 * the escape malformed: the sequence ends there so the byte is reprocessed.
 */
export function escapeLength(seq, start) {
  const s = seq.slice(start)
  if (s.length < 2) return 0
  if (s[1] === '[') {
    for (let k = 2; k < s.length; k++) {
      const b = s.charCodeAt(k)
      if (b >= 0x40 && b <= 0x7e) return k + 1 // final byte
      if (b >= 0x20 && b <= 0x3f) continue // parameter / intermediate byte
      return k // malformed: drop the escape, reprocess the byte
    }
    return 0 // CSI started, no final byte yet
  }
  return 2 // ESC + one byte (\x1bb, \x1bf, \x1b\r, ...)
}

/**
 * Process raw data from the input stream, reassembling sequences split across
 * chunks. `ctx` carries:
 * - model: editor model (isPasting flag lives here)
 * - dispatch(key, ch): run the mapped handler or insert a printable character
 * - dsrAnswer(row): DSR reply handler
 * - pasteEnded(): repaint hook fired when a paste completes
 * - pasteWatchdogFired(): repaint hook fired when a lost end marker times out
 */
export function createInputConsumer(ctx) {
  const state = {
    escBuffer: '',
    escTimer: null,
    isPasting: false,
  }

  function flushBuffer() {
    state.escTimer = null
    if (state.isPasting) {
      // No paste data for a while: the end marker never arrived (lost bytes).
      // End the paste so typed keys work again instead of being swallowed.
      state.escBuffer = ''
      state.isPasting = false
      ctx.model.isPasting = false
      ctx.pasteWatchdogFired?.()
      return
    }
    const buf = state.escBuffer
    state.escBuffer = ''
    ctx.dispatch(buf)
  }

  /** Hold an incomplete escape sequence back, flushing after a timeout */
  function holdTail(tail) {
    state.escBuffer = tail
    if (state.escTimer) return
    state.escTimer = setTimeout(
      () => flushBuffer(),
      state.isPasting ? PASTE_TAIL_TIMEOUT : ESC_TIMEOUT
    )
  }

  function processPaste(text) {
    // Bulk insert: per-character insertion is O(n^2) on large pastes. Control
    // chars other than newline are dropped, mirroring the per-char loop.
    ctx.pasteText(text.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, ''))
  }

  /** Consume non-paste input: escape sequences, DSR replies and plain text. */
  function consumeKeys(seq) {
    let i = 0
    while (i < seq.length) {
      const escIdx = seq.indexOf('\x1b', i)
      if (escIdx === -1) {
        ctx.dispatch(seq.slice(i))
        return ''
      }
      if (escIdx > i) ctx.dispatch(seq.slice(i, escIdx))
      const len = escapeLength(seq, escIdx)
      if (len === 0) return seq.slice(escIdx)
      const key = seq.slice(escIdx, escIdx + len)
      const reported = /^\x1b\[(\d+);(\d+)R$/.exec(key)
      if (reported) {
        // DSR reply (\x1b[6n query from the resize handler): the physical
        // cursor moved with the terminal reflow, so the caller re-anchors the
        // repaint on the reported row.
        ctx.dsrAnswer(Number(reported[1]))
        i = escIdx + len
        continue
      }
      ctx.dispatch(key)
      i = escIdx + len
    }
    return ''
  }

  /** Consume paste payload: everything between the start and end markers is literal text */
  function consumePaste(seq) {
    const endIdx = seq.indexOf(PASTE_END)
    if (endIdx !== -1) {
      if (endIdx > 0) processPaste(seq.slice(0, endIdx))
      state.isPasting = false
      ctx.model.isPasting = false
      ctx.pasteEnded()
      return consume(seq.slice(endIdx + PASTE_END.length))
    }
    // A trailing prefix of the end marker may complete in the next chunk;
    // hold it back instead of corrupting the paste payload.
    const tail = markerTail(seq, PASTE_END)
    if (tail) {
      if (seq.length > tail.length) processPaste(seq.slice(0, seq.length - tail.length))
      return tail
    }
    processPaste(seq)
    return ''
  }

  function consume(seq) {
    if (state.isPasting) return consumePaste(seq)
    const startIdx = seq.indexOf(PASTE_START)
    if (startIdx !== -1) {
      const leadTail = startIdx > 0 ? consumeKeys(seq.slice(0, startIdx)) : ''
      if (leadTail) return leadTail + seq.slice(startIdx)
      ctx.pasteStarted()
      state.isPasting = true
      ctx.model.isPasting = true
      return consume(seq.slice(startIdx + PASTE_START.length))
    }
    return consumeKeys(seq)
  }

  return {
    /** @param {Buffer|string} chunk raw input data */
    data(chunk) {
      const seq = chunk.toString()
      if (state.escTimer) {
        clearTimeout(state.escTimer)
        state.escTimer = null
      }
      if (state.escBuffer) {
        const held = state.escBuffer
        const combined = held + seq
        state.escBuffer = ''
        // An incomplete escape tail followed immediately by a paste start
        // marker can never complete: its continuation bytes would BE the
        // marker. Strip the stale tail (a lone ESC is still dispatched as a
        // key) and let the paste begin unambiguously — otherwise the joined
        // bytes are consumed as one unknown escape and the paste marker is
        // eaten, leaking the payload into key input.
        if (!state.isPasting) {
          const markerAt = combined.indexOf(PASTE_START)
          if (markerAt === held.length) {
            if (held === '\x1b') ctx.dispatch('\x1b')
            const tail = consume(seq)
            if (tail) holdTail(tail)
            return
          }
        }
        const tail = consume(combined)
        if (tail) {
          holdTail(tail)
          return
        }
        if (state.isPasting) holdTail('') // arm the paste watchdog
        return
      }
      const tail = consume(seq)
      if (tail) {
        holdTail(tail)
        return
      }
      if (state.isPasting) holdTail('')
    },
    cancelPendingEsc() {
      if (state.escTimer) {
        clearTimeout(state.escTimer)
        state.escTimer = null
      }
      state.escBuffer = ''
    },
  }
}
