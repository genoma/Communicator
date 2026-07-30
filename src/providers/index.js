import * as openrouter from "./openrouter.js"
import * as venice from "./venice.js"

const registry = { openrouter, venice }

export function getProvider(name) {
  const p = registry[name]
  if (!p) throw new Error(`Unknown provider: ${name}. Valid providers: ${Object.keys(registry).join(", ")}`)
  return p
}
