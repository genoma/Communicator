export function registerSignalHandlers(handlers) {
  const onSigint = () => handlers.sigint()
  const onBeforeExit = () => handlers.beforeExit()
  const onUncaught = (err) => handlers.uncaughtException(err)
  process.on('SIGINT', onSigint)
  process.on('beforeExit', onBeforeExit)
  process.on('uncaughtException', onUncaught)
  return () => {
    process.off('SIGINT', onSigint)
    process.off('beforeExit', onBeforeExit)
    process.off('uncaughtException', onUncaught)
  }
}
