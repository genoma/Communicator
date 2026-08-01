/** Load history entries from a JSON file. Returns [] if file doesn't exist or is invalid. */
export declare function loadHistory(filePath: string, maxEntries?: number): string[];
/**
 * Atomically replace the history file with `entries`.
 * Writes to a unique sibling temp file then renames it over the target path so
 * readers never observe a partial JSON document. Errors are silently swallowed
 * to preserve the prior fire-and-forget semantics.
 */
export declare function saveHistory(filePath: string, entries: string[]): void;
/**
 * Append `entry` to the on-disk history file via read-modify-write.
 * Re-reads the file immediately before writing so entries appended by
 * concurrent sessions after this session started are preserved. The final
 * write uses atomic replacement via `saveHistory`.
 *
 * A small race window remains when two writers interleave load/write: the
 * last renamer wins. Callers that need strict ordering across processes
 * should layer a file lock on top.
 */
export declare function appendPersistedHistory(filePath: string, entry: string, maxEntries?: number): void;
/** Append an entry to the history array and apply maxEntries limit. Returns a new array. */
export declare function appendHistory(entries: string[], entry: string, maxEntries?: number): string[];
