import { cycleSuggestion, deleteToLineEnd, deleteToLineStart, deleteWordBack, handleBackspace, handleDelete, insertChar, insertNewline, redo, saveUndo, undo, } from "./editing.js";
import { bufferEnd, bufferStart, historyNext, historyPrev, lineEnd, lineStart, moveDownOrHistory, moveLeft, moveRight, moveUpOrHistory, wordLeft, wordRight, } from "./navigation.js";
import { clearScreen } from "./rendering.js";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESC_TIMEOUT = 50; // ms
/** Build the key-to-action mapping based on options and callbacks */
export function buildKeyMap(state, submit, cancel, handleEOF) {
    const keyMap = state.keyMap;
    // Enter key: submit or newline based on preferNewlineOnEnter
    const enterAction = state.preferNewlineOnEnter ? () => insertNewline(state) : submit;
    const modifiedAction = state.preferNewlineOnEnter ? submit : () => insertNewline(state);
    keyMap["\r"] = enterAction;
    keyMap["\x1b[13u"] = enterAction; // kitty Enter
    // Ctrl+J: always newline regardless of preferNewlineOnEnter
    if (!state.disabledKeys.has("ctrl+j")) {
        keyMap["\n"] = () => insertNewline(state);
        keyMap["\x1b[106;5u"] = () => insertNewline(state); // kitty Ctrl+J
    }
    // Modified Enter keys
    const modifiedEnterKeys = {
        "shift+enter": ["\x1b[13;2u"],
        "ctrl+enter": ["\x1b[13;5u"],
        "cmd+enter": ["\x1b[13;9u"],
        "alt+enter": ["\x1b\r", "\x1b[13;3u"],
    };
    for (const [name, seqs] of Object.entries(modifiedEnterKeys)) {
        if (!state.disabledKeys.has(name)) {
            for (const seq of seqs) {
                keyMap[seq] = modifiedAction;
            }
        }
    }
    // Cancel / EOF
    keyMap["\x03"] = cancel; // Ctrl+C
    keyMap["\x1b[99;5u"] = cancel; // kitty Ctrl+C
    keyMap["\x04"] = handleEOF; // Ctrl+D
    keyMap["\x1b[100;5u"] = handleEOF; // kitty Ctrl+D
    // Editing
    keyMap["\x7f"] = () => handleBackspace(state);
    keyMap["\b"] = () => handleBackspace(state);
    keyMap["\x17"] = () => deleteWordBack(state); // Ctrl+W
    keyMap["\x1b[119;5u"] = () => deleteWordBack(state); // kitty Ctrl+W
    keyMap["\x1b[3~"] = () => handleDelete(state); // Delete key
    keyMap["\x15"] = () => deleteToLineStart(state); // Ctrl+U
    keyMap["\x1b[117;5u"] = () => deleteToLineStart(state); // kitty Ctrl+U
    keyMap["\x0b"] = () => deleteToLineEnd(state); // Ctrl+K
    keyMap["\x1b[107;5u"] = () => deleteToLineEnd(state); // kitty Ctrl+K
    // Undo / Redo
    keyMap["\x1a"] = () => undo(state); // Ctrl+Z
    keyMap["\x1b[122;5u"] = () => undo(state); // kitty Ctrl+Z
    keyMap["\x1b[122;9u"] = () => undo(state); // kitty Cmd+Z
    keyMap["\x1b[122;6u"] = () => redo(state); // kitty Ctrl+Shift+Z
    keyMap["\x1b[122;10u"] = () => redo(state); // kitty Cmd+Shift+Z
    keyMap["\x19"] = () => redo(state); // Ctrl+Y
    keyMap["\x1b[121;5u"] = () => redo(state); // kitty Ctrl+Y
    keyMap["\x1b[121;9u"] = () => redo(state); // kitty Cmd+Y
    // Clear screen
    keyMap["\x0c"] = () => clearScreen(state); // Ctrl+L
    keyMap["\x1b[108;5u"] = () => clearScreen(state); // kitty Ctrl+L
    // Arrow keys (with history support)
    keyMap["\x1b[A"] = () => moveUpOrHistory(state);
    keyMap["\x1b[B"] = () => moveDownOrHistory(state);
    keyMap["\x1b[C"] = () => moveRight(state);
    keyMap["\x1b[D"] = () => moveLeft(state);
    // Alt+Arrow
    keyMap["\x1b[1;3C"] = () => wordRight(state);
    keyMap["\x1b[1;3D"] = () => wordLeft(state);
    keyMap["\x1b[1;3A"] = () => historyPrev(state);
    keyMap["\x1b[1;3B"] = () => historyNext(state);
    // Ctrl+Arrow (line/buffer navigation)
    keyMap["\x1b[1;5C"] = () => lineEnd(state);
    keyMap["\x1b[1;5D"] = () => lineStart(state);
    keyMap["\x1b[1;5A"] = () => bufferStart(state);
    keyMap["\x1b[1;5B"] = () => bufferEnd(state);
    // Ctrl+P/N (history navigation)
    keyMap["\x10"] = () => historyPrev(state); // Ctrl+P
    keyMap["\x1b[112;5u"] = () => historyPrev(state); // kitty Ctrl+P
    keyMap["\x0e"] = () => historyNext(state); // Ctrl+N
    keyMap["\x1b[110;5u"] = () => historyNext(state); // kitty Ctrl+N
    // PageUp/PageDown (history navigation)
    keyMap["\x1b[5~"] = () => historyPrev(state); // PageUp
    keyMap["\x1b[6~"] = () => historyNext(state); // PageDown
    // macOS Option+Arrow
    keyMap["\x1bb"] = () => wordLeft(state); // ESC+b
    keyMap["\x1bf"] = () => wordRight(state); // ESC+f
    // Cmd+Arrow (kitty protocol: super modifier = 9)
    keyMap["\x1b[1;9D"] = () => lineStart(state);
    keyMap["\x1b[1;9C"] = () => lineEnd(state);
    keyMap["\x1b[1;9A"] = () => bufferStart(state);
    keyMap["\x1b[1;9B"] = () => bufferEnd(state);
    // Cmd+Arrow (macOS: sent as Ctrl+A/E)
    keyMap["\x01"] = () => lineStart(state); // Ctrl+A
    keyMap["\x1b[97;5u"] = () => lineStart(state); // kitty Ctrl+A
    keyMap["\x05"] = () => lineEnd(state); // Ctrl+E
    keyMap["\x1b[101;5u"] = () => lineEnd(state); // kitty Ctrl+E
    // Home/End
    keyMap["\x1b[H"] = () => lineStart(state);
    keyMap["\x1b[F"] = () => lineEnd(state);
    // Suggestion cycling (Tab / Shift+Tab). No-op unless a suggestion list is active.
    // Bound in both legacy and kitty-protocol (CSI u) encodings: with the kitty
    // keyboard protocol enabled, iTerm2/kitty/WezTerm etc. report Tab as `CSI 9 u`
    // and Shift+Tab as `CSI 9;2 u` instead of `\t` / `CSI Z`.
    if (state.suggest) {
        keyMap["\t"] = () => cycleSuggestion(state, 1); // legacy Tab
        keyMap["\x1b[9u"] = () => cycleSuggestion(state, 1); // kitty Tab
        keyMap["\x1b[9;1u"] = () => cycleSuggestion(state, 1); // kitty Tab (explicit no modifier)
        keyMap["\x1b[Z"] = () => cycleSuggestion(state, -1); // legacy Shift+Tab
        keyMap["\x1b[9;2u"] = () => cycleSuggestion(state, -1); // kitty Shift+Tab
        keyMap["\x1b[1;2Z"] = () => cycleSuggestion(state, -1); // xterm Shift+Tab
    }
}
// --- Paste handling ---
function processPaste(state, text) {
    const normalized = text.replace(/\r\n|\r/g, "\n");
    for (const ch of normalized) {
        if (ch === "\n") {
            insertNewline(state);
        }
        else if (ch.charCodeAt(0) >= 32) {
            insertChar(state, ch);
        }
    }
}
/** Process an input sequence: handle paste markers, key map lookups, and character insertion */
export function processInput(state, seq) {
    // Paste start marker
    const startIdx = seq.indexOf(PASTE_START);
    if (startIdx !== -1) {
        if (startIdx > 0)
            processInput(state, seq.slice(0, startIdx));
        saveUndo(state);
        state.isPasting = true;
        if (state.historyArrowAttempt > 0)
            state.historyArrowAttempt = 0;
        const after = seq.slice(startIdx + PASTE_START.length);
        if (after)
            processInput(state, after);
        return;
    }
    // Paste end marker
    const endIdx = seq.indexOf(PASTE_END);
    if (endIdx !== -1) {
        if (endIdx > 0)
            processPaste(state, seq.slice(0, endIdx));
        state.isPasting = false;
        // Re-render once after paste to apply highlight/styledInput
        clearScreen(state);
        const after = seq.slice(endIdx + PASTE_END.length);
        if (after)
            processInput(state, after);
        return;
    }
    // During paste, insert everything as text
    if (state.isPasting) {
        processPaste(state, seq);
        return;
    }
    // Normal key processing
    const handler = state.keyMap[seq];
    if (handler) {
        const prevAttempt = state.historyArrowAttempt;
        handler();
        // Reset double-press counter if the handler didn't touch it
        if (state.historyArrowAttempt === prevAttempt && prevAttempt > 0) {
            state.historyArrowAttempt = 0;
        }
        return;
    }
    // Ignore unknown escape sequences
    if (seq.startsWith("\x1b")) {
        if (state.historyArrowAttempt > 0)
            state.historyArrowAttempt = 0;
        return;
    }
    // Regular characters
    if (state.historyArrowAttempt > 0)
        state.historyArrowAttempt = 0;
    for (const ch of seq) {
        if (ch.charCodeAt(0) >= 32)
            insertChar(state, ch);
    }
}
function flushEscBuffer(state) {
    state.escTimer = null;
    const buf = state.escBuffer;
    state.escBuffer = "";
    const handler = state.keyMap[buf];
    if (handler) {
        const prevAttempt = state.historyArrowAttempt;
        handler();
        if (state.historyArrowAttempt === prevAttempt && prevAttempt > 0) {
            state.historyArrowAttempt = 0;
        }
    }
    else if (state.historyArrowAttempt > 0) {
        state.historyArrowAttempt = 0;
    }
}
/** Handle raw data from the input stream, buffering ESC sequences as needed */
export function onData(state, data) {
    const seq = data.toString();
    if (state.escBuffer) {
        if (state.escTimer) {
            clearTimeout(state.escTimer);
            state.escTimer = null;
        }
        const combined = state.escBuffer + seq;
        state.escBuffer = "";
        processInput(state, combined);
        return;
    }
    if (seq === "\x1b") {
        state.escBuffer = seq;
        state.escTimer = setTimeout(() => flushEscBuffer(state), ESC_TIMEOUT);
        return;
    }
    processInput(state, seq);
}
