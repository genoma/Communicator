import { readFile, writeFile, access } from "node:fs/promises"
import { DEFAULT_CONFIG_FILE, DEFAULT_SYSTEM_PROMPT_FILE } from "./constants.js"

const KEY_ENV_MAP = {
  openrouter: "OPENROUTER_API_KEY",
  venice: "VENICE_API_KEY",
}

export function getApiKey(providerName = "openrouter") {
  const envVar = KEY_ENV_MAP[providerName]
  if (!envVar) {
    console.error(`Unknown provider: ${providerName}`)
    process.exit(1)
  }
  const key = process.env[envVar]?.trim()
  if (!key) {
    console.error(`${envVar} environment variable is not set.`)
    process.exit(1)
  }
  return key
}

export async function loadPreferences(customPath) {
  const configFile = customPath || DEFAULT_CONFIG_FILE;
  try {
    await access(configFile);
    const data = await readFile(configFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export async function loadSystemPrompt(customPath) {
  const promptFile = customPath || DEFAULT_SYSTEM_PROMPT_FILE;
  try {
    await access(promptFile);
    const content = await readFile(promptFile, "utf-8");
    const trimmed = content.trim();
    return trimmed || null;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Warning: could not read ${promptFile}: ${err.message}`);
    }
    return null;
  }
}

export async function savePreferences(prefs, customPath) {
  const configFile = customPath || DEFAULT_CONFIG_FILE;
  await writeFile(configFile, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
}
