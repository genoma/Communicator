function sanitize(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x1b]*(?:\x1b\\)?/g, '')
    .replace(/[\x1b\n\r]/g, '')
}

export function hyperlink(url, label) {
  const cleanUrl = sanitize(url)
  const cleanLabel = sanitize(label)
  if (!cleanUrl) return null
  return `\x1b]8;;${cleanUrl}\x1b\\${cleanLabel}\x1b]8;;\x1b\\`
}
