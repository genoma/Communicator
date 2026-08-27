// Pure editor state machine: text buffer, cursor, editing, undo/redo, history
// and suggestion-session logic. No terminal I/O — the caller applies edits and
// repaints through the layout/paint modules.
import {
  charAtIndex,
  charBeforeIndex,
  colFromVisual,
  contentLength,
  isWordChar,
  visualCol,
} from './chars.js'

const MAX_UNDO = 200

/** Create the editor model with the given options */
export function createModel(options = {}) {
  const historyRows = options.historyRows ?? []
  const model = {
    lines: [''],
    row: 0,
    col: 0,
    visualState: 'pending',
    maxLength: options.maxLength,
    maxLines: options.maxLines,
    statusText: '',
    statusColor: '',
    history: [...historyRows],
    historyIndex: historyRows.length,
    draft: '',
    historyArrowNavigation: options.historyArrowNavigation ?? 'single',
    historyArrowAttempt: 0,
    undoStack: [],
    redoStack: [],
    lastEditType: '',
    suggest: options.suggest,
    suggestSession: null,
    dismissUntilEdit: false,
    isPasting: false,
  }
  if (options.initialValue) {
    const initLines = options.initialValue.split('\n')
    model.lines = [...initLines]
    model.row = initLines.length - 1
    model.col = initLines[model.row].length
  }
  return model
}

// --- Undo / Redo ---
function takeSnapshot(model) {
  return { lines: [...model.lines], row: model.row, col: model.col }
}

/** Push current state to undo stack, grouping consecutive character insertions */
export function saveUndo(model, editType = 'other') {
  if (editType === 'insert' && model.lastEditType === 'insert' && model.undoStack.length > 0) {
    model.lastEditType = editType
    return
  }
  model.lastEditType = editType
  model.undoStack.push(takeSnapshot(model))
  if (model.undoStack.length > MAX_UNDO) model.undoStack.shift()
  model.redoStack.length = 0
}

export function undo(model) {
  if (model.undoStack.length === 0) return
  model.redoStack.push(takeSnapshot(model))
  const snap = model.undoStack.pop()
  model.lines = [...snap.lines]
  model.row = snap.row
  model.col = snap.col
  model.lastEditType = ''
  postEdit(model)
}

export function redo(model) {
  if (model.redoStack.length === 0) return
  model.undoStack.push(takeSnapshot(model))
  const snap = model.redoStack.pop()
  model.lines = [...snap.lines]
  model.row = snap.row
  model.col = snap.col
  model.lastEditType = ''
  postEdit(model)
}

// --- Status ---
function setStatus(model, text, color) {
  model.statusText = text
  model.statusColor = color
}

function clearStatus(model) {
  model.statusText = ''
  model.statusColor = ''
}

// --- Content change handling ---
function postEdit(model) {
  model.dismissUntilEdit = false
  if (model.maxLength != null) {
    const len = contentLength(model.lines)
    if (len >= model.maxLength) {
      setStatus(model, `Maximum ${model.maxLength} characters`, 'red')
      model.visualState = 'error'
      return
    }
  }
  if (model.visualState === 'error' || model.statusText.startsWith('Maximum ')) {
    // Limit error clears when content fits again
    clearStatus(model)
    model.visualState = 'pending'
  }
}

// --- Suggestions ---
/** Whether a suggestion session is active and consumable by navigation keys */
export function updateSuggestionSession(model) {
  // After Escape the session stays closed until the next content edit: the
  // restored prefix would otherwise re-open it on the very next repaint.
  if (model.dismissUntilEdit) return
  if (!model.suggest || model.lines.length !== 1) {
    model.suggestSession = null
    return
  }
  const value = model.lines[0]
  if (!value.startsWith('/') || model.col !== value.length) {
    model.suggestSession = null
    return
  }
  const items = model.suggest({ value, cursor: model.col })
  const matches = Array.isArray(items)
    ? items.filter((item) => typeof item === 'string' && item.startsWith(value))
    : []
  if (matches.length === 0) {
    model.suggestSession = null
    return
  }
  if (!matches.includes(value)) {
    model.suggestSession = { prefix: value, matches, index: 0 }
    return
  }
  const session = model.suggestSession
  if (session && session.matches.includes(value)) {
    model.suggestSession = { ...session, index: session.matches.indexOf(value) }
    return
  }
  model.suggestSession = null
}

/** Compute the next selection within the active suggestion session, or null when the line would not change */
export function nextSuggestionMove(session, value, dir) {
  if (!session) return null
  const selected = session.matches.indexOf(value)
  const start = selected !== -1 ? selected : dir > 0 ? -1 : 0
  const index = (start + dir + session.matches.length) % session.matches.length
  const nextLine = session.matches[index]
  if (nextLine === value) return null
  return { line: nextLine, index }
}

