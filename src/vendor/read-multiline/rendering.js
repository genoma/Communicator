import { stringWidth } from "./chars.js";
import { applyStyle, buildPromptHeader, buildStyledLinePrefix, computeHeaderHeight, resolveStateful, } from "./style.js";
/** Get the prompt header width for inline mode (0 if not inline) */
function getPromptHeaderWidth(state) {
    return state.inlinePrompt ? stringWidth(state.promptHeader) : 0;
}
/** Return the highlighted (or styled) text for a given line */
export function renderLine(state, rowIndex) {
    const line = state.lines[rowIndex];
    return state.highlight ? state.highlight(line, rowIndex) : styledInput(state, line);
}
/** Write text to the output stream (or buffer if batching) */
export function w(state, text) {
    if (state.buffering) {
        state.writeBuffer += text;
    }
    else {
        state.output.write(text);
    }
}
/** Begin buffering output writes for flicker-free batch rendering */
export function beginBatch(state) {
    state.buffering = true;
    state.writeBuffer = "";
}
/** Flush buffered output with cursor hidden during the write */
export function flushBatch(state) {
    state.buffering = false;
    if (state.writeBuffer) {
        state.output.write("\x1b[?25l" + state.writeBuffer + "\x1b[?25h");
        state.writeBuffer = "";
    }
}
/** Get the line prefix display width (same for all input rows) */
export function pW(state) {
    return state.linePrefixWidth;
}
/** Get the row-start offset: prompt header width on row 0 in inline mode, linePrefix width otherwise */
function rowStartOffset(state, r) {
    return state.inlinePrompt && r === 0 ? getPromptHeaderWidth(state) : pW(state);
}
function terminalColumns(state) {
    const output = state.output;
    return typeof output.columns === "number" && output.columns > 0 ? output.columns : null;
}
function clampRow(state, row) {
    return Math.max(0, Math.min(row, state.lines.length - 1));
}
function clampCol(state, row, col) {
    const safeRow = clampRow(state, row);
    return Math.max(0, Math.min(col, state.lines[safeRow].length));
}
function visualRowOffset(state, row, col) {
    const safeRow = clampRow(state, row);
    const safeCol = clampCol(state, safeRow, col);
    const cols = terminalColumns(state);
    if (!cols)
        return 0;
    const width = rowStartOffset(state, safeRow) + stringWidth(state.lines[safeRow].slice(0, safeCol));
    return width > 0 ? Math.floor((width - 1) / cols) : 0;
}
function lineVisualRows(state, row) {
    const safeRow = clampRow(state, row);
    return visualRowOffset(state, safeRow, state.lines[safeRow].length) + 1;
}
function firstVisualRow(state, row, headerHeight = state.promptHeaderHeight) {
    let visualRow = state.inlinePrompt ? 0 : headerHeight;
    const limit = Math.max(0, Math.min(row, state.lines.length));
    for (let index = 0; index < limit; index++) {
        visualRow += lineVisualRows(state, index);
    }
    return visualRow;
}
export function cursorVisualRow(state, row, col, headerHeight = state.promptHeaderHeight) {
    if (row >= state.lines.length)
        return firstVisualRow(state, row, headerHeight);
    const safeRow = clampRow(state, row);
    return firstVisualRow(state, safeRow, headerHeight) + visualRowOffset(state, safeRow, col);
}
/** Visual row of the editor's first logical row, col 0. */
export function editorTopVisualRow(state) {
    return state.inlinePrompt ? 0 : state.promptHeaderHeight;
}
/**
 * Reposition the cursor back to (state.row, state.col) after writing `advanced`
 * display columns from the cursor's original position at (state.row, state.col).
 * Handles soft-wrap reflow that bare `\x1b[<n>D` does not.
 */
