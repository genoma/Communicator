import { readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_KEY_FILE = join(homedir(), ".openrouter-key");
const DEFAULT_CONFIG_FILE = join(homedir(), ".communicator.json");

export async function getApiKey(customPath) {
  const keyFile = customPath || DEFAULT_KEY_FILE;
  try {
    const data = await readFile(keyFile, "utf-8");
    const key = data.trim();
    if (!key) {
      throw new Error(`API key file is empty: ${keyFile}`);
    }
    return key;
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`No API key found at: ${keyFile}`);
      console.error(
        `Create this file with your OpenRouter API key, or use --key-file to specify a different path.`
      );
      process.exit(1);
    }
    throw err;
  }
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

export async function savePreferences(prefs, customPath) {
  const configFile = customPath || DEFAULT_CONFIG_FILE;
  await writeFile(configFile, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
}
