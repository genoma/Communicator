export function resolveEffortDefault({ reasoning, forcedEffort, prefs, modelId }) {
  let effort = forcedEffort
  if (effort === undefined) {
    if (reasoning?.supportsEffort === false) {
      effort = undefined
    } else if (reasoning) {
      const saved = prefs.reasoningEffort?.[modelId]
      if (saved !== undefined) {
        effort = saved
      } else if (reasoning.default_enabled === false) {
        effort = null
      } else {
        effort = reasoning.default_effort ?? undefined
      }
    }
  }
  if (effort === 'none') effort = null
  return effort
}

export function isWebSearchSupported(providerMeta, modelData) {
  return providerMeta?.supportsWebSearchOnAll === true || modelData?.capabilities?.supportsWebSearch === true
}
