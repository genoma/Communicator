import type { EditorState, Snapshot } from "./types.js";
/** Capture current editor state as a snapshot for undo/redo */
export declare function takeSnapshot(state: EditorState): Snapshot;
/** Push current state to undo stack, grouping consecutive character insertions */
export declare function saveUndo(state: EditorState, editType?: "insert" | "other"): void;
/** Restore previous state from undo stack */
export declare function undo(state: EditorState): void;
/** Restore next state from redo stack */
export declare function redo(state: EditorState): void;
/** Handle content changes: check limits and trigger validation */
export declare function onContentChanged(state: EditorState): void;
/** Insert a character at the current cursor position */
export declare function insertChar(state: EditorState, ch: string): void;
/** Insert a newline at the current cursor position, splitting the current line */
export declare function insertNewline(state: EditorState): void;
/** Delete the character before cursor, merging lines at line boundaries */
export declare function handleBackspace(state: EditorState): void;
/** Delete the character at cursor, merging lines at line boundaries */
export declare function handleDelete(state: EditorState): void;
/** Delete all characters from cursor to the start of the current line */
export declare function deleteToLineStart(state: EditorState): void;
/** Delete all characters from cursor to the end of the current line */
export declare function deleteToLineEnd(state: EditorState): void;
/** Delete the previous word (Ctrl+W behavior) */
export declare function deleteWordBack(state: EditorState): void;
