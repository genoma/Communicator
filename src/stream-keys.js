import { createInputConsumer } from './editor/keys.js'

const ESC = '\x1b'
const CTRL_C = '\x03'

/**
 * Streaming-phase raw-mode key listener: reacts only to a genuine lone Escape
 * (stop the generation and return to the prompt) and to Ctrl+C arriving as the
 * data byte \x03 (interrupt — raw mode disables ISIG, so Ctrl+C is no longer a
 * SIGINT while streaming). Everything else — arrow/function escape sequences,
 * word-motion escapes, paste markers, printable noise — is ignored so a stray
 * sequence never triggers a stop. Reuses the editor's 50 ms lone-ESC
 * disambiguator via createInputConsumer; `start`/`stop` keep the raw-mode
 * lifecycle symmetric with the editor's cleanup().
 */
export function createStreamKeyMonitor({ input, onStop, onInterrupt }) {
  const consumer = createInputConsumer({
    model: { isPasting: false },
    dispatch(seq) {
      if (seq === ESC) {
        onStop()
        return
      }
      // A chunk that bundles the interrupt byte with other bytes (a paste
      // splice, or a held ESC + \x03) still carries an interrupt: an escape
      // sequence can never contain \x03, so a lone Esc is unaffected.
      if (seq.includes(CTRL_C)) {
        onInterrupt()
        return
      }
    },
    dsrAnswer() {},
    pasteStarted() {},
    pasteText() {},
    pasteEnded() {},
    pasteWatchdogFired() {},
  })

  let active = false
  let dataHandler = null

  const start = () => {
    if (active) return
    active = true
    input.setRawMode?.(true)
    input.resume()
    dataHandler = (data) => consumer.data(data)
    input.on('data', dataHandler)
  }

  const stop = () => {
    if (!active) return
    active = false
    consumer.cancelPendingEsc()
    if (dataHandler) {
      input.removeListener('data', dataHandler)
      dataHandler = null
    }
    input.setRawMode?.(false)
    input.pause()
  }

  return { start, stop }
}
