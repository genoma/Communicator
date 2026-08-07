export function registerSignalHandlers(handlers) {
  const onSigint = () => handlers.sigint()
  // SIGTERM (kill, service shutdown) takes the same path as SIGINT: abort
  // the active stream or save and exit.
  const onSigterm = () => handlers.sigint()
  const onBeforeExit = () => handlers.beforeExit()
  const onUncaught = (err) => handlers.uncaughtException(err)
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  process.on('beforeExit', onBeforeExit)
  process.on('uncaughtException', onUncaught)
  return () => {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('beforeExit', onBeforeExit)
    process.off('uncaughtException', onUncaught)
  }
}
