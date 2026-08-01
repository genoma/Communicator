import { charAtIndex, charBeforeIndex, charWidth, contentLength, isWordChar, stringWidth, } from "./chars.js";
import { beginBatch, clearStatus, cursorVisualRow, flushBatch, lastVisualRow, moveTo, pW, redrawAfterDelete, redrawFrom, refreshSuggestions, renderLine, restoreFooter, restoreSnapshot, rewindAfterAdvance, setStatusWithVisualState, styledInput, tCol, w, } from "./rendering.js";
const MAX_UNDO = 200;
// --- Undo / Redo ---
/** Capture current editor state as a snapshot for undo/redo */
export function takeSnapshot(state) {
    return { lines: [...state.lines], row: state.row, col: state.col };
}
/** Push current state to undo stack, grouping consecutive character insertions */
export function saveUndo(state, editType = "other") {
    if (editType === "insert" && state.lastEditType === "insert" && state.undoStack.length > 0) {
        state.lastEditType = editType;
        return;
    }
    state.lastEditType = editType;
    state.undoStack.push(takeSnapshot(state));
    if (state.undoStack.length > MAX_UNDO)
        state.undoStack.shift();
    state.redoStack.length = 0;
}
/** Restore previous state from undo stack */
export function undo(state) {
    if (state.undoStack.length === 0)
        return;
    state.redoStack.push(takeSnapshot(state));
    const snap = state.undoStack.pop();
    restoreSnapshot(state, snap);
    state.lastEditType = "";
    onContentChanged(state);
}
/** Restore next state from redo stack */
export function redo(state) {
    if (state.redoStack.length === 0)
        return;
    state.undoStack.push(takeSnapshot(state));
    const snap = state.redoStack.pop();
    restoreSnapshot(state, snap);
    state.lastEditType = "";
    onContentChanged(state);
}
// --- Validation / Content change ---
function scheduleValidation(state) {
    if (!state.validationActive || !state.validate)
        return;
    if (state.validateTimer)
        clearTimeout(state.validateTimer);
    state.validateTimer = setTimeout(() => {
        state.validateTimer = null;
        const error = state.validate(state.lines.join("\n"));
        if (error) {
            setStatusWithVisualState(state, error, "red", "error");
        }
        else {
            setStatusWithVisualState(state, "OK", "green", "pending");
        }
    }, state.validateDebounceMs);
}
/** Handle content changes: check limits and trigger validation */
export function onContentChanged(state) {
    if (state.maxLength != null) {
        const len = contentLength(state.lines);
        if (len >= state.maxLength) {
            setStatusWithVisualState(state, `Maximum ${state.maxLength} characters`, "red", "error");
            return;
        }
    }
    if (state.validationActive) {
        scheduleValidation(state);
    }
    else if (state.visualState === "error") {
        // Revert to pending when limit error clears and no active validation
        setStatusWithVisualState(state, "", "", "pending");
    }
    else {
        clearStatus(state);
    }
    if (!state.validationActive) {
        refreshSuggestions(state);
    }
}
/** Compute the next selection within the active suggestion session, or null when the line would not change */
export function nextSuggestionMove(session, value, dir) {
    if (!session)
        return null;
    const selected = session.matches.indexOf(value);
    const start = selected !== -1 ? selected : dir > 0 ? -1 : 0;
    const index = (start + dir + session.matches.length) % session.matches.length;
    const nextLine = session.matches[index];
    if (nextLine === value)
        return null;
    return { line: nextLine, index };
}
/**
 * Navigate the active suggestion session in the given direction, filling the line
 * with the selected match. Returns true when the key press was consumed (either by
 * navigating or by an active single-match session), false when no session is active
 * so callers can fall back to history navigation.
 */
