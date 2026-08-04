import { CliError } from './errors.js'

export function resolveFlagOrExit(resolve, value) {
  try {
    return resolve(value)
  } catch (err) {
    throw new CliError(`Error: ${err.message}`)
  }
}

export function collectFlag(value, acc) {
  acc.push(value)
  return acc
}

export function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}
