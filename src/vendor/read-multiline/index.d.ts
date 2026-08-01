import * as presets from "./presets/index.js";
import type { ReadMultilineOptions, ReadMultilineResult, SharedConfig } from "./types.js";
export type { CancelError, EOFError, HelpFooterAction, HelpFooterDisplayOptions, HistoryOptions, ModifiedEnterKey, PromptTheme, ReadMultilineError, ReadMultilineOptions, ReadMultilineResult, SharedConfig, Stateful, StyleTextFormat, TransformEvent, TransformState, TTYInput, } from "./types.js";
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
export declare function createPrompt(shared: SharedConfig): (prompt: string, options?: ReadMultilineOptions) => Promise<ReadMultilineResult>;
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
export declare function readMultiline(prompt: string, options?: ReadMultilineOptions): Promise<ReadMultilineResult>;
