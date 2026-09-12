// Composition and the platform gate for the spelling feature: off darwin this
// returns null and no backend is constructed, so the feature is a complete
// no-op on Linux/Windows (and in CI). On darwin the compiled helper
// (helper-backend.js) is preferred and the osascript backend is its silent
// fallback — until the best-effort build lands, and after any helper failure.
import { createSpellingProvider } from './provider.js'
import { createHelperBackend } from './helper-backend.js'

export function createPlatformSpellingProvider({ features = {}, platform = process.platform, onUpdate = null } = {}) {
  if (platform !== 'darwin') return null
  return createSpellingProvider({ backend: createHelperBackend(), features, onUpdate })
}
