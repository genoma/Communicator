export function matchCommands(prefix, commands) {
  return commands.filter((command) => command.startsWith(prefix))
}

export function shouldSuggest({ value, cursor }, commands) {
  if (typeof value !== 'string' || value.includes('\n')) return false
  if (!value.startsWith('/')) return false
  if (cursor !== value.length) return false
  const matches = matchCommands(value, commands)
  return matches.length > 0 && !matches.includes(value)
}

export function nextMatchIndex(currentLine, matches, dir) {
  if (matches.length === 0) return -1
  const selected = matches.indexOf(currentLine)
  const start = selected !== -1 ? selected : dir > 0 ? -1 : 0
  return (start + dir + matches.length) % matches.length
}
