export function resolveFlagOrExit(resolve, value) {
  try {
    return resolve(value)
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}

export function collectFlag(value, acc) {
  acc.push(value)
  return acc
}