export function rewindAfterAdvance(state, advanced) {
    if (advanced <= 0)
        return;
    const cols = terminalColumns(state);
    const targetTCol = tCol(state, state.row, state.col);
    if (cols === null) {
        w(state, `\x1b[${advanced}D`);
        return;
    }
    const totalCols = targetTCol - 1 + advanced;
    let rowsDown = Math.floor(totalCols / cols);
    // Deferred-wrap edge: writing exactly cols*k chars leaves the cursor on the
    // last column of row k-1 (relative) with pending wrap, not on col 0 of row k.
    if (totalCols > 0 && totalCols % cols === 0)
        rowsDown -= 1;
    if (rowsDown > 0)
        w(state, `\x1b[${rowsDown}A`);
    w(state, `\x1b[${targetTCol}G`);
}
export function lastVisualRow(state) {
    return (firstVisualRow(state, state.lines.length - 1) +
        lineVisualRows(state, state.lines.length - 1) -
        1);
}
/** Get 1-based terminal column from line start to code unit index, accounting for display width */
export function tCol(state, r, c) {
    const safeRow = clampRow(state, r);
    const safeCol = clampCol(state, safeRow, c);
    const width = rowStartOffset(state, safeRow) + stringWidth(state.lines[safeRow].slice(0, safeCol));
    const cols = terminalColumns(state);
    if (!cols)
        return width + 1;
    if (width === 0)
        return 1;
    const remainder = width % cols;
    return remainder === 0 ? cols : remainder + 1;
}
/** Style input text according to the theme */
export function styledInput(state, text) {
    return applyStyle(text, state.theme?.input);
}
/** Move terminal cursor from current position to (newRow, newCol) */
export function moveTo(state, newRow, newCol) {
    const currentVisualRow = cursorVisualRow(state, state.row, state.col);
    const newVisualRow = cursorVisualRow(state, newRow, newCol);
    const dr = newVisualRow - currentVisualRow;
    if (dr < 0)
        w(state, `\x1b[${-dr}A`);
    else if (dr > 0)
        w(state, `\x1b[${dr}B`);
    w(state, `\x1b[${tCol(state, newRow, newCol)}G`);
    state.row = newRow;
    state.col = newCol;
}
/** Draw status line and footer below the editor content, then return cursor to position */
export function drawBelowEditor(state) {
    if (!state.statusText && !state.footerText)
        return;
    const currentVisualRow = cursorVisualRow(state, state.row, state.col);
    const endVisualRow = lastVisualRow(state);
    const dr = endVisualRow - currentVisualRow;
    if (dr > 0)
        w(state, `\x1b[${dr}B`);
    else if (dr < 0)
        w(state, `\x1b[${-dr}A`);
    let linesBelow = 0;
    if (state.statusText) {
        w(state, "\r\n");
        linesBelow++;
        const errorStyle = state.statusColor === "red" ? state.theme?.error : undefined;
        const successStyle = state.statusColor === "green" ? state.theme?.success : undefined;
        const themeStyle = errorStyle ?? successStyle;
        if (themeStyle) {
            w(state, applyStyle(state.statusText, themeStyle));
        }
        else {
            if (state.statusColor === "red")
                w(state, "\x1b[31m");
            else if (state.statusColor === "green")
                w(state, "\x1b[32m");
            w(state, state.statusText);
            if (state.statusColor)
                w(state, "\x1b[0m");
        }
        w(state, "\x1b[K");
    }
    if (state.footerText) {
        const footerLines = state.footerText.split("\n");
        for (const line of footerLines) {
            w(state, "\r\n");
            linesBelow++;
            w(state, line + "\x1b[K");
        }
    }
    const upCount = endVisualRow - currentVisualRow + linesBelow;
    if (upCount > 0)
        w(state, `\x1b[${upCount}A`);
    w(state, `\x1b[${tCol(state, state.row, state.col)}G`);
}
/** Clear everything below the editor (status + footer) and return cursor to position */
function clearBelowAndReturn(state) {
    const currentVisualRow = cursorVisualRow(state, state.row, state.col);
    const endVisualRow = lastVisualRow(state);
    const dr = endVisualRow - currentVisualRow;
    if (dr > 0)
        w(state, `\x1b[${dr}B`);
    else if (dr < 0)
        w(state, `\x1b[${-dr}A`);
    w(state, "\r\n\x1b[J");
    const upCount = endVisualRow + 1 - currentVisualRow;
    if (upCount > 0)
        w(state, `\x1b[${upCount}A`);
    w(state, `\x1b[${tCol(state, state.row, state.col)}G`);
}
/** Clear the status line and reset status state */
export function clearStatus(state) {
    if (!state.statusText)
        return;
    clearBelowAndReturn(state);
    state.statusText = "";
    state.statusColor = "";
    drawBelowEditor(state);
}
/** Display or update the status line with the given text and color */
export function setStatus(state, text, color) {
    if (state.statusText || state.footerText)
        clearBelowAndReturn(state);
    state.statusText = text;
    state.statusColor = color;
    drawBelowEditor(state);
}
/** Set footer text and redraw the area below the editor */
export function setFooter(state, text) {
    if (state.statusText || state.footerText)
        clearBelowAndReturn(state);
    state.footerText = text;
    drawBelowEditor(state);
}
const MAX_SUGGESTIONS = 8;
/**
 * Render the suggestion list into the footer slot (or restore the help footer).
 * Trigger rule: single-line buffer, cursor at end of line, line starts with "/",
 * and the line is a non-exact-match prefix of at least one suggestion.
 */
