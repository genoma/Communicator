import { charAtIndex, charBeforeIndex, colFromVisual, isWordChar, visualCol } from "./chars.js";
import { beginBatch, cursorVisualRow, drawBelowEditor, editorTopVisualRow, flushBatch, moveTo, pW, renderLine, tCol, w, } from "./rendering.js";
// --- Basic cursor movement ---
/** Move cursor one character to the left, crossing line boundaries */
export function moveLeft(state) {
    if (state.col > 0) {
        const oldVR = cursorVisualRow(state, state.row, state.col);
        const oldTCol = tCol(state, state.row, state.col);
        const ch = charBeforeIndex(state.lines[state.row], state.col);
        state.col -= ch.length;
        const newVR = cursorVisualRow(state, state.row, state.col);
        const newTCol = tCol(state, state.row, state.col);
        if (newVR !== oldVR) {
            // Soft-wrap boundary: \x1b[D doesn't reflow to previous visual row,
            // so reposition explicitly to the deferred-wrap column.
            w(state, `\x1b[${oldVR - newVR}A\x1b[${newTCol}G`);
        }
        else if (oldTCol !== newTCol) {
            // Same visual row: oldTCol === newTCol when crossing the deferred-wrap
            // edge (col stays at the rightmost column), so emit nothing.
            w(state, `\x1b[${oldTCol - newTCol}D`);
        }
    }
    else if (state.row > 0) {
        moveTo(state, state.row - 1, state.lines[state.row - 1].length);
    }
}
/** Move cursor one character to the right, crossing line boundaries */
export function moveRight(state) {
    if (state.col < state.lines[state.row].length) {
        const oldVR = cursorVisualRow(state, state.row, state.col);
        const oldTCol = tCol(state, state.row, state.col);
        const ch = charAtIndex(state.lines[state.row], state.col);
        state.col += ch.length;
        const newVR = cursorVisualRow(state, state.row, state.col);
        const newTCol = tCol(state, state.row, state.col);
        if (newVR !== oldVR) {
            // Soft-wrap boundary: \x1b[C clamps at the right edge, so step down
            // to the next visual row and position at the post-wrap column.
            w(state, `\x1b[${newVR - oldVR}B\x1b[${newTCol}G`);
        }
        else if (newTCol !== oldTCol) {
            // Same visual row: newTCol === oldTCol when entering the deferred-wrap
            // edge (col stays at the rightmost column), so emit nothing.
            w(state, `\x1b[${newTCol - oldTCol}C`);
        }
    }
    else if (state.row < state.lines.length - 1) {
        moveTo(state, state.row + 1, 0);
    }
}
/** Move cursor one line up, preserving visual column position */
export function moveUp(state) {
    if (state.row > 0) {
        const vc = visualCol(state.lines[state.row], state.col);
        const targetCol = colFromVisual(state.lines[state.row - 1], vc);
        moveTo(state, state.row - 1, targetCol);
    }
}
/** Move cursor one line down, preserving visual column position */
export function moveDown(state) {
    if (state.row < state.lines.length - 1) {
        const vc = visualCol(state.lines[state.row], state.col);
        const targetCol = colFromVisual(state.lines[state.row + 1], vc);
        moveTo(state, state.row + 1, targetCol);
    }
}
// --- Up/Down with history support ---
/** Move up or navigate history when at the first line */
export function moveUpOrHistory(state) {
    if (state.row > 0) {
        moveUp(state);
        state.historyArrowAttempt = 0;
    }
    else if (state.col > 0) {
        moveTo(state, 0, 0);
        state.historyArrowAttempt = 0;
    }
    else if (state.history.length > 0) {
        const nav = state.historyArrowNavigation;
        if (nav === "single") {
            historyPrev(state);
        }
        else if (nav === "double") {
            state.historyArrowAttempt++;
            if (state.historyArrowAttempt >= 2) {
                state.historyArrowAttempt = 0;
                historyPrev(state);
            }
        }
        // "disabled": do nothing
    }
}
/** Move down or navigate history when at the last line */
export function moveDownOrHistory(state) {
    if (state.row < state.lines.length - 1) {
        moveDown(state);
        state.historyArrowAttempt = 0;
    }
    else if (state.col < state.lines[state.row].length) {
        moveTo(state, state.row, state.lines[state.row].length);
        state.historyArrowAttempt = 0;
    }
    else if (state.historyIndex < state.history.length) {
        const nav = state.historyArrowNavigation;
        if (nav === "single") {
            historyNext(state);
        }
        else if (nav === "double") {
            state.historyArrowAttempt++;
            if (state.historyArrowAttempt >= 2) {
                state.historyArrowAttempt = 0;
                historyNext(state);
            }
        }
        // "disabled": do nothing
    }
}
// --- Word jump ---
/** Jump cursor to the end of the next word */
export function wordRight(state) {
    let r = state.row, c = state.col;
    while (r < state.lines.length) {
        const line = state.lines[r];
        while (c < line.length && !isWordChar(line[c]))
            c++;
        if (c < line.length)
            break;
        if (r < state.lines.length - 1) {
            r++;
            c = 0;
        }
        else
            break;
    }
    const line = state.lines[r];
    while (c < line.length && isWordChar(line[c]))
        c++;
    if (r !== state.row || c !== state.col)
        moveTo(state, r, c);
}
/** Jump cursor to the start of the previous word */
export function wordLeft(state) {
    let r = state.row, c = state.col;
    if (c > 0) {
        c--;
    }
    else if (r > 0) {
        r--;
        c = state.lines[r].length;
        if (c > 0)
            c--;
        else {
            moveTo(state, r, 0);
            return;
        }
    }
    else
        return;
    while (true) {
        const line = state.lines[r];
        while (c > 0 && !isWordChar(line[c]))
            c--;
        if (isWordChar(line[c]))
            break;
        if (r > 0) {
            r--;
            c = state.lines[r].length - 1;
            if (c < 0) {
                c = 0;
                break;
            }
        }
        else {
            c = 0;
            break;
        }
    }
    const line = state.lines[r];
    while (c > 0 && isWordChar(line[c - 1]))
        c--;
    moveTo(state, r, c);
}
// --- Line start/end, buffer start/end ---
/** Move cursor to the start of the current line */
export function lineStart(state) {
    if (state.col !== 0)
        moveTo(state, state.row, 0);
}
/** Move cursor to the end of the current line */
export function lineEnd(state) {
    if (state.col !== state.lines[state.row].length)
        moveTo(state, state.row, state.lines[state.row].length);
}
/** Move cursor to the start of the entire input */
export function bufferStart(state) {
    if (state.row !== 0 || state.col !== 0)
        moveTo(state, 0, 0);
}
/** Move cursor to the end of the entire input */
export function bufferEnd(state) {
    const lastRow = state.lines.length - 1;
    const lastCol = state.lines[lastRow].length;
    if (state.row !== lastRow || state.col !== lastCol)
        moveTo(state, lastRow, lastCol);
}
// --- History ---
/** Replace editor content and place cursor at the specified position */
export function loadContent(state, content, cursor = "end") {
    beginBatch(state);
    const newLines = content.split("\n");
    // Move cursor up to the first visual row of the editor area, accounting for
    // soft-wraps in the current content above the cursor.
    const topVR = editorTopVisualRow(state);
    const upBeforeClear = cursorVisualRow(state, state.row, state.col) - topVR;
    if (upBeforeClear > 0)
        w(state, `\x1b[${upBeforeClear}A`);
    w(state, "\r");
    w(state, `\x1b[${pW(state) + 1}G`);
    w(state, "\x1b[J");
    state.lines.length = 0;
    state.lines.push(...newLines);
    w(state, renderLine(state, 0));
    for (let i = 1; i < state.lines.length; i++) {
        w(state, "\n" + state.styledLinePrefix + renderLine(state, i));
    }
    // Writes leave the cursor on the last visual row of the last logical row.
    state.row = state.lines.length - 1;
    state.col = state.lines[state.row].length;
    if (cursor === "start") {
        const upAfter = cursorVisualRow(state, state.row, state.col) - topVR;
        if (upAfter > 0)
            w(state, `\x1b[${upAfter}A`);
        state.row = 0;
        state.col = 0;
        w(state, `\x1b[${tCol(state, 0, 0)}G`);
    }
    else {
        w(state, `\x1b[${tCol(state, state.row, state.col)}G`);
    }
    drawBelowEditor(state);
    flushBatch(state);
}
/** Navigate to the previous history entry, saving current content as draft */
export function historyPrev(state) {
    if (state.historyIndex <= 0)
        return;
    if (state.historyIndex === state.history.length) {
        state.draft = state.lines.join("\n");
    }
    state.historyIndex--;
    loadContent(state, state.history[state.historyIndex], "start");
}
/** Navigate to the next history entry, or restore draft at the end */
export function historyNext(state) {
    if (state.historyIndex >= state.history.length)
        return;
    state.historyIndex++;
    if (state.historyIndex === state.history.length) {
        loadContent(state, state.draft);
    }
    else {
        loadContent(state, state.history[state.historyIndex]);
    }
}
