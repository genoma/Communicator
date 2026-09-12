// Compiled-helper spelling backend (macOS). src/spelling/helper.m is compiled
// once into a cache directory under the user's home and one long-lived child
// then answers requests as newline-delimited JSON — replacing the per-call
// `osascript` spawn of osascript.js.
//
// Every failure is silent and falls back to that same osascript backend: a
// missing compiler, a failed or timed-out build, a spawn error, a crash, a
// watchdog expiry and a malformed reply all end as "use the fallback", so the
// feature can only ever get faster, never worse. The provider keeps owning the
// 3-failure latch and the silent policy; this module never prints anything.
//
// There is no build artifact in the repo and no new dependency: the binary
// lives at `<cache>/spelling-helper-<hash>`, and the build happens at most once
// per source+toolchain, lazily, on the first request (which itself runs on
// osascript, exactly like every request until the build lands).
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, readlink, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from '../constants.js'
import {
  SPELLING_MAX_OUTPUT_BYTES,
  SPELLING_TIMEOUT_MS,
  createOsascriptBackend,
  spellingAbortedError,
} from './osascript.js'

const COMPILER = '/usr/bin/cc'
const COMPILER_FLAGS = ['-O2', '-fobjc-arc', '-framework', 'AppKit']

const HELPER_SOURCE = fileURLToPath(new URL('./helper.m', import.meta.url))

// `/usr/bin/cc` is a developer-tools shim: with no Command Line Tools it does not
// fail quietly, it makes macOS offer the developer-tools installer — a system
// dialog triggered by the user's first spell check. The toolchain is therefore
// probed by FILESYSTEM only (no spawn), and a machine without one stays on the
// osascript fallback instead of asking the user to install anything.
const DEVELOPER_LINK = '/var/db/xcode_select_link'
const DEVELOPER_DIRS = ['/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer']

const BUILD_TIMEOUT_MS = 30_000
const MAX_HELPER_RESTARTS = 1

// The OS release enters the cache key through `process.getBuiltinModule` rather
// than an import: several test files mock `node:os` down to `homedir` alone, and
// a static `release` import would fail to link there.
const OS_RELEASE = process.getBuiltinModule?.('node:os')?.release?.() ?? ''

/** True when one of the candidate developer directories actually carries clang */
async function compilerAvailable(candidates) {
  for (const candidate of candidates) {
    const dir = candidate === DEVELOPER_LINK ? await readlink(candidate).catch(() => null) : candidate
    if (dir === null) continue
    if (await access(join(dir, 'usr/bin/clang'), fsConstants.X_OK).then(() => true, () => false)) return true
  }
  return false
}

// The cached name is a hash of the source bytes plus everything that can change
// what a rebuild would produce: the toolchain fingerprint here is the ACTIVE
// developer directory's clang (the `/usr/bin/cc` shim itself is replaced only by
// an OS update, so its size/mtime alone would miss a Command Line Tools update
// or an `xcode-select -s` switch), plus the OS release and the flags.
async function helperName(source) {
  const developerDir =
    (await readlink(DEVELOPER_LINK).catch(() => null)) ?? DEVELOPER_DIRS.find(() => true)
  const compiler = await stat(join(developerDir, 'usr/bin/clang')).catch(() => null)
  const digest = createHash('sha256')
    .update(source)
    .update(process.platform)
    .update(process.arch)
    .update(OS_RELEASE)
    .update(COMPILER_FLAGS.join(' '))
    .update(`${compiler?.size ?? 0}:${compiler?.mtimeMs ?? 0}`)
    .digest('hex')
  return `spelling-helper-${digest.slice(0, 16)}`
}

/**
 * Backend for `createSpellingProvider` with the same interface as
 * `createOsascriptBackend`: `run(request, { signal })` resolves the parsed JSON
 * reply of one request (`{ ranges | words | correction }`) and rejects on
 * `{ error }`, a dead child, a watchdog expiry or an abort.
 *
 * `whenReady()` starts the build if it has not started yet and resolves true
 * once the compiled helper is in use (false when the session stays on the
 * fallback); tests await it, the provider never does.
 */
