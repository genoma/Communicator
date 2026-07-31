import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { getProvider } from "./providers/index.js"
import { DEFAULT_CONFIG_FILE, DEFAULT_SYSTEM_PROMPT_FILE } from "./constants.js"

export function getApiKey(providerType = "openrouter") {
  const { meta } = getProvider(providerType)
  const key = process.env[meta.apiKeyEnv]?.trim()
  if (!key) {
    console.error(`${meta.apiKeyEnv} environment variable is not set.`)
    process.exit(1)
  }
  return key
}

export async function loadPreferences(customPath) {
  const configFile = customPath || DEFAULT_CONFIG_FILE
  try {
    const data = await readFile(configFile, "utf-8")
    return JSON.parse(data)
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Warning: could not read preferences ${configFile}: ${err.message}`)
    }
    return {}
  }
}

export async function loadSystemPrompt(customPath) {
  const promptFile = customPath || DEFAULT_SYSTEM_PROMPT_FILE
  try {
    const content = await readFile(promptFile, "utf-8")
    const trimmed = content.trim()
    return trimmed || null
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Warning: could not read ${promptFile}: ${err.message}`)
    }
    return null
  }
}

export async function savePreferences(prefs, customPath) {
  const configFile = customPath || DEFAULT_CONFIG_FILE
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(configFile, JSON.stringify(prefs, null, 2) + "\n", "utf-8")
}
