// Editor front-end: explicit-grid, frame-diffing editor for the chat prompt. Same readInput option surface (the
// validate/transform/highlight/inlinePrompt options have no in-repo callers
// and are rejected loudly).
import { stringWidth } from './chars.js'
import { buildHelpFooter, detectKittyProtocol, resetKittyDetectionCache } from './footer.js'
import { loadHistory } from './history.js'
import { createInputConsumer } from './keys.js'
import {
  bufferEnd,
  bufferStart,
  createModel,
  cycleSuggestion,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBack,
  dismissSuggestions,
  handleBackspace,
  handleDelete,
  historyNext,
  historyPrev,
  insertChar,
  insertNewline,
  insertPaste,
  lineEnd,
  lineStart,
  moveDownOrHistory,
  moveLeft,
  moveRight,
  moveUpOrHistory,
  redo,
  saveUndo,
  suggestMove,
  undo,
  wordLeft,
  wordRight,
  updateSuggestionSession,
} from './model.js'
import {
  applyStyle,
  buildPromptHeader,
  buildStyledLinePrefix,
  computeHeaderHeight,
  resolveStateful,
} from './style.js'
import { computeGrid } from './layout.js'
import {
  paintAbsolute,
  paintDiff,
  paintErase,
  paintForward,
  paintRefresh,
  paintSequential,
  paintSubmit,
} from './paint.js'
import { appendPersistedHistory } from './history.js'

const RESIZE_DEBOUNCE_MS = 80
const DSR_FALLBACK_MS = 400

function readFromPipe(input) {
  return new Promise((resolve) => {
    let data = ''
    input.on('data', (chunk) => {
      data += typeof chunk === 'string' ? chunk : chunk.toString()
    })
    input.on('end', () => {
      resolve([data.endsWith('\n') ? data.slice(0, -1) : data, null])
    })
  })
}

/**
 * Read multi-line input from the terminal (or pipe when not a TTY).
 * Resolves to [value, error] where error = { kind: 'cancel'|'eof' }.
 */
export function readEditor(prompt, options = {}) {
  const { input = process.stdin, output = process.stdout } = options
  if (!input.isTTY) {
    return readFromPipe(input)
  }
  for (const unsupported of ['validate', 'transform', 'highlight', 'inlinePrompt']) {
    if (options[unsupported] != null) {
      throw new Error(`readEditor: the "${unsupported}" option is not supported by editor-bufferdiff-v2`)
    }
  }
  return readFromTTY(input, output, prompt, options)
}

