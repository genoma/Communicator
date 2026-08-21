// ANSI escape sequences are the domain of this module
/* eslint-disable no-control-regex */

// Strips ANSI escape sequences (full CSI with parameter/intermediate bytes,
// OSC, charset-select, stray ESC) while preserving newlines — safe for
// multi-line model/provider-derived text written to the terminal.
export function sanitizeAnsi(text) {
  return String(text ?? '')
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    .replace(/\x1b\][^\x1b]*(?:\x1b\\)?/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b/g, '')
}

// Link labels/URLs must stay single-line: newlines are stripped here in
// addition to the escape removal.
export function sanitizeSingleLine(text) {
  return sanitizeAnsi(text).replace(/[\n\r]/g, '')
}

const sanitize = sanitizeSingleLine

// Same scheme policy as the markdown exporter: only http(s) URLs may become
// clickable terminal links.
const SAFE_LINK_RE = /^https?:\/\//i

export function hyperlink(url, label) {
  const cleanUrl = sanitize(url)
  const cleanLabel = sanitize(label)
  if (!cleanUrl || !SAFE_LINK_RE.test(cleanUrl)) return null
  return `\x1b]8;;${cleanUrl}\x1b\\${cleanLabel}\x1b]8;;\x1b\\`
}