export function suggestMove(state, dir) {
    const session = state.suggestSession;
    if (!session || state.lines.length !== 1)
        return false;
    const value = state.lines[0];
    if (!value.startsWith("/") || state.col !== value.length)
        return false;
    const move = nextSuggestionMove(session, value, dir);
    if (!move)
        return true;
    saveUndo(state);
    state.lines[0] = move.line;
    state.row = 0;
    state.col = move.line.length;
    state.suggestSession = { ...session, index: move.index };
    redrawFrom(state, 0, 0, move.line.length);
    refreshSuggestions(state);
    return true;
}
/** Dismiss the active suggestion session, restoring the typed prefix and the help footer */
export function dismissSuggestions(state) {
    const session = state.suggestSession;
    if (!session)
        return;
    saveUndo(state);
    state.lines[0] = session.prefix;
    state.row = 0;
    state.col = session.prefix.length;
    state.suggestSession = null;
    redrawFrom(state, 0, 0, session.prefix.length);
    restoreFooter(state);
}
/** Cycle the suggestion list (Tab / Shift+Tab): alias of suggestMove */
export function cycleSuggestion(state, dir) {
    suggestMove(state, dir);
}
// --- Limit checks ---
function canInsertChar(state, charCount = 1) {
    if (state.maxLength != null) {
        const len = contentLength(state.lines);
        if (len + charCount > state.maxLength) {
            setStatusWithVisualState(state, `Maximum ${state.maxLength} characters`, "red", "error");
            return false;
        }
    }
    return true;
}
function canInsertNewline(state) {
    if (state.maxLines != null && state.lines.length >= state.maxLines) {
        setStatusWithVisualState(state, `Maximum ${state.maxLines} lines`, "red", "error");
        return false;
    }
    if (state.maxLength != null) {
        const len = contentLength(state.lines);
        if (len + 1 > state.maxLength) {
            setStatusWithVisualState(state, `Maximum ${state.maxLength} characters`, "red", "error");
            return false;
        }
    }
    return true;
}
// --- Transform ---
/**
 * Capture pre-edit lines snapshot when transform is active (not during paste).
 *
 * NOTE: Only invoked from the four core edit operations (insertChar, insertNewline,
 * handleBackspace, handleDelete). Other editing actions (deleteToLineStart,
 * deleteToLineEnd, deleteWordBack) bypass transform/highlight-aware rendering.
 */
function capturePreEdit(state) {
    return state.transform && !state.isPasting ? [...state.lines] : null;
}
/**
 * Apply the user-provided transform callback after an edit, then render once.
 * Diffs preEditLines (before base edit) vs final state to minimize redraw scope.
 * targetRow/targetCol is the logical cursor position after the base edit.
 */
