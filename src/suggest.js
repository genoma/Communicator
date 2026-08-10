export function matchCommands(prefix, commands) {
  return commands.filter((command) => command.startsWith(prefix))
}