export function refreshSuggestions(state) {
    if (state.validationActive)
        return;
    const restoreFooter = () => {
        setFooter(state, state.rebuildFooter
            ? state.rebuildFooter(state.output?.columns ?? 80)
            : state.baseFooterText);
    };
    if (!state.suggest)
        return;
    if (state.lines.length !== 1) {
        restoreFooter();
        return;
    }
    const value = state.lines[0];
    if (!value.startsWith("/") || state.col !== value.length) {
        restoreFooter();
        return;
    }
    const items = state.suggest({ value, cursor: state.col });
    const matches = Array.isArray(items) ? items.filter((item) => typeof item === "string" && item.startsWith(value)) : [];
    if (matches.length === 0 || matches.includes(value)) {
        restoreFooter();
        return;
    }
    const shown = matches.slice(0, MAX_SUGGESTIONS);
    const selectedIndex = matches.indexOf(value);
    const selected = selectedIndex !== -1 ? selectedIndex : 0;
    const footerLines = shown.map((item, index) => {
        const marker = index === selected ? "› " : "  ";
        const styled = index === selected ? applyStyle(item, ["bold", "cyan"]) : applyStyle(item, "dim");
        return marker + styled;
    });
    if (matches.length > shown.length) {
        footerLines.push(applyStyle(`… ${matches.length - shown.length} more`, "dim"));
    }
    setFooter(state, footerLines.join("\n"));
}
/** Clear all content below the editor (status and footer) for cleanup */
export function clearBelowEditor(state) {
    if (!state.statusText && !state.footerText)
        return;
    clearBelowAndReturn(state);
    state.statusText = "";
    state.statusColor = "";
    state.footerText = "";
}
/** Update the visual state (prefix/linePrefix) and recompute derived fields */
export function setVisualState(state, visualState) {
    if (state.visualState === visualState)
        return;
    state.visualState = visualState;
    state.promptHeader = buildPromptHeader(state.prefixOption, state.rawPrompt, state.theme, visualState);
    // In inline mode, header is on same line as input
    state.promptHeaderHeight = state.inlinePrompt ? 0 : computeHeaderHeight(state.promptHeader);
    state.styledLinePrefix = buildStyledLinePrefix(state.linePrefixOption, state.theme, visualState);
    const rawLinePrefix = resolveStateful(state.linePrefixOption, visualState);
    state.linePrefixWidth = stringWidth(rawLinePrefix);
}
/** Set status and update visual state, minimizing redraws */
export function setStatusWithVisualState(state, text, color, visualState) {
    const visualChanged = state.visualState !== visualState;
    if (visualChanged) {
        // Capture old header height before updating, for correct cursor rewind
        const oldHeaderHeight = state.promptHeaderHeight;
        setVisualState(state, visualState);
        // Full redraw since prefix/linePrefix changed
        if (state.statusText || state.footerText)
            clearBelowAndReturn(state);
        state.statusText = text;
        state.statusColor = color;
        fullRedraw(state, oldHeaderHeight);
    }
    else {
        setStatus(state, text, color);
    }
}
/**
 * Redraw all lines from fromRow onwards, placing cursor at (targetRow, targetCol).
 *
 * `previousCursorVisualRow` overrides the source of the cursor-rewind delta. Pass it when
 * `state.lines` has already been edited but the terminal cursor is still where it was
 * *before* the edit (e.g. line-shrinking deletions where computing from the new lines
 * would underestimate the rewind distance).
 */
export function redrawFrom(state, fromRow, targetRow, targetCol, options) {
    beginBatch(state);
    const currentVisualRow = options?.previousCursorVisualRow ?? cursorVisualRow(state, state.row, state.col);
    const fromVisualRow = firstVisualRow(state, fromRow);
    const dr = fromVisualRow - currentVisualRow;
    if (dr < 0)
        w(state, `\x1b[${-dr}A`);
    else if (dr > 0)
        w(state, `\x1b[${dr}B`);
    w(state, `\x1b[${tCol(state, fromRow, 0)}G`);
    w(state, "\x1b[J");
    // Note: In inline prompt mode, tCol(state, 0, 0) already positions the cursor
    // *after* the existing prompt header, so the header on the terminal is preserved
    // and we must not re-emit it here (doing so would duplicate the header).
    w(state, renderLine(state, fromRow));
    for (let i = fromRow + 1; i < state.lines.length; i++) {
        w(state, "\n" + state.styledLinePrefix + renderLine(state, i));
    }
    const endVisualRow = lastVisualRow(state);
    const targetVisualRow = cursorVisualRow(state, targetRow, targetCol);
    if (endVisualRow > targetVisualRow)
        w(state, `\x1b[${endVisualRow - targetVisualRow}A`);
    else if (endVisualRow < targetVisualRow)
        w(state, `\x1b[${targetVisualRow - endVisualRow}B`);
    w(state, `\x1b[${tCol(state, targetRow, targetCol)}G`);
    state.row = targetRow;
    state.col = targetCol;
    drawBelowEditor(state);
    flushBatch(state);
}
/**
 * Full redraw: rewind cursor, redraw prompt header and all input lines, restore cursor.
 * @param rewindHeaderHeight - header height to use for cursor rewind (may differ from current
 *   state.promptHeaderHeight when the visual state has just changed)
 */