function applyTransform(state, event, preEditLines, targetRow, targetCol) {
    const result = state.transform({ lines: [...state.lines], row: targetRow, col: targetCol }, event);
    if (result) {
        const newLines = result.lines.length > 0 ? result.lines : [""];
        const safeRow = Number.isFinite(result.row) ? result.row : targetRow;
        const safeCol = Number.isFinite(result.col) ? result.col : targetCol;
        let newRow = Math.max(0, Math.min(safeRow, newLines.length - 1));
        let newCol = Math.max(0, Math.min(safeCol, newLines[newRow].length));
        state.lines.length = 0;
        state.lines.push(...newLines);
        targetRow = newRow;
        targetCol = newCol;
    }
    // Diff pre-edit vs final state (covers both base edit + transform changes)
    let fromRow = 0;
    while (fromRow < preEditLines.length &&
        fromRow < state.lines.length &&
        preEditLines[fromRow] === state.lines[fromRow]) {
        fromRow++;
    }
    if (fromRow < state.lines.length || fromRow < preEditLines.length) {
        // Guard: both sides must have at least one line for redrawFrom to work
        if (state.lines.length === 0 || preEditLines.length === 0) {
            moveTo(state, targetRow, targetCol);
            return;
        }
        // Clamp: fromRow must be a valid row in both the terminal (preEditLines)
        // and the final state, otherwise redrawFrom can't navigate or access it.
        const maxRow = Math.min(preEditLines.length, state.lines.length) - 1;
        if (fromRow > maxRow)
            fromRow = Math.max(0, maxRow);
        redrawFrom(state, fromRow, targetRow, targetCol);
    }
    else if (targetRow !== state.row || targetCol !== state.col) {
        moveTo(state, targetRow, targetCol);
    }
}
// --- Editing operations ---
/** Insert a character at the current cursor position */
export function insertChar(state, ch) {
    if (!canInsertChar(state, [...ch].length))
        return;
    if (!state.isPasting)
        saveUndo(state, "insert");
    const preEditLines = capturePreEdit(state);
    const previousRow = state.row;
    const previousCol = state.col;
    const hadContentBelow = Boolean(state.statusText || state.footerText) || state.row < state.lines.length - 1;
    const previousLastVisualRow = hadContentBelow ? lastVisualRow(state) : 0;
    state.lines[state.row] =
        state.lines[state.row].slice(0, state.col) + ch + state.lines[state.row].slice(state.col);
    state.col += ch.length;
    const targetRow = state.row;
    const targetCol = state.col;
    if (preEditLines) {
        applyTransform(state, { type: "insert", char: ch }, preEditLines, state.row, state.col);
    }
    else if (!state.isPasting &&
        hadContentBelow &&
        lastVisualRow(state) !== previousLastVisualRow) {
        state.row = previousRow;
        state.col = previousCol;
        redrawFrom(state, previousRow, targetRow, targetCol);
    }
    else if (state.highlight && !state.isPasting) {
        // Full-line redraw when highlighting is enabled (skipped during paste for performance)
        beginBatch(state);
        w(state, `\x1b[${pW(state) + 1}G\x1b[K`);
        w(state, renderLine(state, state.row));
        w(state, `\x1b[${tCol(state, state.row, state.col)}G`);
        flushBatch(state);
    }
    else {
        const rest = state.lines[state.row].slice(state.col);
        w(state, styledInput(state, ch + rest));
        const restW = stringWidth(rest);
        if (restW > 0)
            rewindAfterAdvance(state, restW);
    }
    onContentChanged(state);
}
/** Insert a newline at the current cursor position, splitting the current line */
export function insertNewline(state) {
    if (!canInsertNewline(state))
        return;
    if (!state.isPasting)
        saveUndo(state);
    const preEditLines = capturePreEdit(state);
    const after = state.lines[state.row].slice(state.col);
    state.lines[state.row] = state.lines[state.row].slice(0, state.col);
    state.lines.splice(state.row + 1, 0, after);
    if (preEditLines) {
        applyTransform(state, { type: "newline" }, preEditLines, state.row + 1, 0);
    }
    else {
        redrawFrom(state, state.row, state.row + 1, 0);
    }
    onContentChanged(state);
}
/** Delete the character before cursor, merging lines at line boundaries */
export function handleBackspace(state) {
    if (state.col > 0) {
        saveUndo(state);
        const preEditLines = capturePreEdit(state);
        const beforeCursorVR = cursorVisualRow(state, state.row, state.col);
        const beforeLastVR = lastVisualRow(state);
        const deleted = charBeforeIndex(state.lines[state.row], state.col);
        state.col -= deleted.length;
        state.lines[state.row] =
            state.lines[state.row].slice(0, state.col) +
                state.lines[state.row].slice(state.col + deleted.length);
        if (preEditLines) {
            applyTransform(state, { type: "backspace" }, preEditLines, state.row, state.col);
        }
        else if (lastVisualRow(state) !== beforeLastVR) {
            redrawFrom(state, state.row, state.row, state.col, {
                previousCursorVisualRow: beforeCursorVR,
            });
        }
        else if (state.highlight) {
            redrawFrom(state, state.row, state.row, state.col);
        }
        else {
            redrawAfterDelete(state, charWidth(deleted.codePointAt(0)));
        }
        onContentChanged(state);
    }
    else if (state.row > 0) {
        saveUndo(state);
        const preEditLines = capturePreEdit(state);
        const beforeCursorVR = cursorVisualRow(state, state.row, state.col);
        const prevLen = state.lines[state.row - 1].length;
        state.lines[state.row - 1] += state.lines[state.row];
        state.lines.splice(state.row, 1);
        if (preEditLines) {
            applyTransform(state, { type: "backspace" }, preEditLines, state.row - 1, prevLen);
        }
        else {
            redrawFrom(state, state.row - 1, state.row - 1, prevLen, {
                previousCursorVisualRow: beforeCursorVR,
            });
        }
        onContentChanged(state);
    }
}
/** Delete the character at cursor, merging lines at line boundaries */
export function handleDelete(state) {
    if (state.col < state.lines[state.row].length) {
        saveUndo(state);
        const preEditLines = capturePreEdit(state);
        const beforeCursorVR = cursorVisualRow(state, state.row, state.col);
        const beforeLastVR = lastVisualRow(state);
        const deleted = charAtIndex(state.lines[state.row], state.col);
        state.lines[state.row] =
            state.lines[state.row].slice(0, state.col) +
                state.lines[state.row].slice(state.col + deleted.length);
        if (preEditLines) {
            applyTransform(state, { type: "delete" }, preEditLines, state.row, state.col);
        }
        else if (lastVisualRow(state) !== beforeLastVR) {
            redrawFrom(state, state.row, state.row, state.col, {
                previousCursorVisualRow: beforeCursorVR,
            });
        }
        else if (state.highlight) {
            redrawFrom(state, state.row, state.row, state.col);
        }
        else {
            const rest = state.lines[state.row].slice(state.col);
            const restW = stringWidth(rest);
            const deletedW = charWidth(deleted.codePointAt(0));
            w(state, `${styledInput(state, rest)}${" ".repeat(deletedW)}`);
            rewindAfterAdvance(state, restW + deletedW);
        }
        onContentChanged(state);
    }
    else if (state.row < state.lines.length - 1) {
        saveUndo(state);
        const preEditLines = capturePreEdit(state);
        state.lines[state.row] += state.lines[state.row + 1];
        state.lines.splice(state.row + 1, 1);
        if (preEditLines) {
            applyTransform(state, { type: "delete" }, preEditLines, state.row, state.col);
        }
        else {
            redrawFrom(state, state.row, state.row, state.col);
        }
        onContentChanged(state);
    }
}
/** Delete all characters from cursor to the start of the current line */
export function deleteToLineStart(state) {
    if (state.col === 0)
        return;
    saveUndo(state);
    const beforeCursorVR = cursorVisualRow(state, state.row, state.col);
    const beforeLastVR = lastVisualRow(state);
    const deletedWidth = stringWidth(state.lines[state.row].slice(0, state.col));
    state.lines[state.row] = state.lines[state.row].slice(state.col);
    state.col = 0;
    if (lastVisualRow(state) !== beforeLastVR) {
        redrawFrom(state, state.row, state.row, state.col, {
            previousCursorVisualRow: beforeCursorVR,
        });
    }
    else {
        w(state, `\x1b[${pW(state) + 1}G`);
        w(state, styledInput(state, state.lines[state.row]));
        w(state, " ".repeat(deletedWidth));
        w(state, `\x1b[${pW(state) + 1}G`);
    }
    onContentChanged(state);
}
/** Delete all characters from cursor to the end of the current line */
export function deleteToLineEnd(state) {
    if (state.col >= state.lines[state.row].length)
        return;
    saveUndo(state);
    const beforeCursorVR = cursorVisualRow(state, state.row, state.col);
    const beforeLastVR = lastVisualRow(state);
    state.lines[state.row] = state.lines[state.row].slice(0, state.col);
    if (lastVisualRow(state) !== beforeLastVR) {
        redrawFrom(state, state.row, state.row, state.col, {
            previousCursorVisualRow: beforeCursorVR,
        });
    }
    else {
        w(state, "\x1b[K");
    }
    onContentChanged(state);
}
/** Delete the previous word (Ctrl+W behavior) */
export function deleteWordBack(state) {
    if (state.col === 0) {
        handleBackspace(state);
        return;
    }
    saveUndo(state);
    const beforeCursorVR = cursorVisualRow(state, state.row, state.col);
    const beforeLastVR = lastVisualRow(state);
    const line = state.lines[state.row];
    let c = state.col;
    while (c > 0 && !isWordChar(charBeforeIndex(line, c))) {
        c -= charBeforeIndex(line, c).length;
    }
    while (c > 0 && isWordChar(charBeforeIndex(line, c))) {
        c -= charBeforeIndex(line, c).length;
    }
    const deletedWidth = stringWidth(line.slice(c, state.col));
    state.lines[state.row] = line.slice(0, c) + line.slice(state.col);
    state.col = c;
    if (lastVisualRow(state) !== beforeLastVR) {
        redrawFrom(state, state.row, state.row, state.col, {
            previousCursorVisualRow: beforeCursorVR,
        });
    }
    else {
        redrawAfterDelete(state, deletedWidth);
    }
    onContentChanged(state);
}
