import type { EditorState } from "./types.js";
/** Move cursor one character to the left, crossing line boundaries */
export declare function moveLeft(state: EditorState): void;
/** Move cursor one character to the right, crossing line boundaries */
export declare function moveRight(state: EditorState): void;
/** Move cursor one line up, preserving visual column position */
export declare function moveUp(state: EditorState): void;
/** Move cursor one line down, preserving visual column position */
export declare function moveDown(state: EditorState): void;
/** Move up or navigate history when at the first line */
export declare function moveUpOrHistory(state: EditorState): void;
/** Move down or navigate history when at the last line */
export declare function moveDownOrHistory(state: EditorState): void;
/** Jump cursor to the end of the next word */
export declare function wordRight(state: EditorState): void;
/** Jump cursor to the start of the previous word */
export declare function wordLeft(state: EditorState): void;
/** Move cursor to the start of the current line */
export declare function lineStart(state: EditorState): void;
/** Move cursor to the end of the current line */
export declare function lineEnd(state: EditorState): void;
/** Move cursor to the start of the entire input */
export declare function bufferStart(state: EditorState): void;
/** Move cursor to the end of the entire input */
export declare function bufferEnd(state: EditorState): void;
/** Replace editor content and place cursor at the specified position */
export declare function loadContent(state: EditorState, content: string, cursor?: "start" | "end"): void;
/** Navigate to the previous history entry, saving current content as draft */
export declare function historyPrev(state: EditorState): void;
/** Navigate to the next history entry, or restore draft at the end */
export declare function historyNext(state: EditorState): void;