/**
 * Navigate the active suggestion session in the given direction, filling the
 * line with the selected match. Returns true when the key press was consumed
 * (either by navigating or by an active single-match session), false when no
 * session is active so callers can fall back to history navigation.
 */
export function suggestMove(model, dir) {
  const session = model.suggestSession
  if (!session || model.lines.length !== 1) return false
  const value = model.lines[0]
  if (!value.startsWith('/') || model.col !== value.length) return false
  const move = nextSuggestionMove(session, value, dir)
  if (!move) return true
  saveUndo(model)
  model.lines = [move.line]
  model.row = 0
  model.col = move.line.length
  model.suggestSession = { ...session, index: move.index }
  return true
}

/** Dismiss the active suggestion session, restoring the typed prefix */
export function dismissSuggestions(model) {
  const session = model.suggestSession
  if (!session) return
  saveUndo(model)
  model.lines = [session.prefix]
  model.row = 0
  model.col = session.prefix.length
  model.suggestSession = null
  model.dismissUntilEdit = true
}

/** Cycle the suggestion list (Tab / Shift+Tab): alias of suggestMove */
export function cycleSuggestion(model, dir) {
  suggestMove(model, dir)
}

// --- Limit checks ---
function canInsertChar(model, charCount = 1) {
  if (model.maxLength != null) {
    const len = contentLength(model.lines)
    if (len + charCount > model.maxLength) {
      setStatus(model, `Maximum ${model.maxLength} characters`, 'red')
      model.visualState = 'error'
      return false
    }
  }
  return true
}

function canInsertNewline(model) {
  if (model.maxLines != null && model.lines.length >= model.maxLines) {
    setStatus(model, `Maximum ${model.maxLines} lines`, 'red')
    model.visualState = 'error'
    return false
  }
  if (model.maxLength != null) {
    const len = contentLength(model.lines)
    if (len + 1 > model.maxLength) {
      setStatus(model, `Maximum ${model.maxLength} characters`, 'red')
      model.visualState = 'error'
      return false
    }
  }
  return true
}

// --- Editing operations ---
/** Insert a character at the current cursor position */
export function insertChar(model, ch) {
  if (ch === '\u0085' || ch === '\u2028' || ch === '\u2029') {
    insertNewline(model)
    return
  }
  if (!canInsertChar(model, [...ch].length)) return
  if (!model.isPasting) saveUndo(model, 'insert')
  model.lines[model.row] =
    model.lines[model.row].slice(0, model.col) + ch + model.lines[model.row].slice(model.col)
  model.col += ch.length
  postEdit(model)
}

/** Bulk-insert a bracketed-paste payload in one operation */
export function insertPaste(model, text) {
  text = text.replace(/\r\n|\r|\u0085|\u2028|\u2029/g, '\n')
  const parts = text.split('\n')
  let budget = model.maxLength != null ? model.maxLength - contentLength(model.lines) : null
  let limitStatus = null
  const take = (segment) => {
    const cps = [...segment]
    let count = cps.length
    if (budget != null && count > budget) {
      count = budget
      limitStatus = `Maximum ${model.maxLength} characters`
    }
    if (budget != null) budget -= count
    const taken = cps.slice(0, count).join('')
    return { taken, width: taken.length }
  }
  let row = model.row
  let col = model.col
  const first = take(parts[0])
  const base = model.lines[row]
  model.lines[row] = base.slice(0, col) + first.taken + base.slice(col)
  col += first.width
  for (let i = 1; i < parts.length; i++) {
    if (model.maxLines == null || model.lines.length < model.maxLines) {
      if (budget != null && budget <= 0) {
        limitStatus = `Maximum ${model.maxLength} characters`
        break
      }
      if (budget != null) budget -= 1 // the newline separator
      const line = model.lines[row]
      model.lines[row] = line.slice(0, col)
      row++
      model.lines.splice(row, 0, line.slice(col))
      col = 0
    } else {
      // Line budget exhausted: stop; the remaining parts would otherwise be
      // merged noisily into the last line with their newlines dropped.
      limitStatus = `Maximum ${model.maxLines} lines`
      break
    }
    const segment = take(parts[i])
    const line = model.lines[row]
    model.lines[row] = line.slice(0, col) + segment.taken + line.slice(col)
    col += segment.width
  }
  model.row = row
  model.col = col
  postEdit(model)
  if (limitStatus) {
    setStatus(model, limitStatus, 'red')
    model.visualState = 'error'
  }
}

/** Insert a newline at the current cursor position, splitting the current line */
export function insertNewline(model) {
  if (!canInsertNewline(model)) return
  if (!model.isPasting) saveUndo(model)
  const after = model.lines[model.row].slice(model.col)
  model.lines[model.row] = model.lines[model.row].slice(0, model.col)
  model.lines.splice(model.row + 1, 0, after)
  model.row++
  model.col = 0
  postEdit(model)
}

