import { mkdir, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from './fs-utils.js'
import { getProvider } from './providers/index.js'
import { CliError } from './errors.js'
import { DEFAULT_CONFIG_FILE, DEFAULT_SYSTEM_PROMPT_FILE } from './constants.js'

export function getApiKey(providerType = 'openrouter') {
  const { meta } = getProvider(providerType)
  const key = process.env[meta.apiKeyEnv]?.trim()
  if (!key) {
    throw new CliError(`Error: ${meta.apiKeyEnv} environment variable is not set.`)
  }
  return key
}

export async function loadPreferences(customPath) {
  const configFile = customPath || DEFAULT_CONFIG_FILE
  let data
  try {
    data = await readFile(configFile, 'utf-8')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Warning: could not read preferences ${configFile}: ${err.message}`)
    }
    return {}
  }
  try {
    const parsed = JSON.parse(data)
    // An own `__proto__` key survives JSON.parse and would swap the prefs
    // object's prototype when assigned via [[Set]] (Object.assign or
    // `target[key] =`); `constructor`/`prototype` are equally never legit
    // prefs keys. Drop them on load so a hand-edited file cannot poison the
    // shared state or get re-persisted.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(parsed)) {
        if (UNSAFE_PREF_KEYS.has(key)) delete parsed[key]
      }
    }
    return parsed
  } catch (err) {
    // A corrupt file must not be silently clobbered by the next save: move
    // it aside so the original preferences survive as a backup.
    const backup = `${configFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await rename(configFile, backup)
      console.error(`Warning: preferences file ${configFile} is corrupt (${err.message}); it was moved to ${backup}. Starting with empty preferences.`)
    } catch {
      console.error(`Warning: preferences file ${configFile} is corrupt (${err.message}); starting with empty preferences.`)
    }
    return {}
  }
}

export async function loadSystemPrompt(customPath) {
  const promptFile = customPath || DEFAULT_SYSTEM_PROMPT_FILE
  let content
  try {
    content = await readFile(promptFile, 'utf-8')
  } catch (err) {
    // An explicitly requested prompt file is a user error, not a silent
    // fallback: fail loudly instead of quietly using the default prompt.
    // The default file stays optional, so its absence (or an unreadable
    // default) still degrades to the built-in prompt with a warning.
    if (customPath) {
      throw new CliError(err.code === 'ENOENT'
        ? `Error: system prompt file not found: ${promptFile}`
        : `Error: could not read system prompt file ${promptFile}: ${err.message}`)
    }
    if (err.code !== 'ENOENT') {
      console.error(`Warning: could not read ${promptFile}: ${err.message}`)
    }
    return null
  }
  const trimmed = content.trim()
  return trimmed || null
}

export async function savePreferences(prefs, customPath) {
  const configFile = customPath || DEFAULT_CONFIG_FILE
  await mkdir(dirname(configFile), { recursive: true })
  await writeFileAtomic(configFile, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 })
}

// Best-effort prefs persistence: a failing disk must never take a session
// down with a raw fs error. All call sites share this wrapper so the warning
// wording stays consistent.
export function savePrefsBestEffort(save, onError = (message) => console.warn(message)) {
  return async (...args) => {
    try {
      await save(...args)
    } catch (err) {
      onError(`Warning: could not save preferences: ${err.message}`)
    }
  }
}

const UNSAFE_PREF_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// In-place merge used by every prefs writer: skips keys that would trigger
// the __proto__ setter (or shadow the object's constructor) when assigned
// via [[Set]]. The prefs object may hold JSON-parsed data, so an own
// `__proto__` data property from a previous version of this file must never
// reach an assignment.
export function mergePreferenceState(prefs, updates) {
  for (const key of Object.keys(updates)) {
    if (UNSAFE_PREF_KEYS.has(key)) continue
    prefs[key] = updates[key]
  }
  return prefs
}

