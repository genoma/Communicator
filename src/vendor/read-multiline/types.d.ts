import type { styleText } from "node:util";
export type StyleTextFormat = Parameters<typeof styleText>[0];
/** A value that can vary between pending (editing), submitted, cancelled, and error states */
export type Stateful<T> = T | {
    pending: T;
    submitted: T;
    cancelled?: T;
    error?: T;
};
/** Theme configuration for styling prompt elements */
export interface PromptTheme {
    /** Style for the prefix text */
    prefix?: Stateful<StyleTextFormat>;
    /** Style for the line prefix text */
    linePrefix?: Stateful<StyleTextFormat>;
    /** Style for the prompt message text */
    prompt?: StyleTextFormat;
    /** Style for user input text while editing */
    input?: StyleTextFormat;
    /** Style for the answer text after submission */
    answer?: StyleTextFormat;
    /** Style for the answer text after cancellation (e.g. ["strikethrough", "dim"] for clack) */
    cancelAnswer?: StyleTextFormat;
    /**
     * How to render the prompt after submission.
     * - "clear": erase the prompt and input from the terminal (default)
     * - "content": re-render prompt header + prefix, input lines without linePrefix
     * - "preserve": re-render with submitted-state prefix/linePrefix and styles
     * - "ellipsis": show only the first line, append "…" if multi-line
     * - number (e.g. 3): show up to N lines, append "…" if truncated
     */
    submitRender?: "clear" | "content" | "preserve" | "ellipsis" | number;
    /**
     * How to render the prompt after cancellation (Ctrl+C) or EOF (Ctrl+D on empty input).
     * - "clear": erase the prompt and input from the terminal (default)
     * - "content": re-render prompt header + prefix, input lines without linePrefix
     * - "preserve": re-render with cancelled-state prefix/linePrefix and styles
     * - "ellipsis": show only the first line, append "…" if multi-line
     * - number (e.g. 3): show up to N lines, append "…" if truncated
     */
    cancelRender?: "clear" | "content" | "preserve" | "ellipsis" | number;
    /** Style for validation error messages */
    error?: StyleTextFormat;
    /** Style for validation success messages */
    success?: StyleTextFormat;
    /** Style for footer text */
    footer?: StyleTextFormat;
}
/** Error returned when the user cancels input with Ctrl+C. */
export interface CancelError {
    kind: "cancel";
    message: "Input cancelled";
}
/** Error returned when Ctrl+D is pressed on empty input. */
export interface EOFError {
    kind: "eof";
    message: "EOF received on empty input";
}
/** Union of errors that readMultiline can return. */
export type ReadMultilineError = CancelError | EOFError;
/**
 * Result tuple:
 * - `[string, null]` on success
 * - `[string, ReadMultilineError]` on cancel/EOF (includes partial input)
 */