/** Delete the character before cursor, merging lines at line boundaries */
export function handleBackspace(model) {
  if (model.col > 0) {
    saveUndo(model)
    const deleted = charBeforeIndex(model.lines[model.row], model.col)
    model.col -= deleted.length
    model.lines[model.row] =
      model.lines[model.row].slice(0, model.col) +
      model.lines[model.row].slice(model.col + deleted.length)
    model.lastEditType = ''
    postEdit(model)
    return
  }
  if (model.row > 0) {
    saveUndo(model)
    const prevLen = model.lines[model.row - 1].length
    model.lines[model.row - 1] += model.lines[model.row]
    model.lines.splice(model.row, 1)
    model.row--
    model.col = prevLen
    model.lastEditType = ''
    postEdit(model)
  }
}

/** Delete the character at cursor, merging lines at line boundaries */
export function handleDelete(model) {
  if (model.col < model.lines[model.row].length) {
    saveUndo(model)
    const deleted = charAtIndex(model.lines[model.row], model.col)
    model.lines[model.row] =
      model.lines[model.row].slice(0, model.col) +
      model.lines[model.row].slice(model.col + deleted.length)
    model.lastEditType = ''
    postEdit(model)
    return
  }
  if (model.row < model.lines.length - 1) {
    saveUndo(model)
    model.lines[model.row] += model.lines[model.row + 1]
    model.lines.splice(model.row + 1, 1)
    model.lastEditType = ''
    postEdit(model)
  }
}

/** Delete all characters from cursor to the start of the current line */
export function deleteToLineStart(model) {
  if (model.col === 0) return
  saveUndo(model)
  model.lines[model.row] = model.lines[model.row].slice(model.col)
  model.col = 0
  model.lastEditType = ''
  postEdit(model)
}

/** Delete all characters from cursor to the end of the current line */
export function deleteToLineEnd(model) {
  if (model.col >= model.lines[model.row].length) return
  saveUndo(model)
  model.lines[model.row] = model.lines[model.row].slice(0, model.col)
  model.lastEditType = ''
  postEdit(model)
}

/** Delete the entire buffer (all lines), resetting the cursor to the start (Ctrl+Delete) */
export function clearAll(model) {
  if (model.lines.length === 1 && model.lines[0] === '' && model.row === 0 && model.col === 0) return
  saveUndo(model)
  model.lines = ['']
  model.row = 0
  model.col = 0
  model.lastEditType = ''
  postEdit(model)
}

/** Delete the previous word (Ctrl+W behavior) */
export function deleteWordBack(model) {
  if (model.col === 0) {
    handleBackspace(model)
    return
  }
  saveUndo(model)
  const line = model.lines[model.row]
  let c = model.col
  while (c > 0 && !isWordChar(charBeforeIndex(line, c))) {
    c -= charBeforeIndex(line, c).length
  }
  while (c > 0 && isWordChar(charBeforeIndex(line, c))) {
    c -= charBeforeIndex(line, c).length
  }
  model.lines[model.row] = line.slice(0, c) + line.slice(model.col)
  model.col = c
  model.lastEditType = ''
  postEdit(model)
}

// --- Cursor movement ---
// A cursor move is an undo-group boundary: typing `abc`, moving the cursor
// and typing `def` must undo as two groups, and undo must not restore the
// cursor position captured before the move.
const movedCursor = (model) => {
  model.lastEditType = ''
}

export function moveLeft(model) {
  if (model.col > 0) {
    model.col -= charBeforeIndex(model.lines[model.row], model.col).length
  } else if (model.row > 0) {
    model.row--
    model.col = model.lines[model.row].length
  }
  movedCursor(model)
  model.historyArrowAttempt = 0
}

export function moveRight(model) {
  if (model.col < model.lines[model.row].length) {
    model.col += charAtIndex(model.lines[model.row], model.col).length
  } else if (model.row < model.lines.length - 1) {
    model.row++
    model.col = 0
  }
  movedCursor(model)
  model.historyArrowAttempt = 0
}

/** Move cursor one line up, preserving visual column position */
function moveUp(model) {
  if (model.row <= 0) return
  const vc = visualCol(model.lines[model.row], model.col)
  model.row--
  model.col = colFromVisual(model.lines[model.row], vc)
  movedCursor(model)
  model.historyArrowAttempt = 0
}

/** Move cursor one line down, preserving visual column position */
function moveDown(model) {
  if (model.row >= model.lines.length - 1) return
  const vc = visualCol(model.lines[model.row], model.col)
  model.row++
  model.col = colFromVisual(model.lines[model.row], vc)
  movedCursor(model)
  model.historyArrowAttempt = 0
}

