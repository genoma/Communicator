import type { EditorState, Snapshot } from "./types.js";
/** Return the highlighted (or styled) text for a given line */
export declare function renderLine(state: EditorState, rowIndex: number): string;
/** Write text to the output stream (or buffer if batching) */
export declare function w(state: EditorState, text: string): void;
/** Begin buffering output writes for flicker-free batch rendering */
export declare function beginBatch(state: EditorState): void;
/** Flush buffered output with cursor hidden during the write */
export declare function flushBatch(state: EditorState): void;
/** Get the line prefix display width (same for all input rows) */
export declare function pW(state: EditorState): number;
export declare function cursorVisualRow(state: EditorState, row: number, col: number, headerHeight?: number): number;
/** Visual row of the editor's first logical row, col 0. */
export declare function editorTopVisualRow(state: EditorState): number;
/**
 * Reposition the cursor back to (state.row, state.col) after writing `advanced`
 * display columns from the cursor's original position at (state.row, state.col).
 * Handles soft-wrap reflow that bare `\x1b[<n>D` does not.
 */
export declare function rewindAfterAdvance(state: EditorState, advanced: number): void;
export declare function lastVisualRow(state: EditorState): number;
/** Get 1-based terminal column from line start to code unit index, accounting for display width */
export declare function tCol(state: EditorState, r: number, c: number): number;
/** Style input text according to the theme */
export declare function styledInput(state: EditorState, text: string): string;
/** Move terminal cursor from current position to (newRow, newCol) */
export declare function moveTo(state: EditorState, newRow: number, newCol: number): void;
/** Draw status line and footer below the editor content, then return cursor to position */
export declare function drawBelowEditor(state: EditorState): void;
/** Clear the status line and reset status state */
export declare function clearStatus(state: EditorState): void;
/** Display or update the status line with the given text and color */
export declare function setStatus(state: EditorState, text: string, color: "red" | "green" | ""): void;
/** Set footer text and redraw the area below the editor */
export declare function setFooter(state: EditorState, text: string): void;
/** Clear all content below the editor (status and footer) for cleanup */
export declare function clearBelowEditor(state: EditorState): void;
/** Update the visual state (prefix/linePrefix) and recompute derived fields */
export declare function setVisualState(state: EditorState, visualState: "pending" | "error"): void;
/** Set status and update visual state, minimizing redraws */
export declare function setStatusWithVisualState(state: EditorState, text: string, color: "red" | "green" | "", visualState: "pending" | "error"): void;
/**
 * Redraw all lines from fromRow onwards, placing cursor at (targetRow, targetCol).
 *
 * `previousCursorVisualRow` overrides the source of the cursor-rewind delta. Pass it when
 * `state.lines` has already been edited but the terminal cursor is still where it was
 * *before* the edit (e.g. line-shrinking deletions where computing from the new lines
 * would underestimate the rewind distance).
 */
export declare function redrawFrom(state: EditorState, fromRow: number, targetRow: number, targetCol: number, options?: {
    previousCursorVisualRow?: number;
}): void;
/** Clear screen and redraw all content with in-place rendering to reduce flicker */
export declare function clearScreen(state: EditorState): void;
/** Restore editor state from a snapshot and redraw */
export declare function restoreSnapshot(state: EditorState, snap: Snapshot): void;
/** Redraw current line after deleting characters of the given display width at cursor */
export declare function redrawAfterDelete(state: EditorState, deletedWidth: number): void;