export function createHelperBackend({
  fallback = createOsascriptBackend(),
  sourcePath = HELPER_SOURCE,
  cacheDir = DATA_DIR,
  spawnFn = spawn,
  timeoutMs = SPELLING_TIMEOUT_MS,
  buildTimeoutMs = BUILD_TIMEOUT_MS,
  maxBuffer = SPELLING_MAX_OUTPUT_BYTES,
  toolchainDirs = [DEVELOPER_LINK, ...DEVELOPER_DIRS],
} = {}) {
  const pending = new Map()
  let binary = null
  let building = null
  let compiling = null
  let running = null
  let compiled = false
  let restartsLeft = MAX_HELPER_RESTARTS
  let nextId = 0
  let disposed = false

  /**
   * The first helper failure spends the session's one restart, the next latches
   * osascript back in — and drops the cached binary, which may be the thing that
   * keeps failing (a corrupt or unloadable file would otherwise latch the fast
   * path off for the life of the install, since only a source or toolchain
   * change invalidates the name).
   */
  const loseHelper = () => {
    if (restartsLeft > 0) {
      restartsLeft -= 1
      return
    }
    compiled = false
    if (binary !== null) void rm(binary, { force: true }).catch(() => {})
  }

  /**
   * Drop the current helper: kill it and hand everything it still owes to the
   * fallback, so no caller is ever left waiting on a dead child.
   */
  const abandon = () => {
    const record = running
    if (record === null) return
    running = null
    try {
      record.child.kill('SIGKILL')
    } catch {
      // The child is already gone.
    }
    loseHelper()
    const owed = [...pending.values()]
    pending.clear()
    for (const entry of owed) entry.retry()
  }

  /** Dispatch one complete reply line; the reply of a dropped request matches no id */
  const deliver = (line) => {
    let reply
    try {
      reply = JSON.parse(line)
    } catch {
      abandon()
      return
    }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
      abandon()
      return
    }
    const entry = pending.get(reply.id)
    if (entry === undefined) {
      // A line that names no request at all is a protocol violation.
      if (!Number.isInteger(reply.id)) abandon()
      return
    }
    if (reply.error !== undefined) {
      entry.finish(true, new Error(String(reply.error)))
      return
    }
    entry.finish(false, reply)
  }

  /** Reassemble the newline-delimited replies of one child from arbitrarily split reads */
  const ingest = (record, chunk) => {
    record.buffer += record.decoder.write(chunk)
    let index
    while ((index = record.buffer.indexOf('\n')) !== -1) {
      const line = record.buffer.slice(0, index)
      record.buffer = record.buffer.slice(index + 1)
      if (line !== '') deliver(line)
    }
    // The cap bounds what one over-long reply can leave behind, not the valid
    // complete lines that arrived in the same chunk.
    if (record.buffer.length > maxBuffer) abandon()
  }

  const startHelper = () => {
    let child
    try {
      child = spawnFn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      loseHelper()
      return null
    }
    const record = { child, buffer: '', decoder: new StringDecoder('utf8') }
    running = record
    // The helper outlives every request, so its handles are unref'ed: dispose()
    // kills it, and until then it can never hold the REPL open past a prompt.
    child.unref?.()
    child.stdin?.unref?.()
    child.stdout?.unref?.()
    child.stderr?.unref?.()
    // stderr is diagnostics only, on both sides of the protocol.
    child.stderr?.on('data', () => {})
    child.stdin?.on('error', () => {
      if (running === record) abandon()
    })
    child.on('error', () => {
      if (running === record) abandon()
    })
    child.on('exit', () => {
      if (running === record) abandon()
    })
    child.stdout?.on('data', (chunk) => {
      if (running === record) ingest(record, chunk)
    })
    return record
  }

  /**
   * Build the helper into `target` and publish it by rename, so a build that is
   * killed or fails never leaves a half-written binary in the cache. The scratch
   * name is unique per process: two sessions sharing a cache entry must never
   * write the same file, or one can rename a byte-mix of both compiles into the
   * cache and be trusted forever.
   */
  const compile = (target) =>
    new Promise((resolve) => {
      if (disposed) {
        resolve(false)
        return
      }
      const scratch = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      let child
      try {
        child = spawnFn(COMPILER, [...COMPILER_FLAGS, '-o', scratch, sourcePath], {
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      } catch {
        resolve(false)
        return
      }
      compiling = child
      child.unref?.()
      child.stderr?.unref?.()
      child.stderr?.on('data', () => {})
      let timer = null
      const finish = (ok) => {
        clearTimeout(timer)
        compiling = null
        if (!ok) {
          void rm(scratch, { force: true }).catch(() => {})
          resolve(false)
          return
        }
        rename(scratch, target).then(
          () => resolve(true),
          () => resolve(false)
        )
      }
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // The compiler is already gone.
        }
        finish(false)
      }, buildTimeoutMs)
      timer.unref?.()
      child.on('error', () => finish(false))
      child.on('close', (code) => finish(code === 0))
    })

  const buildHelper = async () => {
    try {
      if (disposed) return false
      if (!(await compilerAvailable(toolchainDirs))) {
        compiled = false
        return false
      }
      const source = await readFile(sourcePath)
      if (disposed) return false
      binary = join(cacheDir, await helperName(source))
      const cached = await access(binary, fsConstants.X_OK).then(
        () => true,
        () => false
      )
      if (cached) {
        compiled = true
        return true
      }
      await mkdir(cacheDir, { recursive: true, mode: 0o700 })
      if (disposed) return false
      compiled = await compile(binary)
    } catch {
      compiled = false
    }
    return compiled
  }

  const startBuild = () => {
    if (building === null) building = buildHelper()
    return building
  }

  return {
    whenReady() {
      // The live state, not the memoised build result: after the helper latches
      // off, every request is osascript and `true` would be a lie.
      return startBuild().then(() => compiled && !disposed)
    },

    run(request, { signal } = {}) {
      if (disposed) return Promise.resolve(null)
      if (!compiled) {
        void startBuild()
        return fallback.run(request, { signal })
      }
      const record = running ?? startHelper()
      if (record === null) return fallback.run(request, { signal })
      const id = (nextId += 1)
      return new Promise((resolve, reject) => {
        const entry = { id, settled: false, timer: null, onAbort: null, finish: null, retry: null }
        const release = () => {
          clearTimeout(entry.timer)
          signal?.removeEventListener?.('abort', entry.onAbort)
          pending.delete(id)
        }
        entry.finish = (fail, value) => {
          if (entry.settled) return
          entry.settled = true
          release()
          if (fail) reject(value)
          else resolve(value)
        }
        // A superseded request is simply forgotten: its late reply matches no
        // pending id and is dropped instead of failing the helper.
        entry.onAbort = () => entry.finish(true, spellingAbortedError())
        entry.retry = () => {
          entry.settled = true
          release()
          void fallback.run(request, { signal }).then(resolve, reject)
        }
        if (signal?.aborted) {
          entry.finish(true, spellingAbortedError())
          return
        }
        pending.set(id, entry)
        // The watchdog is the hard bound on a checker that hangs (see jxa.js):
        // it kills the child and re-runs this request on osascript.
        entry.timer = setTimeout(() => abandon(), timeoutMs)
        signal?.addEventListener?.('abort', entry.onAbort, { once: true })
        try {
          record.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`, (error) => {
            if (error) abandon()
          })
        } catch {
          abandon()
        }
      })
    },

    /** Kill the helper, resolve every caller it still owes and never spawn again */
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of [...pending.values()]) entry.finish(false, null)
      pending.clear()
      const children = []
      if (running !== null) children.push(running.child)
      if (compiling !== null) children.push(compiling)
      // Cleared before the kills: the exit of a child we just killed must not
      // read as a helper failure and spend the restart budget.
      running = null
      compiling = null
      for (const child of children) {
        try {
          child.kill('SIGKILL')
        } catch {
          // The child is already gone.
        }
      }
      fallback.dispose?.()
    },
  }
}
