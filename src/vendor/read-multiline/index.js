import { stringWidth } from "./chars.js";
import { handleDelete } from "./editing.js";
import { buildHelpFooter, detectKittyProtocol } from "./footer.js";
import { appendPersistedHistory, loadHistory } from "./history.js";
import { buildKeyMap, onData } from "./input.js";
import * as presets from "./presets/index.js";
import { clearBelowEditor, clearScreen, cursorVisualRow, refreshSuggestions, renderLine, setFooter, setStatusWithVisualState, tCol, w, } from "./rendering.js";
import { applyStyle, buildPromptHeader, buildStyledLinePrefix, computeHeaderHeight, resolveStateful, } from "./style.js";
export { presets };
/**
 * Create a reusable prompt function with shared configuration.
 * Per-call options are shallow-merged over the shared config.
 *
 * @example
 * ```typescript
 * const ask = createPrompt({ prefix: "? ", theme: { prompt: "bold" } });
 * const [name] = await ask("Name:");
 * const [email] = await ask("Email:");
 * ```
 */
export function createPrompt(shared) {
    return (prompt, options = {}) => {
        return readMultiline(prompt, { ...shared, ...options });
    };
}
/**
 * Read multi-line input from the terminal.
 *
 * Key bindings (default, preferNewlineOnEnter=false):
 * - Enter: Submit input
 * - Shift+Enter / Ctrl+Enter / Cmd+Enter / Alt+Enter: Insert newline
 *   (Alt+Enter may be intercepted by Windows Console Host / Windows Terminal
 *   for fullscreen toggle; use `disabledKeys: ["alt+enter"]` to opt out
 *   when running under such a terminal)
 * - Ctrl+J: Always insert newline (regardless of preferNewlineOnEnter)
 * - Backspace: Delete character (can merge lines)
 * - Delete: Forward delete character (can merge lines)
 * - Ctrl+U: Delete to line start
 * - Ctrl+K: Delete to line end
 * - Left/Right: Cursor movement (crosses line boundaries)
 * - Up/Down: Move between lines (history at boundaries)
 * - Alt+Left/Right: Word jump
 * - Cmd+Left/Right (Home/End): Jump to line start/end
 * - Cmd+Up/Down: Jump to start/end of entire input
 * - Ctrl+C: Cancel (returns [input, { kind: "cancel" }])
 * - Ctrl+D: Delete character at cursor (same as Delete key), EOF if empty (returns [input, { kind: "eof" }])
 * - Ctrl+L: Clear screen and redraw
 * - Ctrl+Z: Undo
 * - Ctrl+Shift+Z / Ctrl+Y: Redo
 * - Ctrl+W: Delete previous word
 *
 * Shift+Enter and Cmd+Arrow detection uses the kitty keyboard protocol.
 * Supported terminals: kitty, iTerm2, WezTerm, Ghostty, foot, etc.
 *
 * For non-TTY input (pipes), reads all lines until EOF.
 */
