/** Returns the terminal display width of a character (full-width=2, half-width=1) */
export declare function charWidth(code: number): number;
/** Returns the terminal display width of a string (ANSI escape codes are ignored) */
export declare function stringWidth(str: string): number;
/** Returns the character at the given code unit index (surrogate pair aware) */
export declare function charAtIndex(str: string, index: number): string;
/** Returns the character just before the given code unit index (surrogate pair aware) */
export declare function charBeforeIndex(str: string, index: number): string;
/** Convert a visual column offset to the corresponding code-unit index in a string */
export declare function colFromVisual(str: string, visualCol: number): number;
/** Get the visual (display) width of a string up to a code-unit index */
export declare function visualCol(str: string, col: number): number;
export declare function isWordChar(ch: string): boolean;
/** Count total characters across all lines (join with newlines) */
export declare function contentLength(lines: string[]): number;
