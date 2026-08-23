import type { EditorState } from "./types.js";
/** Build the key-to-action mapping based on options and callbacks */
export declare function buildKeyMap(state: EditorState, submit: () => void, cancel: () => void, handleEOF: () => void): void;
/** Handle raw data from the input stream, reassembling sequences split across chunks */
export declare function onData(state: EditorState, data: Buffer): void;
