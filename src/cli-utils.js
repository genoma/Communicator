import { CliError } from './errors.js'

export const MAX_STDIN_BYTES = 10 * 1024 * 1024

export const NO_PROMPT_MESSAGE = 'Error: no prompt provided. Pass a prompt argument or pipe input via stdin.'

export async function readStdin({ maxBytes = MAX_STDIN_BYTES } = {}) {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    total += chunk.length
    if (total > maxBytes) {
      const mb = maxBytes / (1024 * 1024)
      const limitLabel = Number.isInteger(mb) ? `${mb}MB` : `${Math.round(maxBytes / 1024)}KB`
      throw new CliError(`Error: stdin input exceeds the ${limitLabel} limit.`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8').trim()
}

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

// Commander silently treats dash-prefixed positionals that look like negative
// numbers ("-2") as arguments instead of unmapped options; reject them unless
// the user escaped them with the "--" separator.
export function findUnmappedDashArg(promptArg, argv) {
  if (promptArg && promptArg.length > 1 && promptArg.startsWith('-') && !argv.includes('--')) {
    return promptArg
  }
  return null
}

export function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}
