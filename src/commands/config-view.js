import { loadPreferences } from '../config.js'
import { DEFAULT_CONFIG_FILE } from '../constants.js'

export async function configViewCmd() {
  const prefs = await loadPreferences()
  console.log(`Config file: ${DEFAULT_CONFIG_FILE}`)
  if (Object.keys(prefs).length === 0) {
    console.log('No preferences saved yet.')
    return
  }
  console.log(JSON.stringify(prefs, null, 2))
}
