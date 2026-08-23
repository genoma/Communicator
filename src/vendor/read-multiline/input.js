import { cycleSuggestion, deleteToLineEnd, deleteToLineStart, deleteWordBack, dismissSuggestions, handleBackspace, handleDelete, insertChar, insertNewline, insertPaste, redo, saveUndo, suggestMove, undo, } from "./editing.js";
import { bufferEnd, bufferStart, historyNext, historyPrev, lineEnd, lineStart, moveDownOrHistory, moveLeft, moveRight, moveUpOrHistory, wordLeft, wordRight, } from "./navigation.js";
import { clearScreen } from "./rendering.js";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESC_TIMEOUT = 50; // ms — lone Escape / escape sequence split across reads
const PASTE_TAIL_TIMEOUT = 1500; // ms — recovery if a paste-end marker never completes
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
    // Arrow keys (history navigation, or suggestion navigation when a list is active)
    keyMap["\x1b[A"] = () => { if (!suggestMove(state, -1)) moveUpOrHistory(state); };
    keyMap["\x1b[B"] = () => { if (!suggestMove(state, 1)) moveDownOrHistory(state); };
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
        // Escape: dismiss the suggestion list, restoring the typed prefix
        keyMap["\x1b"] = () => dismissSuggestions(state); // legacy Escape
        keyMap["\x1b[27u"] = () => dismissSuggestions(state); // kitty Escape
        keyMap["\x1b[27;1u"] = () => dismissSuggestions(state); // kitty Escape (explicit no modifier)
    }
}
// --- Paste handling ---
function processPaste(state, text) {
    // Bulk insert: per-character insertChar was O(n²) on large pastes. Control
    // chars other than newline are dropped, mirroring the per-char loop.
    insertPaste(state, text.replace(/\r\n|\r/g, "\n").replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, ""));
}
/**
 * The longest suffix of seq that could still be a prefix of a paste marker.
 * Returns "" when seq does not end inside a marker.
 */
function markerTail(seq, marker) {
    const limit = Math.min(seq.length, marker.length - 1);
    for (let i = limit; i > 0; i--) {
        if (marker.startsWith(seq.slice(seq.length - i)))
            return seq.slice(seq.length - i);
    }
    return "";
}
/**
 * Consume non-paste input: bracketed-paste start markers, escape sequences and
 * plain text. Returns the trailing incomplete escape/prefix ("" if none) that
 * the caller must hold back until more data arrives.
 */
function consumeKeys(state, seq) {
    let i = 0;
    while (i < seq.length) {
        const escIdx = seq.indexOf("\x1b", i);
        if (escIdx === -1) {
            insertRun(state, seq.slice(i));
            return "";
        }
        if (escIdx > i)
            insertRun(state, seq.slice(i, escIdx));
        const len = escapeLength(seq, escIdx);
        if (len === 0)
            return seq.slice(escIdx);
        const key = seq.slice(escIdx, escIdx + len);
        const handler = state.keyMap[key];
        if (handler) {
            const prevAttempt = state.historyArrowAttempt;
            handler();
            // Reset double-press counter if the handler didn't touch it
            if (state.historyArrowAttempt === prevAttempt && prevAttempt > 0) {
                state.historyArrowAttempt = 0;
            }
        }
        else if (state.historyArrowAttempt > 0) {
            state.historyArrowAttempt = 0;
        }
        i = escIdx + len;
    }
    return "";
}
/** Insert the printable characters of a run, dispatching control keys to the keymap */
function insertRun(state, run) {
    if (state.historyArrowAttempt > 0)
        state.historyArrowAttempt = 0;
    for (const ch of run) {
        const handler = state.keyMap[ch];
        if (handler && (ch.charCodeAt(0) < 32 || ch === "\x7f")) {
            handler();
        }
        else if (ch.charCodeAt(0) >= 32) {
            insertChar(state, ch);
        }
    }
}
/**
 * Length of the escape sequence starting at seq[start], or 0 when the sequence
 * is incomplete and more bytes are expected. A control byte inside a CSI makes
 * the escape malformed: the sequence ends there so the byte is reprocessed.
 */
