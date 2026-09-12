// macOS spelling backend: one `/usr/bin/osascript -l JavaScript -e <program>`
// child per call, with a hard timeout and bounded output. A child that hangs is
// SIGKILLed, so neither the editor nor the event loop can be blocked by it.
import { spawn } from 'node:child_process'
import { JXA_PROGRAM, JXA_REQUEST_ENV } from './jxa.js'

const SPELLING_TIMEOUT_MS = 1500

const OSASCRIPT = '/usr/bin/osascript'
const MAX_OUTPUT_BYTES = 1024 * 1024

export const SPELLING_ABORTED = 'SPELLING_ABORTED'

function abortedError() {
  const error = new Error('spelling backend call aborted')
  error.code = SPELLING_ABORTED
  return error
}

/**
 * Backend for `createSpellingProvider`: `run(request, { signal })` resolves the
 * parsed JSON reply of one osascript call and rejects on any failure (non-zero
 * exit, timeout, over-long output, unparsable reply, `{ error }`, abort).
 */
export function createOsascriptBackend({
  timeoutMs = SPELLING_TIMEOUT_MS,
  maxBuffer = MAX_OUTPUT_BYTES,
  spawnFn = spawn,
} = {}) {
  return {
    run(request, { signal } = {}) {
      return new Promise((resolve, reject) => {
        let child
        try {
          child = spawnFn(OSASCRIPT, ['-l', 'JavaScript', '-e', JXA_PROGRAM], {
            env: { ...process.env, [JXA_REQUEST_ENV]: JSON.stringify(request) },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (err) {
          reject(err)
          return
        }

        let stdout = ''
        let stdoutBytes = 0
        let stderrBytes = 0
        let settled = false
        let timer = null

        const kill = () => {
          try {
            child.kill('SIGKILL')
          } catch {
            // The child is already gone.
          }
        }

        const finish = (fail, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener?.('abort', onAbort)
          if (fail) reject(value)
          else resolve(value)
        }

        const onAbort = () => {
          kill()
          finish(true, abortedError())
        }

        timer = setTimeout(() => {
          kill()
          finish(true, new Error(`osascript timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        child.stdout?.on('data', (chunk) => {
          if (settled) return
          stdout += chunk
          stdoutBytes += chunk.length
          if (stdoutBytes > maxBuffer) {
            kill()
            finish(true, new Error('osascript output exceeded the buffer limit'))
          }
        })
        child.stderr?.on('data', (chunk) => {
          if (settled) return
          // stderr is only ever diagnostics here: bound it and drop the content.
          stderrBytes += chunk.length
          if (stderrBytes > maxBuffer) {
            kill()
            finish(true, new Error('osascript error output exceeded the buffer limit'))
          }
        })
        child.on('error', (err) => finish(true, err))
        child.on('close', (code) => {
          if (settled) return
          if (code !== 0) {
            finish(true, new Error(`osascript exited with code ${code}`))
            return
          }
          let parsed
          try {
            parsed = JSON.parse(stdout)
          } catch {
            finish(true, new Error('osascript returned an unparsable reply'))
            return
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            finish(true, new Error('osascript returned an unexpected reply'))
            return
          }
          if (parsed.error !== undefined) {
            finish(true, new Error(String(parsed.error)))
            return
          }
          finish(false, parsed)
        })

        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    },
  }
}
