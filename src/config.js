import { readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG_FILE = join(homedir(), ".communicator.json");
const DEFAULT_SYSTEM_PROMPT_FILE = join(homedir(), ".communicator-system-prompt.md");

export function getApiKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    console.error("OPENROUTER_API_KEY environment variable is not set.");
    process.exit(1);
  }
  return key;
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
