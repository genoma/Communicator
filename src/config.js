import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
  try {
    const data = await readFile(configFile, 'utf-8')
    return JSON.parse(data)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Warning: could not read preferences ${configFile}: ${err.message}`)
    }
    return {}
  }
}

export async function loadSystemPrompt(customPath) {
  const promptFile = customPath || DEFAULT_SYSTEM_PROMPT_FILE
  try {
    const content = await readFile(promptFile, 'utf-8')
    const trimmed = content.trim()
    return trimmed || null
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Warning: could not read ${promptFile}: ${err.message}`)
    }
    return null
  }
}

export async function savePreferences(prefs, customPath) {
  const configFile = customPath || DEFAULT_CONFIG_FILE
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(configFile, JSON.stringify(prefs, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
}

export function getImageDefaults(prefs, providerName) {
  return prefs?.imageDefaults?.[providerName] || {}
}

export function mergeImageDefaults(prefs, providerName, { aspectRatio, format } = {}) {
  if (aspectRatio === undefined && format === undefined) return prefs
  const current = getImageDefaults(prefs, providerName)
  const merged = { ...current }
  if (aspectRatio !== undefined) merged.aspectRatio = aspectRatio
  if (format !== undefined) merged.format = format
  return { ...prefs, imageDefaults: { ...(prefs.imageDefaults || {}), [providerName]: merged } }
}

export function applyPreferenceUpdates(prefs, { modelId, lastModel, lastImageModel, lastProvider, reasoningEffort, temperature, webSearch, smoothStreaming, smoothSpeed, budget, webResults, outputDir, hideWatermark, safeMode, imageDefaults } = {}) {
  const merged = { ...prefs }
  if (lastModel !== undefined) merged.lastModel = lastModel
  if (lastImageModel !== undefined) merged.lastImageModel = lastImageModel
  if (lastProvider !== undefined) merged.lastProvider = lastProvider
  if (reasoningEffort !== undefined) {
    merged.reasoningEffort = { ...prefs.reasoningEffort, [modelId]: reasoningEffort }
  }
  if (temperature !== undefined) {
    merged.temperature = { ...prefs.temperature, [modelId]: temperature }
  }
  if (webSearch !== undefined) {
    merged.webSearch = { ...prefs.webSearch, [modelId]: webSearch }
  }
  if (smoothStreaming !== undefined) merged.smoothStreaming = smoothStreaming
  if (smoothSpeed !== undefined) merged.smoothSpeed = smoothSpeed
  if (budget !== undefined) merged.budget = budget
  if (webResults !== undefined) merged.webResults = webResults
  if (outputDir !== undefined) merged.outputDir = outputDir
  if (hideWatermark !== undefined) merged.hideWatermark = hideWatermark
  if (safeMode !== undefined) merged.safeMode = safeMode
  if (imageDefaults !== undefined) merged.imageDefaults = { ...prefs.imageDefaults, ...imageDefaults }
  return merged
}
