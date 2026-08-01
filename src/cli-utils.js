export function resolveFlagOrExit(resolve, value) {
  try {
    return resolve(value)
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}
