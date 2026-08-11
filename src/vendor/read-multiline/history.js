import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
/** Expand leading ~ to the user's home directory */
function expandHome(filePath) {
    if (filePath === "~" || filePath.startsWith("~/") || filePath.startsWith("~\\")) {
        return filePath.replace("~", homedir());
    }
    return filePath;
}
/** Load history entries from a JSON file. Returns [] if file doesn't exist or is invalid. */
export function loadHistory(filePath, maxEntries) {
    try {
        const data = readFileSync(expandHome(filePath), "utf8");
        const parsed = JSON.parse(data);
        const entries = Array.isArray(parsed)
            ? parsed.filter((e) => typeof e === "string")
            : [];
        if (maxEntries != null && maxEntries > 0 && entries.length > maxEntries) {
            return entries.slice(-maxEntries);
        }
        return entries;
    }
    catch {
        return [];
    }
}
/**
 * Atomically replace the history file with `entries`.
 * Writes to a unique sibling temp file then renames it over the target path so
 * readers never observe a partial JSON document. Errors are silently swallowed
 * to preserve the prior fire-and-forget semantics.
 */
export function saveHistory(filePath, entries) {
    const resolved = expandHome(filePath);
    try {
        mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
    }
    catch {
        // ignore
    }
    const tmpPath = `${resolved}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        // Prompt history can contain sensitive content: same private mode as
        // the config and session files.
        writeFileSync(tmpPath, JSON.stringify(entries), { mode: 0o600 });
        renameSync(tmpPath, resolved);
    }
    catch {
        try {
            unlinkSync(tmpPath);
        }
        catch {
            // ignore
        }
    }
}
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
export function appendPersistedHistory(filePath, entry, maxEntries) {
    const current = loadHistory(filePath, maxEntries);
    const merged = appendHistory(current, entry, maxEntries);
    saveHistory(filePath, merged);
}
/** Append an entry to the history array and apply maxEntries limit. Returns a new array. */
export function appendHistory(entries, entry, maxEntries) {
    const updated = [...entries, entry];
    if (maxEntries != null && maxEntries > 0 && updated.length > maxEntries) {
        return updated.slice(-maxEntries);
    }
    return updated;
}
