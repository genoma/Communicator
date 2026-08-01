import type { PromptTheme, Stateful, StyleTextFormat } from "./types.js";
/** Valid visual states for resolving Stateful values */
export type VisualState = "pending" | "submitted" | "cancelled" | "error";
/** Resolve a Stateful value to its concrete value for the given state */
export declare function resolveStateful<T>(value: Stateful<T>, state: VisualState): T;
/** Apply a styleText format to text. Returns the text unchanged if no format is provided. */
export declare function applyStyle(text: string, format?: StyleTextFormat): string;
/** Build the styled prompt header line (prefix + prompt) for a given state */
export declare function buildPromptHeader(prefixOption: Stateful<string>, prompt: string, theme: PromptTheme | undefined, state: VisualState): string;
/**
 * Compute the number of terminal lines the prompt header occupies.
 * Returns 0 when both prefix and prompt are empty (no header line is rendered).
 */
export declare function computeHeaderHeight(builtHeader: string): number;
/** Build the styled line prefix for a given state */
export declare function buildStyledLinePrefix(linePrefixOption: Stateful<string>, theme: PromptTheme | undefined, state: VisualState): string;
