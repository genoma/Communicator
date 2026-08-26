/* eslint-disable no-control-regex */
// Help footer + kitty keyboard protocol detection.
import { stringWidth } from './chars.js'
import { applyStyle } from './style.js'

// Ctrl+D is deliberately unbound (it would exit the chat): never advertised.
const DEFAULT_ITEMS = ['submit', 'newline', 'undo', 'cancel']

/** Preferred display order for newline/submit modified keys */
const MODIFIED_KEY_LABELS = {
  'shift+enter': 'Shift+Enter',
  'ctrl+j': 'Ctrl+J',
  'ctrl+enter': 'Ctrl+Enter',
  'alt+enter': 'Alt+Enter',
  'cmd+enter': 'Cmd+Enter',
}
const MODIFIED_KEY_ORDER = [
  'shift+enter',
  'ctrl+j',
  'ctrl+enter',
  'alt+enter',
  'cmd+enter',
]
/** Keys that require the kitty keyboard protocol to work */
const KITTY_REQUIRED_KEYS = new Set(['shift+enter', 'ctrl+enter', 'cmd+enter'])

// --- Kitty protocol detection ---
const DETECT_TIMEOUT_MS = 100
let _kittySupported
let _kittyDetectionPromise = null

/** @internal Reset detection cache for testing */
export function _resetKittyDetection(value) {
  _kittySupported = value
  _kittyDetectionPromise = null
}

/**
 * Forget a negative detection when an editor session ends: a slow terminal
 * (or a busy machine) can miss the 100 ms window once, and the protocol-query
 * response never observed means the *next* session re-detects instead of
 * hiding Shift/Ctrl/Cmd+Enter from the footer for the whole process. A
 * confirmed positive stays cached (the protocol cannot change mid-process).
 */
export function resetKittyDetectionCache() {
  if (_kittySupported === false) {
    _kittySupported = undefined
    _kittyDetectionPromise = null
  }
}

/**
 * Detect kitty keyboard protocol support.
 * Must be called after raw mode is enabled on the input stream.
 * Results are cached; subsequent calls return the cached promise.
 */
export function detectKittyProtocol(input, output) {
  if (_kittyDetectionPromise) return _kittyDetectionPromise
  if (_kittySupported !== undefined) {
    _kittyDetectionPromise = Promise.resolve(_kittySupported)
    return _kittyDetectionPromise
  }
  _kittyDetectionPromise = new Promise((resolve) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        cleanup()
        _kittySupported = false
        resolve(false)
      }
    }, DETECT_TIMEOUT_MS)
    function onData(data) {
      const str = data.toString()
      // Kitty protocol query response: \x1b[?{flags}u
      if (/\x1b\[\?\d*u/.test(str)) {
        if (!settled) {
          settled = true
          cleanup()
          _kittySupported = true
          resolve(true)
        }
      }
    }
    function cleanup() {
      clearTimeout(timeout)
      input.removeListener('data', onData)
    }
    input.on('data', onData)
    // Query kitty keyboard protocol flags
    output.write('\x1b[?u')
  })
  return _kittyDetectionPromise
}

// --- Help footer ---
function getAvailableModifiedKeys(disabledKeys) {
  return MODIFIED_KEY_ORDER.filter((k) => {
    if (disabledKeys.has(k)) return false
    if (_kittySupported === false && KITTY_REQUIRED_KEYS.has(k)) return false
    return true
  })
}

