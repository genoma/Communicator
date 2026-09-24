// HEIC/HEIF decode through the macOS system codec: sharp's prebuilds ship no
// HEVC decoder and bundling one is out of scope, so `/usr/bin/sips` is the only
// route. Off darwin this returns null without spawning anything, and every
// failure here is silent — the caller owns the user-facing error.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SIPS = '/usr/bin/sips'
const DEFAULT_TIMEOUT_MS = 15000

export async function decodeHeic(buffer, { platform = process.platform, spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (platform !== 'darwin') return null
  const dir = await mkdtemp(join(tmpdir(), 'communicator-heic-')).catch(() => null)
  if (!dir) return null
  const source = join(dir, 'source.heic')
  const target = join(dir, 'decoded.jpg')
  try {
    await writeFile(source, buffer)
    if (await sipsExitCode(spawnFn, source, target, timeoutMs) !== 0) return null
    return await readFile(target)
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function sipsExitCode(spawnFn, source, target, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }
    const child = spawnFn(SIPS, ['-s', 'format', 'jpeg', '--out', target, source], { stdio: 'ignore' })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve(null)
    }, timeoutMs)
    child.on('error', () => settle(null))
    child.on('close', (code) => settle(code))
  })
}