// Applies a delta like applyPreferenceUpdates but ALSO keeps the shared prefs
// object current (mutated in place) and returns the merged object. Every
// writer then merges from the latest state instead of the launch snapshot, so
// a mid-session change (/smooth, /budget, /web-results, image defaults) is
// preserved by the end-of-session prefs save instead of being dropped.
export function syncPreferenceUpdates(prefs, updates) {
  const merged = applyPreferenceUpdates(prefs, updates)
  mergePreferenceState(prefs, merged)
  return merged
}

export function getImageDefaults(prefs, providerName) {
  return prefs?.imageDefaults?.[providerName] || {}
}

export function mergeImageDefaults(prefs, providerName, { aspectRatio, format, resolution, quality, variants } = {}) {
  if (aspectRatio === undefined && format === undefined && resolution === undefined && quality === undefined && variants === undefined) return prefs
  const current = getImageDefaults(prefs, providerName)
  const merged = { ...current }
  if (aspectRatio !== undefined) merged.aspectRatio = aspectRatio
  if (format !== undefined) merged.format = format
  if (resolution !== undefined) merged.resolution = resolution
  if (quality !== undefined) merged.quality = quality
  if (variants !== undefined) merged.variants = variants
  return { ...prefs, imageDefaults: { ...(prefs.imageDefaults || {}), [providerName]: merged } }
}

// Removes one persisted image-default key (aspectRatio/format/...) for the
// provider; returns the updated prefs object.
export function clearImageDefault(prefs, providerName, key) {
  const defaults = { ...getImageDefaults(prefs, providerName) }
  delete defaults[key]
  return { ...prefs, imageDefaults: { ...(prefs.imageDefaults || {}), [providerName]: defaults } }
}

// Per-model pref update: null clears the persisted value for the model
// (sampling params only — null is never a valid temperature/top-p), anything
// else sets it. Returns the original map when nothing changes.
function mergePerModelPref(map, modelId, value) {
  const unchanged = value === null && !(map && modelId in map)
  if (unchanged) return map
  const next = { ...map }
  if (value === null) delete next[modelId]
  else next[modelId] = value
  return next
}

export function applyPreferenceUpdates(prefs, { modelId, lastModel, lastImageModel, lastProvider, reasoningEffort, temperature, topP, webSearch, smoothStreaming, smoothSpeed, compactThinking, budget, webResults, outputDir, hideWatermark, safeMode, imageDefaults } = {}) {
  const merged = { ...prefs }
  if (lastModel !== undefined) merged.lastModel = lastModel
  if (lastImageModel !== undefined) merged.lastImageModel = lastImageModel
  if (lastProvider !== undefined) merged.lastProvider = lastProvider
  if (reasoningEffort !== undefined) {
    merged.reasoningEffort = { ...prefs.reasoningEffort, [modelId]: reasoningEffort }
  }
  if (temperature !== undefined) {
    const next = mergePerModelPref(prefs.temperature, modelId, temperature)
    if (next !== prefs.temperature) merged.temperature = next
  }
  if (topP !== undefined) {
    const next = mergePerModelPref(prefs.topP, modelId, topP)
    if (next !== prefs.topP) merged.topP = next
  }
  if (webSearch !== undefined) {
    merged.webSearch = { ...prefs.webSearch, [modelId]: webSearch }
  }
  if (smoothStreaming !== undefined) merged.smoothStreaming = smoothStreaming
  if (smoothSpeed !== undefined) merged.smoothSpeed = smoothSpeed
  if (compactThinking !== undefined) merged.compactThinking = compactThinking
  if (budget !== undefined) merged.budget = budget
  if (webResults !== undefined) merged.webResults = webResults
  if (outputDir !== undefined) merged.outputDir = outputDir
  if (hideWatermark !== undefined) merged.hideWatermark = hideWatermark
  if (safeMode !== undefined) merged.safeMode = safeMode
  if (imageDefaults !== undefined) merged.imageDefaults = { ...prefs.imageDefaults, ...imageDefaults }
  return merged
}