function resolveAction(action, preferNewlineOnEnter, submitLabels, newlineLabels) {
  switch (action) {
    case 'submit':
      if (!preferNewlineOnEnter) return { keys: ['Enter'], action: 'submit' }
      return submitLabels.length > 0 ? { keys: submitLabels, action: 'submit' } : null
    case 'newline':
      if (preferNewlineOnEnter) return { keys: ['Enter', ...newlineLabels], action: 'newline' }
      return newlineLabels.length > 0 ? { keys: newlineLabels, action: 'newline' } : null
    case 'undo':
      return { keys: ['Ctrl+Z'], action: 'undo' }
    case 'redo':
      return { keys: ['Ctrl+Y'], action: 'redo' }
    case 'cancel':
      return { keys: ['Ctrl+C'], action: 'cancel' }
    case 'history':
      return { keys: ['\u2191/\u2193'], action: 'history' }
    case 'word-jump':
      return { keys: ['Alt+\u2190/\u2192'], action: 'word jump' }
    case 'line-start':
      return { keys: ['Ctrl+A', 'Home'], action: 'line start' }
    case 'line-end':
      return { keys: ['Ctrl+E', 'End'], action: 'line end' }
    case 'delete-word':
      return { keys: ['Ctrl+W'], action: 'delete word' }
    case 'delete-to-start':
      return { keys: ['Ctrl+U'], action: 'delete to start' }
    case 'delete-to-end':
      return { keys: ['Ctrl+K'], action: 'delete to end' }
    case 'clear-screen':
      return { keys: ['Ctrl+L'], action: 'clear screen' }
  }
}

function buildItems(options) {
  const { preferNewlineOnEnter = false, disabledKeys = [], maxKeysPerAction = 2, items: actions = DEFAULT_ITEMS } = options
  const disabled = new Set(disabledKeys)
  const available = getAvailableModifiedKeys(disabled)
  // Ctrl+J is always on the newline side
  const submitCapableKeys = available.filter((k) => k !== 'ctrl+j')
  const newlineKeys = preferNewlineOnEnter ? available.filter((k) => k === 'ctrl+j') : available
  const submitLabels = submitCapableKeys
    .slice(0, Math.max(1, maxKeysPerAction))
    .map((k) => MODIFIED_KEY_LABELS[k])
  const newlineLabels = newlineKeys
    .slice(0, Math.max(1, maxKeysPerAction))
    .map((k) => MODIFIED_KEY_LABELS[k])
  const items = []
  for (const action of actions) {
    const item = resolveAction(action, preferNewlineOnEnter, submitLabels, newlineLabels)
    if (item) items.push(item)
  }
  return items
}

function formatItem(item, keyStyle, actionStyle, useColon = true) {
  const keys = item.keys.map((k) => applyStyle(k, keyStyle)).join('/')
  const action = applyStyle(item.action, actionStyle)
  return useColon ? `${keys}: ${action}` : `${keys} ${action}`
}

function formatInline(items, keyStyle, actionStyle, separator) {
  return items.map((item) => formatItem(item, keyStyle, actionStyle, false)).join(separator)
}

function formatGrid(items, keyStyle, actionStyle, termWidth, maxLines) {
  const formatted = items.map((item) => formatItem(item, keyStyle, actionStyle))
  const itemWidths = formatted.map((text) => stringWidth(text))
  const maxItemWidth = Math.max(...itemWidths)
  const colWidth = maxItemWidth + 2
  // Ensure each row fits within termWidth: last item has no padding, others have colWidth
  // Row width = (numCols - 1) * colWidth + maxItemWidth <= termWidth
  const numCols = Math.max(1, Math.floor((termWidth - maxItemWidth) / colWidth) + 1)
  const rows = []
  for (let i = 0; i < items.length; i += numCols) {
    if (maxLines !== undefined && rows.length >= maxLines) break
    const rowFormatted = formatted.slice(i, i + numCols)
    const rowWidths = itemWidths.slice(i, i + numCols)
    const parts = rowFormatted.map((text, idx) => {
      if (idx < rowFormatted.length - 1) {
        const pad = colWidth - rowWidths[idx]
        return text + ' '.repeat(Math.max(0, pad))
      }
      return text
    })
    rows.push(parts.join(''))
  }
  return rows.join('\n')
}

/**
 * Build a help footer string with key binding descriptions.
 * Automatically adjusts grid layout based on terminal width.
 * Uses cached kitty protocol detection results to filter unavailable keys.
 */
export function buildHelpFooter(options = {}) {
  const { keyStyle, actionStyle, separator, columns, maxLines } = options
  const style = options.style ?? (separator ? undefined : 'dim')
  const termWidth = columns ?? (process.stdout.columns || 80)
  const items = buildItems(options)
  if (items.length === 0) return ''
  const text = separator
    ? formatInline(items, keyStyle, actionStyle, separator)
    : formatGrid(items, keyStyle, actionStyle, termWidth, maxLines)
  return applyStyle(text, style)
}
