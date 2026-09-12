// Composition and the platform gate for the spelling feature: off darwin this
// returns null and the osascript backend is never constructed, so the feature
// is a complete no-op on Linux/Windows (and in CI).
import { createSpellingProvider } from './provider.js'
import { createOsascriptBackend } from './osascript.js'

export function createPlatformSpellingProvider({ features = {}, platform = process.platform, onUpdate = null } = {}) {
  if (platform !== 'darwin') return null
  return createSpellingProvider({ backend: createOsascriptBackend(), features, onUpdate })
}