export type ReadMultilineResult = [string, null] | [string, ReadMultilineError];
export interface ReadMultilineOptions {
    /** Prefix displayed before the prompt message (default: "> "). Can be state-dependent. */
    prefix?: Stateful<string>;
    /** Prefix displayed on each input line (default: prefix value). Can be state-dependent. */
    linePrefix?: Stateful<string>;
    /** Theme for styling prompt elements */
    theme?: PromptTheme;
    /** Input stream (default: process.stdin) */
    input?: TTYInput;
    /** Output stream (default: process.stdout) */
    output?: NodeJS.WritableStream;
    /** Initial value to pre-populate the input */
    initialValue?: string;
    /**
     * History entries (oldest first) or history options with file persistence.
     * - `string[]`: in-memory history entries
     * - `HistoryOptions`: file-based persistent history
     */
    history?: string[] | HistoryOptions;
    /**
     * How Up/Down arrow keys interact with history at boundaries (default: "single").
     * - "single": at boundary, one press triggers history navigation
     * - "double": at boundary, two consecutive presses trigger history navigation
     * - "disabled": Up/Down never triggers history (use dedicated keys instead)
     */
    historyArrowNavigation?: "single" | "double" | "disabled";
    /** Maximum number of lines allowed */
    maxLines?: number;
    /** Maximum total character count allowed */
    maxLength?: number;
    /** Validation function. Return an error message string to reject, or undefined/null to accept. */
    validate?: (value: string) => string | undefined | null;
    /** Debounce interval (ms) for live validation after first submit failure (default: 300) */
    validateDebounceMs?: number;
    /**
     * Whether Enter inserts a newline instead of submitting (default: false).
     * - false: Enter=submit, modified Enter (Shift/Ctrl/Cmd/Alt+Enter)=newline
     * - true: Enter=newline, modified Enter=submit
     *
     * Ctrl+J (0x0A) always inserts a newline regardless of this setting.
     * Shift+Enter, Ctrl+Enter, Cmd+Enter require the kitty keyboard protocol.
     * Alt+Enter may be intercepted by Windows Console Host / Windows Terminal
     * for fullscreen toggle; pass `disabledKeys: ["alt+enter"]` to opt out
     * when running under such a terminal.
     * When kitty protocol is not supported, this option falls back to false
     * to ensure Enter=submit and Ctrl+J=newline are always available.
     */
    preferNewlineOnEnter?: boolean;
    /**
     * Key combinations to disable.
     * Disabled keys are ignored (neither submit nor newline).
     */
    disabledKeys?: ModifiedEnterKey[];
    /**
     * Syntax highlighting function. Receives line text and 0-indexed line number,
     * returns a string with ANSI escape sequences for display.
     * Cursor position is always calculated from the plain text, not the highlighted output.
     * When set, takes precedence over `theme.input` styling for line rendering.
     */
    highlight?: (line: string, lineIndex: number) => string;
    /**
     * Called after each edit operation. Receives the current editor content,
     * cursor position, and what edit just occurred. Return a new state to
     * transform the content, or undefined to leave it unchanged.
     * Skipped during paste.
     */
    transform?: (state: TransformState, event: TransformEvent) => TransformState | undefined;
    /** Fixed footer text displayed below the editor. Appears below the status line. */
    footer?: string;
    /**
     * Suggestion provider (vendored patch). Called after content changes and on
     * Tab/Shift+Tab when the input is a single line starting with "/" with the
     * cursor at line end. Return matching suggestion strings; the list is
     * rendered into the footer slot and Tab/Shift+Tab cycle through it.
     */
    suggest?: (params: { value: string; cursor: number }) => string[];
    /**
     * Whether to clear the input from the terminal after submission (default: true).
     * - true: input is erased from the terminal after submit
     * - false: input remains visible in the terminal after submit
     * @deprecated Use `theme.submitRender` instead ("clear" or "preserve")
     */
    clearAfterSubmit?: boolean;
    /**
     * Auto-generated help footer showing key bindings.
     * Displayed below the custom footer (if any), after kitty protocol detection completes.
     * - true: show with default options
     * - object: customize display (maxKeysPerAction, maxLines, style, keyStyle)
     *
     * Terminal width (columns) is auto-calculated from the output stream.
     * preferNewlineOnEnter and disabledKeys are inherited from the parent options.
     */
    helpFooter?: boolean | HelpFooterDisplayOptions;
    /**
     * When true, render the prompt and input on the same line (inline mode).
     * - The prompt prefix and message appear before the input on the first line.
     * - Subsequent lines still use the linePrefix.
     * - Inline mode concatenates `prefix + prompt + input` with no implicit
     *   separator — include any trailing space in the prompt text yourself.
     * - The prompt header must render on a single terminal line; passing a prompt
     *   (or a `Stateful` prefix variant) that contains a newline throws at call time.
     * - Useful for single-line or short inputs where you want the prompt and
     *   input to be visually connected.
     *
     * @example
     * // Default (prompt on own line):
     * // > Enter your message:
     * //   [input here]
     * //
     * // With inlinePrompt: true and a prompt ending in a space:
     * //   readMultiline("Enter your message: ", { inlinePrompt: true })
     * // > Enter your message: [input here]
     */
    inlinePrompt?: boolean;
}
/** Built-in action names available for the help footer items configuration. */
export type HelpFooterAction = "submit" | "newline" | "undo" | "redo" | "cancel" | "eof" | "history" | "word-jump" | "line-start" | "line-end" | "delete-word" | "delete-to-start" | "delete-to-end" | "clear-screen";
/** Display options for the auto-generated help footer showing key bindings. */
export interface HelpFooterDisplayOptions {
    /** Actions to display and their order (default: ["submit", "newline", "undo", "cancel", "eof"]) */
    items?: HelpFooterAction[];
    /** Maximum number of key alternatives shown per action (default: 2) */
    maxKeysPerAction?: number;
    /** Maximum number of lines to display (default: unlimited) */
    maxLines?: number;
    /** Overall text style applied via `node:util` styleText (default: "dim", or none when separator is set) */
    style?: StyleTextFormat;
    /** Style for key labels like "Enter", "Ctrl+Z" (default: none) */
    keyStyle?: StyleTextFormat;
    /** Style for action descriptions like "submit", "newline" (default: none) */
    actionStyle?: StyleTextFormat;
    /** Separator between items (e.g. " • "). When set, items are displayed inline instead of grid layout */
    separator?: string;
}
/** Minimal editor state passed to and returned from the transform callback. */
export interface TransformState {
    lines: string[];
    row: number;
    col: number;
}
/** Event describing what edit operation just occurred, passed to the transform callback. */
export type TransformEvent = {
    type: "insert";
    char: string;
} | {
    type: "newline";
} | {
    type: "backspace";
} | {
    type: "delete";
};
/** Key combinations that can be used as modified Enter keys. These can be disabled via the disabledKeys option. */
export type ModifiedEnterKey = "shift+enter" | "ctrl+enter" | "cmd+enter" | "alt+enter" | "ctrl+j";
/** Options for file-based persistent history */
export interface HistoryOptions {
    /** File path for persistent storage (JSON format) */
    filePath: string;
    /** Maximum number of entries to keep (default: 100) */
    maxEntries?: number;
    /**
     * Predicate that decides whether a submitted value should be appended to
     * persistent history. Return `false` to skip; `true` or `undefined` persist
     * the value.
     *
     * When the callback is omitted, empty submissions (`""`) are skipped by
     * default and all other values are persisted. Pass a custom predicate to
     * override that default, for example to also skip whitespace-only
     * submissions or REPL meta commands.
     */
    shouldPersist?: (value: string) => boolean;
}
/** A readable stream with optional TTY capabilities for character-by-character raw mode input. */
export interface TTYInput extends NodeJS.ReadableStream {
    isTTY?: boolean;
    setRawMode?(mode: boolean): void;
}
export interface Snapshot {
    lines: string[];
    row: number;
    col: number;
}
/** Shared configuration that can be reused across multiple readMultiline calls via createPrompt */
export type SharedConfig = ReadMultilineOptions;
export interface EditorState {
    lines: string[];
    row: number;
    col: number;
    output: NodeJS.WritableStream;
    promptHeader: string;
    promptHeaderHeight: number;
    styledLinePrefix: string;
    linePrefixWidth: number;
    visualState: "pending" | "error";
    theme: PromptTheme | undefined;
    prefixOption: Stateful<string>;
    linePrefixOption: Stateful<string>;
    rawPrompt: string;
    statusText: string;
    statusColor: "red" | "green" | "";
    footerText: string;
    baseFooterText: string;
    rebuildFooter: ((columns: number) => string) | null;
    history: string[];
    historyIndex: number;
    draft: string;
    historyArrowNavigation: "single" | "double" | "disabled";
    historyArrowAttempt: number;
    undoStack: Snapshot[];
    redoStack: Snapshot[];
    lastEditType: "insert" | "other" | "";
    validationActive: boolean;
    validateTimer: ReturnType<typeof setTimeout> | null;
    isPasting: boolean;
    escBuffer: string;
    escTimer: ReturnType<typeof setTimeout> | null;
    maxLines: number | undefined;
    maxLength: number | undefined;
    validate: ((value: string) => string | undefined | null) | undefined;
    validateDebounceMs: number;
    preferNewlineOnEnter: boolean;
    disabledKeys: Set<ModifiedEnterKey>;
    inlinePrompt: boolean;
    highlight: ((line: string, lineIndex: number) => string) | undefined;
    transform: ((state: TransformState, event: TransformEvent) => TransformState | undefined) | undefined;
    suggest: ((params: { value: string; cursor: number }) => string[]) | undefined;
    keyMap: Record<string, () => void>;
    buffering: boolean;
    writeBuffer: string;
}
