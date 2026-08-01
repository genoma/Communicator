import type { HelpFooterAction, ModifiedEnterKey, StyleTextFormat, TTYInput } from "./types.js";
interface HelpFooterOptions {
    /** Whether Enter inserts a newline instead of submitting (default: false) */
    preferNewlineOnEnter?: boolean;
    /** Key combinations that are disabled */
    disabledKeys?: ModifiedEnterKey[];
    /** Actions to display and their order (default: ["submit", "newline", "undo", "cancel", "eof"]) */
    items?: HelpFooterAction[];
    /** Maximum number of key alternatives shown per action (default: 2) */
    maxKeysPerAction?: number;
    /** Maximum number of lines to display (default: unlimited) */
    maxLines?: number;
    /** Overall text style (default: "dim", or none when separator is set) */
    style?: StyleTextFormat;
    /** Style for key labels like "Enter", "Ctrl+Z" (default: none) */
    keyStyle?: StyleTextFormat;
    /** Style for action descriptions like "submit", "newline" (default: none) */
    actionStyle?: StyleTextFormat;
    /** Separator between items (e.g. " • "). When set, items are displayed inline instead of grid layout */
    separator?: string;
    /** Terminal width for grid layout (default: process.stdout.columns ?? 80) */
    columns?: number;
}
/** @internal Reset detection cache for testing */
export declare function _resetKittyDetection(value?: boolean): void;
/**
 * Detect kitty keyboard protocol support.
 * Must be called after raw mode is enabled on the input stream.
 * Results are cached; subsequent calls return the cached promise.
 */
export declare function detectKittyProtocol(input: TTYInput, output: NodeJS.WritableStream): Promise<boolean>;
/**
 * Build a help footer string with key binding descriptions.
 * Automatically adjusts grid layout based on terminal width.
 * Uses cached kitty protocol detection results to filter unavailable keys.
 */
export declare function buildHelpFooter(options?: HelpFooterOptions): string;
export {};
