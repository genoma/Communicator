import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './fs-utils.js'

export const SIDECAR_FILE = '.index.json'

// Storage layer for the sessions `.index.json` sidecar: read/write/staleness
// and entry maintenance. Item building lives in sessions.js; the entries
// stored here are plain metadata objects keyed by session id (the id itself
// is not repeated inside the entry).

export async function readSidecar(dir) {
  try {
    return JSON.parse(await readFile(join(dir, SIDECAR_FILE), 'utf-8'))
  } catch {
    return null
  }
}

export async function writeSidecar(dir, index) {
  try {
    await writeFileAtomic(join(dir, SIDECAR_FILE), JSON.stringify(index, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // sidecar failures are non-fatal
  }
}

export async function sidecarStale(dir, jsonFiles) {
  try {
    const sidecarStat = await stat(join(dir, SIDECAR_FILE))
    const fileStats = await Promise.all(jsonFiles.map((file) => stat(join(dir, file))))
    return fileStats.some((s) => s.mtimeMs > sidecarStat.mtimeMs)
  } catch {
    return true
  }
}

export async function updateSidecar(dir, item) {
  try {
    const index = (await readSidecar(dir)) || {}
    const { id, ...meta } = item
    index[id] = meta
    await writeSidecar(dir, index)
  } catch {
    // sidecar failures are non-fatal
  }
}

export async function dropSidecarEntry(dir, id) {
  try {
    const index = (await readSidecar(dir)) || {}
    if (index[id]) {
      delete index[id]
      await writeSidecar(dir, index)
    }
  } catch {
    // sidecar failures are non-fatal
  }
}

// Batched two-way reconciliation in one read-modify-write: `remove` drops
// ghost entries whose file is gone, `add` re-registers session files the
// index never mentioned (a concurrent instance's lost update).
export async function reconcileSidecar(dir, { add = [], remove = [] } = {}) {
  try {
    const index = (await readSidecar(dir)) || {}
    let changed = false
    for (const id of remove) {
      if (index[id]) {
        delete index[id]
        changed = true
      }
    }
    for (const item of add) {
      const { id, ...meta } = item
      index[id] = meta
      changed = true
    }
    if (changed) await writeSidecar(dir, index)
  } catch {
    // sidecar failures are non-fatal
  }
}