function readFromTTY(input, output, prompt, options) {
  return new Promise((resolve) => {
    const {
      prefix: prefixOption = '> ',
      linePrefix: linePrefixOption,
      theme,
      initialValue,
      history: historyOption,
      historyArrowNavigation = 'single',
      maxLines,
      maxLength,
      preferNewlineOnEnter = false,
      disabledKeys = [],
      footer,
      helpFooter = true,
      suggest,
      onResizeRepaint,
    } = options
    const resolvedLinePrefixOption = linePrefixOption ?? prefixOption
    const themeInputStyle = theme?.input
    const historyRows = Array.isArray(historyOption)
      ? historyOption
      : historyOption?.filePath
        ? loadHistory(historyOption.filePath, historyOption.maxEntries ?? 100)
        : []
    const historyConfig = historyOption && !Array.isArray(historyOption) ? historyOption : undefined
    const disabledKeySet = new Set(disabledKeys)

    const model = createModel({
      maxLength,
      maxLines,
      historyRows,
      historyArrowNavigation,
      suggest,
      initialValue,
    })

    const terminalWidth = () =>
      typeof output.columns === 'number' && output.columns > 0 ? output.columns : 80
    const terminalRows = () =>
      Number.isInteger(output.rows) && output.rows > 0 ? output.rows : null

    const view = { shadow: null, windowed: false }

    const headerRows = () => {
      const header = buildPromptHeader(prefixOption, prompt, theme, model.visualState)
      return computeHeaderHeight(header) > 0 ? header.split('\n') : []
    }
    const styledLinePrefix = () =>
      buildStyledLinePrefix(resolvedLinePrefixOption, theme, model.visualState)
    const rawLinePrefixWidth = () =>
      stringWidth(resolveStateful(resolvedLinePrefixOption, model.visualState))

    let rebuildFooter = buildFooterRegular

    // Suggestion list rows for the active suggestion session: the window is
    // centred around the selected match, selected entry bold/cyan with a
    // marker, plus a "… N more" trailer (matches the vendored layout).
    const suggestionRows = (session) => {
      const MAX_SUGGESTIONS = 8
      const windowStart = Math.min(
        Math.max(0, session.index - Math.floor(MAX_SUGGESTIONS / 2)),
        Math.max(0, session.matches.length - MAX_SUGGESTIONS)
      )
      const shown = session.matches.slice(windowStart, windowStart + MAX_SUGGESTIONS)
      const rows = shown.map((item, offset) => {
        const isSelected = windowStart + offset === session.index
        const marker = isSelected ? '› ' : '  '
        const styled = isSelected ? applyStyle(item, ['bold', 'cyan']) : applyStyle(item, 'dim')
        return marker + styled
      })
      if (session.matches.length > shown.length) {
        rows.push(applyStyle(`… ${session.matches.length - shown.length} more`, 'dim'))
      }
      return rows
    }

    const footerRows = () => {
      if (model.suggestSession) {
        return suggestionRows(model.suggestSession)
      }
      const text = rebuildFooter(terminalWidth())
      return text === '' ? [] : text.split('\n')
    }

    let grid = null
    const computeGridFn = (opts = {}) => {
      updateSuggestionSession(model)
      grid = computeGrid({
        width: terminalWidth(),
        headerRows: headerRows(),
        linePrefix: styledLinePrefix(),
        linePrefixWidth: rawLinePrefixWidth(),
        lines: model.lines,
        row: model.row,
        col: model.col,
        statusText: opts.noFooter ? '' : model.statusText,
        statusColor: opts.noFooter ? '' : model.statusColor,
        theme,
        footerRows: opts.noFooter ? [] : footerRows(),
        inputStyle: themeInputStyle,
      })
      return grid
    }

    const fitsOnScreen = (g) => {
      const rows = terminalRows()
      return rows == null || g.rows.length <= rows
    }
    const setShadow = (g) => {
      view.shadow = { rows: g.rows, cursor: g.cursor, width: terminalWidth() }
      view.windowed = !fitsOnScreen(g)
    }

    function paint(g, mode, param) {
      if (mode === 'rebuild') {
        paintSequential(output, g, onResizeRepaint)
        setShadow(g)
        return
      }
      if (mode === 'absolute') {
        const blockTop = param - g.cursor.r
        if (blockTop < 0) {
          // The block top scrolled off the viewport: fall back to a forward
          // repaint (the safe fallback).
          paintForward(output, g)
        } else {
          paintAbsolute(output, g, blockTop)
        }
        setShadow(g)
        return
      }
      if (mode === 'forward') {
        paintForward(output, g)
        setShadow(g)
        return
      }
      if (mode === 'refresh') {
        if (view.shadow && !view.windowed && fitsOnScreen(g)) {
          paintRefresh(output, g)
        } else {
          paintForward(output, g)
        }
        setShadow(g)
        return
      }
      if (mode === 'submit') {
        if (view.shadow && !view.windowed && fitsOnScreen(g)) {
          paintSubmit(output, g)
          setShadow(g)
        }
        return
      }
      if (!view.shadow || view.windowed || !fitsOnScreen(g)) {
        if (view.shadow) {
          if (mode === 'erase') return
          paintForward(output, g)
        } else {
          paintSequential(output, g)
        }
        setShadow(g)
        return
      }
      if (mode === 'erase') {
        paintErase(output, g)
        view.shadow = null
        view.windowed = false
        return
      }
      paintDiff(output, view.shadow, g)
      setShadow(g)
    }

    const repaintMode = (mode, param) => {
      paint(computeGridFn(mode === 'submit' ? { noFooter: true } : {}), mode, param)
    }

    // --- Resize handling ---
    let resizeTimer = null
    let dsrTimer = null
    function resizeHandler() {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        if (!active) return
        if (typeof onResizeRepaint === 'function') {
          repaintMode('rebuild')
          return
        }
        // DSR fallback: query the physical cursor and rebuild at the reported
        // row. Without a hook the content above the editor is not re-rendered
        // by us, so only the block can be restored.
        if (dsrTimer) clearTimeout(dsrTimer)
        dsrTimer = setTimeout(() => {
          dsrTimer = null
          if (view.shadow) repaintMode('refresh')
        }, DSR_FALLBACK_MS)
        output.write('\x1b[6n') // DSR: report cursor position
      }, RESIZE_DEBOUNCE_MS)
    }
    if (typeof output.on === 'function') {
      output.on('resize', resizeHandler)
    }

    // --- Input consumer ---
    const consumer = createInputConsumer({
      model,
      dispatch(seq) {
        if (seq === '') return
        if (seq[0] === '\x1b') {
          runHandler(seq)
          return
        }
        insertRun(seq)
      },
      dsrAnswer(row) {
        if (dsrTimer) {
          clearTimeout(dsrTimer)
          dsrTimer = null
        }
        repaintMode('absolute', row - 1)
      },
      pasteStarted() {
        saveUndo(model)
      },
      pasteText(text) {
        insertPaste(model, text)
      },
      pasteEnded() {
        // The physical cursor never moved during the paste: the shadow still
        // marks it. Rewind to the block top and rewrite it all in place when
        // the cursor is not on row 0 (the legacy rewind case), else draw
        // forward.
        const g = computeGridFn()
        if (view.shadow && !view.windowed && fitsOnScreen(g) && view.shadow.cursor.r > 0) {
          // The physical cursor is still at the pre-paste position: rewind
          // from the shadow's cursor row to reach the block top.
          paintRefresh(output, g, view.shadow.cursor.r)
        } else {
          paintForward(output, g)
        }
        setShadow(g)
      },
      pasteWatchdogFired() {
        repaintMode('normal')
      },
    })

    // --- Key map ---
    const keyMap = new Map()
    const insertCharAndPaint = (ch) => {
      insertChar(model, ch)
      repaintMode('normal')
    }
    const insertNewlineAndPaint = () => {
      insertNewline(model)
      repaintMode('normal')
    }
    const withRepaint = (fn) => () => {
      fn(model)
      repaintMode('normal')
    }

    const enterAction = preferNewlineOnEnter ? insertNewlineAndPaint : submit
    const modifiedAction = preferNewlineOnEnter ? submit : insertNewlineAndPaint
    keyMap.set('\r', enterAction)
    keyMap.set('\x1b[13u', enterAction) // kitty Enter
    if (!disabledKeySet.has('ctrl+j')) {
      keyMap.set('\n', insertNewlineAndPaint)
      keyMap.set('\x1b[106;5u', insertNewlineAndPaint) // kitty Ctrl+J
    }
    const modifiedEnterKeys = {
      'shift+enter': ['\x1b[13;2u'],
      'ctrl+enter': ['\x1b[13;5u'],
      'cmd+enter': ['\x1b[13;9u'],
      'alt+enter': ['\x1b\r', '\x1b[13;3u'],
    }
    for (const [name, seqs] of Object.entries(modifiedEnterKeys)) {
      if (!disabledKeySet.has(name)) {
        for (const seq of seqs) keyMap.set(seq, modifiedAction)
      }
    }
    keyMap.set('\x03', cancel) // Ctrl+C
    keyMap.set('\x1b[99;5u', cancel) // kitty Ctrl+C
    // Ctrl+D deliberately unbound: EOF in shells vs forward-delete in
    // emacs-style apps, and it would exit the chat (see MEMORY.md).
    keyMap.set('\x7f', withRepaint(handleBackspace))
    keyMap.set('\b', withRepaint(handleBackspace))
    keyMap.set('\x17', withRepaint(deleteWordBack)) // Ctrl+W
    keyMap.set('\x1b[119;5u', withRepaint(deleteWordBack)) // kitty Ctrl+W
    keyMap.set('\x1b[3~', withRepaint(handleDelete)) // Delete
    keyMap.set('\x15', withRepaint(deleteToLineStart)) // Ctrl+U
    keyMap.set('\x1b[117;5u', withRepaint(deleteToLineStart)) // kitty Ctrl+U
    keyMap.set('\x0b', withRepaint(deleteToLineEnd)) // Ctrl+K
    keyMap.set('\x1b[107;5u', withRepaint(deleteToLineEnd)) // kitty Ctrl+K
    keyMap.set('\x1a', withRepaint(undo)) // Ctrl+Z
    keyMap.set('\x1b[122;5u', withRepaint(undo)) // kitty Ctrl+Z
    keyMap.set('\x1b[122;9u', withRepaint(undo)) // kitty Cmd+Z
    keyMap.set('\x1b[122;6u', withRepaint(redo)) // kitty Ctrl+Shift+Z
    keyMap.set('\x1b[122;10u', withRepaint(redo)) // kitty Cmd+Shift+Z
    keyMap.set('\x19', withRepaint(redo)) // Ctrl+Y
    keyMap.set('\x1b[121;5u', withRepaint(redo)) // kitty Ctrl+Y
    keyMap.set('\x1b[121;9u', withRepaint(redo)) // kitty Cmd+Y
    keyMap.set('\x0c', () => repaintMode('refresh')) // Ctrl+L
    keyMap.set('\x1b[108;5u', () => repaintMode('refresh')) // kitty Ctrl+L
    keyMap.set('\x1b[A', () => {
      if (!suggestMove(model, -1)) moveUpOrHistory(model)
      repaintMode('normal')
    })
    keyMap.set('\x1b[B', () => {
      if (!suggestMove(model, 1)) moveDownOrHistory(model)
      repaintMode('normal')
    })
    keyMap.set('\x1b[C', withRepaint(moveRight))
    keyMap.set('\x1b[D', withRepaint(moveLeft))
    keyMap.set('\x1b[1;3C', withRepaint(wordRight)) // Alt+Arrow
    keyMap.set('\x1b[1;3D', withRepaint(wordLeft)) // Alt+Arrow
    keyMap.set('\x1b[1;3A', withRepaint(historyPrev)) // Alt+Arrow
    keyMap.set('\x1b[1;3B', withRepaint(historyNext)) // Alt+Arrow
    keyMap.set('\x1b[1;5C', withRepaint(lineEnd)) // Ctrl+Arrow
    keyMap.set('\x1b[1;5D', withRepaint(lineStart)) // Ctrl+Arrow
    keyMap.set('\x1b[1;5A', withRepaint(bufferStart)) // Ctrl+Arrow
    keyMap.set('\x1b[1;5B', withRepaint(bufferEnd)) // Ctrl+Arrow
    keyMap.set('\x10', withRepaint(historyPrev)) // Ctrl+P
    keyMap.set('\x1b[112;5u', withRepaint(historyPrev)) // kitty Ctrl+P
    keyMap.set('\x0e', withRepaint(historyNext)) // Ctrl+N
    keyMap.set('\x1b[110;5u', withRepaint(historyNext)) // kitty Ctrl+N
    keyMap.set('\x1b[5~', withRepaint(historyPrev)) // PageUp
    keyMap.set('\x1b[6~', withRepaint(historyNext)) // PageDown
    keyMap.set('\x1bb', withRepaint(wordLeft)) // ESC+b
    keyMap.set('\x1bf', withRepaint(wordRight)) // ESC+f
    keyMap.set('\x1b[1;9D', withRepaint(lineStart)) // Cmd+Arrow (kitty super)
    keyMap.set('\x1b[1;9C', withRepaint(lineEnd)) // Cmd+Arrow (kitty super)
    keyMap.set('\x1b[1;9A', withRepaint(bufferStart)) // Cmd+Arrow (kitty super)
    keyMap.set('\x1b[1;9B', withRepaint(bufferEnd)) // Cmd+Arrow (kitty super)
    keyMap.set('\x01', withRepaint(lineStart)) // Ctrl+A (macOS Cmd+Left)
    keyMap.set('\x1b[97;5u', withRepaint(lineStart)) // kitty Ctrl+A
    keyMap.set('\x05', withRepaint(lineEnd)) // Ctrl+E (macOS Cmd+Right)
    keyMap.set('\x1b[101;5u', withRepaint(lineEnd)) // kitty Ctrl+E
    keyMap.set('\x1b[H', withRepaint(lineStart)) // Home
    keyMap.set('\x1b[F', withRepaint(lineEnd)) // End
    if (suggest) {
      for (const seq of ['\t', '\x1b[9u', '\x1b[9;1u']) {
        keyMap.set(seq, () => {
          cycleSuggestion(model, 1)
          repaintMode('normal')
        })
      }
      for (const seq of ['\x1b[Z', '\x1b[9;2u', '\x1b[1;2Z']) {
        keyMap.set(seq, () => {
          cycleSuggestion(model, -1)
          repaintMode('normal')
        })
      }
      for (const seq of ['\x1b', '\x1b[27u', '\x1b[27;1u']) {
        keyMap.set(seq, () => {
          dismissSuggestions(model)
          repaintMode('normal')
        })
      }
    }

    function runHandler(seq) {
      const handler = keyMap.get(seq)
      const prevAttempt = model.historyArrowAttempt
      if (handler) handler()
      if (prevAttempt > 0 && model.historyArrowAttempt === prevAttempt) {
        model.historyArrowAttempt = 0
      }
    }

    function insertRun(run) {
      if (model.historyArrowAttempt > 0) model.historyArrowAttempt = 0
      for (const ch of run) {
        const handler = keyMap.get(ch)
        if (handler && (ch.charCodeAt(0) < 32 || ch === '\x7f')) {
          handler()
        } else if (ch.charCodeAt(0) >= 32) {
          insertCharAndPaint(ch)
        }
      }
    }

    let active = false

    function cleanup() {
      if (!active) return
      active = false
      if (resizeTimer) {
        clearTimeout(resizeTimer)
        resizeTimer = null
      }
      if (dsrTimer) {
        clearTimeout(dsrTimer)
        dsrTimer = null
      }
      consumer.cancelPendingEsc()
      if (typeof output.removeListener === 'function') {
        output.removeListener('resize', resizeHandler)
      }
      output.write('\x1b[?2004l') // Disable bracketed paste mode
      output.write('\x1b[<u') // Disable kitty protocol
      input.setRawMode?.(false)
      input.removeListener('data', dataHandler)
      input.removeListener('end', onEof)
      input.removeListener('close', onEof)
      input.pause()
      resetKittyDetectionCache()
    }

    // Real stdin EOF while the prompt is open (pty close / pipe end; Ctrl+D
    // is deliberately unbound, so EOF arrives only through the stream):
    // tear the editor down and resolve as an EOF cancel, mirroring cancel().
    function onEof() {
      if (!active) return
      if (!view.windowed && fitsOnScreen(computeGridFn())) {
        repaintMode('erase')
      }
      cleanup()
      resolve([model.lines.join('\n'), { kind: 'eof' }])
    }

    function submit() {
      if (!active) return
      const result = model.lines.join('\n')
      model.visualState = 'submitted'
      if (!view.windowed && fitsOnScreen(computeGridFn())) {
        repaintMode('submit')
      }
      cleanup()
      if (historyConfig?.filePath) {
        const shouldPersist = historyConfig.shouldPersist
          ? historyConfig.shouldPersist(result) !== false
          : result !== ''
        if (shouldPersist) {
          appendPersistedHistory(historyConfig.filePath, result, historyConfig.maxEntries ?? 100)
        }
      }
      resolve([result, null])
    }

    function cancel() {
      if (!active) return
      if (!view.windowed && fitsOnScreen(computeGridFn())) {
        repaintMode('erase')
      }
      cleanup()
      resolve([model.lines.join('\n'), { kind: 'cancel', message: 'Input cancelled' }])
    }

    // --- Footer / help ---
    function buildFooterRegular(cols) {
      const custom = footer ?? ''
      if (helpFooter) {
        const helpOptions = typeof helpFooter === 'object' ? helpFooter : {}
        const helpText = buildHelpFooter({
          ...helpOptions,
          preferNewlineOnEnter,
          disabledKeys,
          columns: cols,
        })
        if (!custom) return helpText
        if (!helpText) return custom
        return custom + '\n' + helpText
      }
      return typeof footer === 'string' ? footer : ''
    }

    // --- Startup ---
    function start() {
      active = true
      repaintMode('normal')
      input.setRawMode?.(true)
      input.resume()
      output.write('\x1b[>1u') // Enable kitty keyboard protocol
      output.write('\x1b[?2004h') // Enable bracketed paste mode
      dataHandler = (data) => consumer.data(data)
      input.on('data', dataHandler)
      input.on('end', onEof)
      input.on('close', onEof)
      if (helpFooter) {
        // The cached kitty result (src/editor/footer.js module state) filters
        // protocol-dependent keys out of the help footer once known: repaint.
        detectKittyProtocol(input, output).then(() => {
          if (active) repaintMode('normal')
        })
      }
    }

    let dataHandler = null
    start()
  })
}
