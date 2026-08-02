import { loadPreferences } from '../config.js'
import { DEFAULT_CONFIG_FILE } from '../constants.js'

export async function configViewCmd(configPath) {
  const file = configPath || DEFAULT_CONFIG_FILE
  const prefs = await loadPreferences(configPath)
  console.log(`Config file: ${file}`)
  if (Object.keys(prefs).length === 0) {
    console.log('No preferences saved yet.')
    return
  }
  console.log(JSON.stringify(prefs, null, 2))
}