export function readMultiline(prompt, options) {
    const { input = process.stdin, output = process.stdout } = options ?? {};
    if (!input.isTTY) {
        return readFromPipe(input);
    }
    return readFromTTY(input, output, prompt, options ?? {});
}
function readFromPipe(input) {
    return new Promise((resolve) => {
        let data = "";
        input.on("data", (chunk) => {
            data += typeof chunk === "string" ? chunk : chunk.toString();
        });
        input.on("end", () => {
            resolve([data.endsWith("\n") ? data.slice(0, -1) : data, null]);
        });
    });
}
function readFromTTY(input, output, prompt, options) {
    return new Promise((resolve) => {
        const rawPrompt = prompt;
        const { prefix: prefixOption = "> ", linePrefix: linePrefixOption, theme, initialValue, history: historyOption, historyArrowNavigation = "single", maxLines, maxLength, validate, validateDebounceMs = 300, preferNewlineOnEnter = false, clearAfterSubmit = true, disabledKeys = [], highlight, transform, footer, helpFooter = true, inlinePrompt = false, suggest, } = options;
        // Resolve linePrefix: defaults to prefix
        const resolvedLinePrefixOption = linePrefixOption ?? prefixOption;
        // Build pending-state prompt header and line prefix
        const promptHeader = buildPromptHeader(prefixOption, rawPrompt, theme, "pending");
        if (inlinePrompt) {
            // Validate every state the header may render in, not just "pending":
            // a Stateful prefix could embed a newline in submitted/cancelled/error
            // variants and later break renderStateChange / setVisualState layout.
            for (const visualState of ["pending", "submitted", "cancelled", "error"]) {
                const header = visualState === "pending"
                    ? promptHeader
                    : buildPromptHeader(prefixOption, rawPrompt, theme, visualState);
                if (/[\r\n]/.test(header)) {
                    throw new Error("inlinePrompt requires a single-line prompt header (no newline in prefix or prompt).");
                }
            }
        }
        // In inline mode, the header is on the same line as input, so header height is 0
        const promptHeaderHeight = inlinePrompt ? 0 : computeHeaderHeight(promptHeader);
        const styledLinePrefix = buildStyledLinePrefix(resolvedLinePrefixOption, theme, "pending");
        const rawLinePrefix = resolveStateful(resolvedLinePrefixOption, "pending");
        const linePrefixWidth = stringWidth(rawLinePrefix);
        const styledFooter = applyStyle(footer ?? "", theme?.footer);
        const historyConfig = historyOption && !Array.isArray(historyOption) ? historyOption : undefined;
        const historyEntries = Array.isArray(historyOption)
            ? historyOption
            : historyConfig?.filePath
                ? loadHistory(historyConfig.filePath, historyConfig.maxEntries ?? 100)
                : [];
        const state = {
            lines: [""],
            row: 0,
            col: 0,
            output,
            promptHeader,
            promptHeaderHeight,
            styledLinePrefix,
            linePrefixWidth,
            visualState: "pending",
            theme,
            prefixOption,
            linePrefixOption: resolvedLinePrefixOption,
            rawPrompt,
            statusText: "",
            statusColor: "",
            footerText: styledFooter,
            baseFooterText: styledFooter,
            rebuildFooter: null,
            history: [...historyEntries],
            historyIndex: historyEntries.length,
            draft: initialValue ?? "",
            historyArrowNavigation,
            historyArrowAttempt: 0,
            undoStack: [],
            redoStack: [],
            lastEditType: "",
            validationActive: false,
            validateTimer: null,
            isPasting: false,
            escBuffer: "",
            escTimer: null,
            maxLines,
            maxLength,
            validate,
            validateDebounceMs,
            preferNewlineOnEnter,
            disabledKeys: new Set(disabledKeys),
            highlight,
            transform,
            inlinePrompt,
            suggest,
            suggestSession: null,
            keyMap: {},
            buffering: false,
            writeBuffer: "",
        };
        // --- Resize handling ---
        let resizeHandler = null;
        const ttyOutput = output;
        if (typeof ttyOutput.on === "function" && "columns" in ttyOutput) {
            resizeHandler = () => {
                if (state.rebuildFooter) {
                    state.footerText = state.rebuildFooter(ttyOutput.columns);
                }
                clearScreen(state);
                if (state.suggest) {
                    refreshSuggestions(state);
                }
            };
            ttyOutput.on("resize", resizeHandler);
        }
        let active = true;
        function cleanup() {
            active = false;
            if (state.escTimer) {
                clearTimeout(state.escTimer);
                state.escTimer = null;
            }
            if (state.validateTimer) {
                clearTimeout(state.validateTimer);
                state.validateTimer = null;
            }
            if (resizeHandler && typeof ttyOutput.removeListener === "function") {
                ttyOutput.removeListener("resize", resizeHandler);
            }
            clearBelowEditor(state);
            w(state, "\x1b[?2004l"); // Disable bracketed paste mode
            w(state, "\x1b[<u"); // Disable kitty protocol
            input.setRawMode?.(false);
            input.removeListener("data", dataHandler);
            input.pause();
        }
        // Determine submitRender and cancelRender modes
        const submitRender = theme?.submitRender ?? (clearAfterSubmit ? "clear" : "preserve");
        const cancelRender = theme?.cancelRender ?? "clear";
        /** Erase all editor content (prompt header + input lines + status + footer) from the terminal */
        function clearEditorArea() {
            const upCount = cursorVisualRow(state, state.row, state.col);
            if (upCount > 0)
                w(state, `\x1b[${upCount}A`);
            w(state, "\r\x1b[J");
            state.statusText = "";
            state.statusColor = "";
            state.footerText = "";
            state.row = 0;
            state.col = 0;
        }
        function submit() {
            if (validate) {
                const error = validate(state.lines.join("\n"));
                if (error) {
                    state.validationActive = true;
                    setStatusWithVisualState(state, error, "red", "error");
                    return;
                }
            }
            const result = state.lines.join("\n");
            if (submitRender === "clear") {
                clearEditorArea();
            }
            else {
                renderStateChange(state, theme, "submitted", submitRender);
            }
            cleanup();
            if (submitRender !== "clear") {
                w(state, "\n");
            }
            if (historyConfig?.filePath) {
                const persist = historyConfig.shouldPersist
                    ? historyConfig.shouldPersist(result) !== false
                    : result !== "";
                if (persist) {
                    const maxEntries = historyConfig.maxEntries ?? 100;
                    appendPersistedHistory(historyConfig.filePath, result, maxEntries);
                }
            }
            resolve([result, null]);
        }
        function resolveWithError(error) {
            resolve([state.lines.join("\n"), error]);
        }
        function handleEOF() {
            const content = state.lines.join("\n");
            if (content.length === 0) {
                if (cancelRender === "clear") {
                    clearEditorArea();
                }
                else {
                    renderStateChange(state, theme, "cancelled", cancelRender);
                }
                cleanup();
                if (cancelRender !== "clear") {
                    w(state, "\n");
                }
                resolveWithError({
                    kind: "eof",
                    message: "EOF received on empty input",
                });
            }
            else {
                handleDelete(state);
            }
        }
        function cancel() {
            if (cancelRender === "clear") {
                clearEditorArea();
            }
            else {
                renderStateChange(state, theme, "cancelled", cancelRender);
            }
            cleanup();
            if (cancelRender !== "clear") {
                w(state, "\n");
            }
            resolveWithError({ kind: "cancel", message: "Input cancelled" });
        }
        // Build key map
        buildKeyMap(state, submit, cancel, handleEOF);
        // --- Initialization ---
        // Draw prompt header line (always in inline mode, conditionally otherwise)
        const showHeader = promptHeaderHeight > 0 || inlinePrompt;
        if (showHeader) {
            w(state, promptHeader);
            // In inline mode, input follows on the same line (no newline after prompt)
            if (!inlinePrompt) {
                w(state, "\n");
            }
        }
        // Draw first input line with linePrefix
        // In inline mode, row 0 has no prefix (the prompt header is inline with input)
        if (!inlinePrompt) {
            w(state, styledLinePrefix);
        }
        if (initialValue) {
            const initLines = initialValue.split("\n");
            state.lines.length = 0;
            state.lines.push(...initLines);
            w(state, renderLine(state, 0));
            for (let i = 1; i < initLines.length; i++) {
                w(state, "\n" + styledLinePrefix + renderLine(state, i));
            }
            state.row = initLines.length - 1;
            state.col = initLines[state.row].length;
        }
        if (footer) {
            const endRow = state.lines.length - 1;
            const dr = endRow - state.row;
            if (dr > 0)
                w(state, `\x1b[${dr}B`);
            const footerLines = styledFooter.split("\n");
            for (const line of footerLines) {
                w(state, "\r\n" + line + "\x1b[K");
            }
            const upCount = endRow + footerLines.length - state.row;
            if (upCount > 0)
                w(state, `\x1b[${upCount}A`);
            w(state, `\x1b[${tCol(state, state.row, state.col)}G`);
        }
        input.setRawMode?.(true);
        input.resume();
        w(state, "\x1b[>1u"); // Enable kitty keyboard protocol
        w(state, "\x1b[?2004h"); // Enable bracketed paste mode
        // helpFooter: auto-generated key bindings help, shown after kitty detection
        // Must run after raw mode is enabled so the terminal can respond to the query
        if (helpFooter) {
            const helpOpts = typeof helpFooter === "object" ? helpFooter : {};
            const buildFooterForColumns = (cols) => {
                const helpText = buildHelpFooter({
                    ...helpOpts,
                    preferNewlineOnEnter: state.preferNewlineOnEnter,
                    disabledKeys,
                    columns: cols,
                });
                if (!styledFooter)
                    return helpText;
                if (!helpText)
                    return styledFooter;
                return styledFooter + "\n" + helpText;
            };
            const ttyOut = output;
            detectKittyProtocol(input, output).then((kittySupported) => {
                if (!active)
                    return;
                // Fall back to preferNewlineOnEnter=false when kitty is not supported,
                // ensuring Enter=submit and Ctrl+J=newline are always available.
                // Without kitty, modified Enter keys (Shift/Ctrl/Cmd+Enter) don't work,
                // leaving only Alt+Enter for submit — which requires "Use Option as Meta key"
                // on macOS Terminal.app and may be intercepted by Windows Console Host /
                // Windows Terminal for fullscreen toggle.
                if (!kittySupported && state.preferNewlineOnEnter) {
                    state.preferNewlineOnEnter = false;
                    state.keyMap = {};
                    buildKeyMap(state, submit, cancel, handleEOF);
                }
                const columns = ("columns" in ttyOut && ttyOut.columns) || 80;
                state.rebuildFooter = buildFooterForColumns;
                setFooter(state, buildFooterForColumns(columns));
                if (state.suggest) {
                    refreshSuggestions(state);
                }
            });
        }
        function dataHandler(data) {
            onData(state, data);
        }
        input.on("data", dataHandler);
    });
}
/** Re-render the editor in submitted or cancelled state with updated prefix/linePrefix and styles */
function renderStateChange(state, theme, renderState, mode = "preserve") {
    // Move to top of editor (input lines + prompt header)
    // In inline mode, header is on same line as input, so use 0 for height
    const upCount = cursorVisualRow(state, state.row, state.col);
    if (upCount > 0)
        w(state, `\x1b[${upCount}A`);
    w(state, "\r\x1b[J");
    // Rebuild prompt header and line prefix for the target state
    const header = buildPromptHeader(state.prefixOption, state.rawPrompt, theme, renderState);
    // In inline mode, header is on same line as input
    const headerHeight = state.inlinePrompt ? 0 : computeHeaderHeight(header);
    const linePrefix = mode === "content" ? "" : buildStyledLinePrefix(state.linePrefixOption, theme, renderState);
    // Choose answer style based on state
    const answerStyle = renderState === "cancelled" ? (theme?.cancelAnswer ?? theme?.answer) : theme?.answer;
    // Determine how many lines to display
    const maxLines = mode === "ellipsis" ? 1 : typeof mode === "number" ? mode : state.lines.length;
    const displayCount = Math.min(maxLines, state.lines.length);
    const truncated = state.lines.length > displayCount;
    // Draw prompt header
    // In inline mode, always draw header (on same line as input)
    // In non-inline mode, only draw if headerHeight > 0
    if (headerHeight > 0 || state.inlinePrompt) {
        w(state, header);
        // In inline mode, input follows on the same line (no newline after header)
        if (!state.inlinePrompt) {
            w(state, "\n");
        }
    }
    // Draw input lines: answerStyle takes priority, then highlight, then plain
    for (let i = 0; i < displayCount; i++) {
        if (i > 0)
            w(state, "\n");
        // In inline mode, row 0 has no prefix (header is already inline)
        const prefix = state.inlinePrompt && i === 0 ? "" : linePrefix;
        const styledLine = answerStyle ? applyStyle(state.lines[i], answerStyle) : renderLine(state, i);
        w(state, prefix + styledLine);
    }
    // Append ellipsis indicator if truncated
    if (truncated) {
        w(state, applyStyle(" …", "dim"));
    }
    // Reset state for cleanup
    state.statusText = "";
    state.statusColor = "";
    state.footerText = "";
    state.row = displayCount - 1;
    state.col = state.lines[displayCount - 1].length;
}
