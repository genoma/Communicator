// Composition and the platform gate for the spelling feature: darwin uses the
// system checker through the compiled helper (helper-backend.js, with
// osascript.js as its silent fallback); every other platform uses the portable
// pure-JS backend (nspell.js), which serves the same contract from an English
// dictionary.
import { createSpellingProvider } from './provider.js'
import { createHelperBackend } from './helper-backend.js'
import { createNspellBackend } from './nspell.js'

export function createPlatformSpellingProvider({ features = {}, platform = process.platform, onUpdate = null } = {}) {
  const darwin = platform === 'darwin'
  const provider = createSpellingProvider({
    backend: darwin ? createHelperBackend() : createNspellBackend(),
    features,
    onUpdate,
  })
  // Dictionary completions need the system checker, so only the darwin backend
  // answers them; `/spelling` tells a portable session about that one gap.
  provider.completionsSupported = darwin
  return provider
}