function escapeLength(seq, start) {
    const s = seq.slice(start);
    if (s.length < 2)
        return 0;
    if (s[1] === "[") {
        for (let k = 2; k < s.length; k++) {
            const b = s.charCodeAt(k);
            if (b >= 0x40 && b <= 0x7e)
                return k + 1; // final byte
            if (b >= 0x20 && b <= 0x3f)
                continue; // parameter / intermediate byte
            return k; // malformed: drop the escape, reprocess the byte
        }
        return 0; // CSI started, no final byte yet
    }
    return 2; // ESC + one byte (\x1bb, \x1bf, \x1b\r, ...)
}
/** Consume paste payload: everything between the start and end markers is literal text */
function consumePaste(state, seq) {
    const endIdx = seq.indexOf(PASTE_END);
    if (endIdx !== -1) {
        if (endIdx > 0)
            processPaste(state, seq.slice(0, endIdx));
        state.isPasting = false;
        // Re-render once after paste to apply highlight/styledInput
        clearScreen(state);
        return consume(state, seq.slice(endIdx + PASTE_END.length));
    }
    // A trailing prefix of the end marker may complete in the next chunk;
    // hold it back instead of corrupting the paste payload.
    const tail = markerTail(seq, PASTE_END);
    if (tail) {
        if (seq.length > tail.length)
            processPaste(state, seq.slice(0, seq.length - tail.length));
        return tail;
    }
    processPaste(state, seq);
    return "";
}
/**
 * Process an input sequence: handle paste markers, key map lookups, and
 * character insertion. Returns the trailing incomplete escape sequence to hold
 * until more data arrives ("" when nothing is pending).
 */
function consume(state, seq) {
    if (state.isPasting)
        return consumePaste(state, seq);
    const startIdx = seq.indexOf(PASTE_START);
    if (startIdx !== -1) {
        const leadTail = startIdx > 0 ? consumeKeys(state, seq.slice(0, startIdx)) : "";
        if (leadTail)
            return leadTail + seq.slice(startIdx);
        saveUndo(state);
        state.isPasting = true;
        if (state.historyArrowAttempt > 0)
            state.historyArrowAttempt = 0;
        return consume(state, seq.slice(startIdx + PASTE_START.length));
    }
    return consumeKeys(state, seq);
}
function runHandler(state, buf) {
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
function flushBuffer(state) {
    state.escTimer = null;
    if (state.isPasting) {
        // No paste data for a while: the end marker never arrived (lost bytes).
        // End the paste so typed keys work again instead of being swallowed.
        state.escBuffer = "";
        state.isPasting = false;
        clearScreen(state);
        return;
    }
    const buf = state.escBuffer;
    state.escBuffer = "";
    runHandler(state, buf);
}
/** Hold an incomplete escape sequence back, flushing after a timeout */
function holdTail(state, tail) {
    state.escBuffer = tail;
    if (state.escTimer)
        return;
    state.escTimer = setTimeout(() => flushBuffer(state), state.isPasting ? PASTE_TAIL_TIMEOUT : ESC_TIMEOUT);
}
/** Handle raw data from the input stream, reassembling sequences split across chunks */
export function onData(state, data) {
    const seq = data.toString();
    if (state.escTimer) {
        clearTimeout(state.escTimer);
        state.escTimer = null;
    }
    if (state.escBuffer) {
        const combined = state.escBuffer + seq;
        state.escBuffer = "";
        const tail = consume(state, combined);
        if (tail) {
            holdTail(state, tail);
            return;
        }
        if (state.isPasting)
            holdTail(state, ""); // arm the paste watchdog (no tail to merge)
        return;
    }
    const tail = consume(state, seq);
    if (tail) {
        holdTail(state, tail);
        return;
    }
    if (state.isPasting)
        holdTail(state, "");
}
