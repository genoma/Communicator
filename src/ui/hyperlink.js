// ANSI escape sequences are the domain of this module
/* eslint-disable no-control-regex */

// Strips ANSI escape sequences (CSI, OSC, charset-select, stray ESC) while
// preserving newlines — safe for multi-line model/provider-derived text
// written to the terminal.
export function sanitizeAnsi(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x1b]*(?:\x1b\\)?/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b/g, '')
}

// Link labels/URLs must stay single-line: newlines are stripped here in
// addition to the escape removal.
function sanitize(text) {
  return sanitizeAnsi(text).replace(/[\n\r]/g, '')
}

export function hyperlink(url, label) {
  const cleanUrl = sanitize(url)
  const cleanLabel = sanitize(label)
  if (!cleanUrl) return null
  return `\x1b]8;;${cleanUrl}\x1b\\${cleanLabel}\x1b]8;;\x1b\\`
}
