import type { EditorState } from "./types.js";
/** Build the key-to-action mapping based on options and callbacks */
export declare function buildKeyMap(state: EditorState, submit: () => void, cancel: () => void, handleEOF: () => void): void;
/** Process an input sequence: handle paste markers, key map lookups, and character insertion */
export declare function processInput(state: EditorState, seq: string): void;
/** Handle raw data from the input stream, buffering ESC sequences as needed */
export declare function onData(state: EditorState, data: Buffer): void;