/** Move up or navigate history when at the first line */
export function moveUpOrHistory(model) {
  if (model.row > 0) {
    moveUp(model)
  } else if (model.col > 0) {
    model.col = 0
    model.historyArrowAttempt = 0
  } else if (model.history.length > 0) {
    const nav = model.historyArrowNavigation
    if (nav === 'single') {
      historyPrev(model)
    } else if (nav === 'double') {
      model.historyArrowAttempt++
      if (model.historyArrowAttempt >= 2) {
        model.historyArrowAttempt = 0
        historyPrev(model)
      }
    }
  }
}

/** Move down or navigate history when at the last line */
export function moveDownOrHistory(model) {
  if (model.row < model.lines.length - 1) {
    moveDown(model)
  } else if (model.col < model.lines[model.row].length) {
    model.col = model.lines[model.row].length
    model.historyArrowAttempt = 0
  } else if (model.historyIndex < model.history.length) {
    const nav = model.historyArrowNavigation
    if (nav === 'single') {
      historyNext(model)
    } else if (nav === 'double') {
      model.historyArrowAttempt++
      if (model.historyArrowAttempt >= 2) {
        model.historyArrowAttempt = 0
        historyNext(model)
      }
    }
  }
}

// --- Word jump ---
// Both jumps step by whole code points (chars.js helpers), never by code
// units: an emoji/astral pair must not leave the cursor between its
// surrogates (a further edit would corrupt it).
export function wordRight(model) {
  let r = model.row
  let c = model.col
  while (r < model.lines.length) {
    const line = model.lines[r]
    while (c < line.length && !isWordChar(charAtIndex(line, c))) c += charAtIndex(line, c).length
    if (c < line.length) break
    if (r < model.lines.length - 1) {
      r++
      c = 0
    } else break
  }
  const line = model.lines[r]
  while (c < line.length && isWordChar(charAtIndex(line, c))) c += charAtIndex(line, c).length
  if (r !== model.row || c !== model.col) {
    model.row = r
    model.col = c
  }
  model.historyArrowAttempt = 0
}

export function wordLeft(model) {
  let r = model.row
  let c = model.col
  if (c > 0) {
    c -= charBeforeIndex(model.lines[r], c).length
  } else if (r > 0) {
    r--
    c = model.lines[r].length
    if (c > 0) {
      c -= charBeforeIndex(model.lines[r], c).length
    } else {
      model.row = r
      model.col = 0
      model.historyArrowAttempt = 0
      return
    }
  } else {
    model.historyArrowAttempt = 0
    return
  }
  while (true) {
    const line = model.lines[r]
    while (c > 0 && !isWordChar(charAtIndex(line, c))) {
      // A wide char (2+ code units) at c must not undershoot past 0.
      const step = charAtIndex(line, c).length
      c = c >= step ? c - step : 0
    }
    if (c < line.length && isWordChar(charAtIndex(line, c))) break
    if (r > 0) {
      r--
      c = model.lines[r].length
      if (c === 0) break
      c -= charBeforeIndex(model.lines[r], c).length
    } else {
      c = 0
      break
    }
  }
  const line = model.lines[r]
  while (c > 0 && isWordChar(charBeforeIndex(line, c))) c -= charBeforeIndex(line, c).length
  model.row = r
  model.col = c
  model.historyArrowAttempt = 0
}

// --- Line start/end, buffer start/end ---
export function lineStart(model) {
  model.col = 0
  model.historyArrowAttempt = 0
}

export function lineEnd(model) {
  model.col = model.lines[model.row].length
  model.historyArrowAttempt = 0
}

export function bufferStart(model) {
  model.row = 0
  model.col = 0
  model.historyArrowAttempt = 0
}

export function bufferEnd(model) {
  const lastRow = model.lines.length - 1
  model.row = lastRow
  model.col = model.lines[lastRow].length
  model.historyArrowAttempt = 0
}

// --- History ---
/** Replace editor content and place cursor at the specified position */
function loadContent(model, content, cursor = 'end') {
  const newLines = content.split('\n')
  model.lines = newLines
  model.row = newLines.length - 1
  model.col = model.row >= 0 ? newLines[model.row].length : 0
  if (cursor === 'start') {
    model.row = 0
    model.col = 0
  }
}

/** Navigate to the previous history entry, saving current content as draft */
export function historyPrev(model) {
  if (model.historyIndex <= 0) return
  if (model.historyIndex === model.history.length) {
    model.draft = model.lines.join('\n')
  }
  model.historyIndex--
  loadContent(model, model.history[model.historyIndex], 'start')
}

/** Navigate to the next history entry, or restore draft at the end */
export function historyNext(model) {
  if (model.historyIndex >= model.history.length) return
  model.historyIndex++
  if (model.historyIndex === model.history.length) {
    loadContent(model, model.draft)
  } else {
    loadContent(model, model.history[model.historyIndex])
  }
}