function fullRedraw(state, rewindHeaderHeight) {
    beginBatch(state);
    const upCount = cursorVisualRow(state, state.row, state.col, rewindHeaderHeight ?? state.promptHeaderHeight);
    if (upCount > 0)
        w(state, `\x1b[${upCount}A`);
    w(state, "\r");
    // Draw prompt header if present
    if (state.promptHeaderHeight > 0 || state.inlinePrompt) {
        // In inline mode, draw header inline (no newline after)
        // In non-inline mode, draw header and newline after
        if (state.inlinePrompt) {
            w(state, state.promptHeader);
        }
        else {
            const headerLines = state.promptHeader.split("\n");
            for (let i = 0; i < headerLines.length; i++) {
                if (i > 0)
                    w(state, "\n");
                w(state, headerLines[i] + "\x1b[K");
            }
            w(state, "\n");
        }
    }
    // Draw all input lines with linePrefix
    // In inline mode, row 0 starts with the prompt header (no linePrefix)
    if (state.inlinePrompt) {
        w(state, renderLine(state, 0) + "\x1b[K");
    }
    else {
        w(state, state.styledLinePrefix + renderLine(state, 0) + "\x1b[K");
    }
    for (let i = 1; i < state.lines.length; i++) {
        w(state, "\n" + state.styledLinePrefix + renderLine(state, i) + "\x1b[K");
    }
    w(state, "\x1b[J");
    const endVisualRow = lastVisualRow(state);
    const targetVisualRow = cursorVisualRow(state, state.row, state.col);
    if (endVisualRow > targetVisualRow)
        w(state, `\x1b[${endVisualRow - targetVisualRow}A`);
    else if (endVisualRow < targetVisualRow)
        w(state, `\x1b[${targetVisualRow - endVisualRow}B`);
    w(state, `\x1b[${tCol(state, state.row, state.col)}G`);
    drawBelowEditor(state);
    flushBatch(state);
}
/** Clear screen and redraw all content with in-place rendering to reduce flicker */
export function clearScreen(state) {
    fullRedraw(state);
}
/** Restore editor state from a snapshot and redraw */
export function restoreSnapshot(state, snap) {
    beginBatch(state);
    const currentVisualRow = cursorVisualRow(state, state.row, state.col);
    const inputStartVisualRow = state.inlinePrompt ? 0 : state.promptHeaderHeight;
    state.lines.length = 0;
    state.lines.push(...snap.lines);
    const upToInputStart = currentVisualRow - inputStartVisualRow;
    if (upToInputStart > 0)
        w(state, `\x1b[${upToInputStart}A`);
    w(state, "\r");
    // Position cursor after row-0's leading segment: prompt header in inline mode,
    // linePrefix otherwise. The header/prefix is already on-screen and must not be
    // re-emitted here (doing so would duplicate or misalign it).
    const col = rowStartOffset(state, 0);
    w(state, `\x1b[${col + 1}G`);
    w(state, "\x1b[J");
    w(state, renderLine(state, 0));
    for (let i = 1; i < state.lines.length; i++) {
        w(state, "\n" + state.styledLinePrefix + renderLine(state, i));
    }
    const endVisualRow = lastVisualRow(state);
    const targetVisualRow = cursorVisualRow(state, snap.row, snap.col);
    if (endVisualRow > targetVisualRow)
        w(state, `\x1b[${endVisualRow - targetVisualRow}A`);
    else if (endVisualRow < targetVisualRow)
        w(state, `\x1b[${targetVisualRow - endVisualRow}B`);
    w(state, `\x1b[${tCol(state, snap.row, snap.col)}G`);
    state.row = snap.row;
    state.col = snap.col;
    drawBelowEditor(state);
    flushBatch(state);
}
/** Redraw current line after deleting characters of the given display width at cursor */
export function redrawAfterDelete(state, deletedWidth) {
    const rest = state.lines[state.row].slice(state.col);
    const restW = stringWidth(rest);
    // Pre-call cursor sits `deletedWidth` cells to the right of (row, col).
    // Reflow upward correctly if that distance crossed a soft-wrap.
    if (deletedWidth > 0)
        rewindAfterAdvance(state, deletedWidth);
    w(state, styledInput(state, rest));
    if (deletedWidth > 0)
        w(state, " ".repeat(deletedWidth));
    if (restW + deletedWidth > 0)
        rewindAfterAdvance(state, restW + deletedWidth);
}
