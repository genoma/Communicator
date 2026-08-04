import { resolveReasoningFlag, resolveTemperatureFlag, resolveWebResultsFlag, resolveBudget, resolveSmoothSpeed, normalizeSmoothSpeed, resolvePrefOrNull } from './flags.js'
import { resolveFlagOrExit } from './cli-utils.js'
import { ensureSessionsDir, saveSession, buildSessionPayload } from './sessions.js'
import { savePreferences, applyPreferenceUpdates } from './config.js'

export function resolveSessionFlags(opts, prefs) {
  const forcedBudget = resolveFlagOrExit(resolveBudget, opts.budget)
  return {
    forcedEffort: resolveReasoningFlag({ reasoningEffort: opts.reasoningEffort }),
    forcedTemperature: resolveFlagOrExit((v) => resolveTemperatureFlag({ temperature: v }), opts.temperature),
    forcedBudget,
    budget: forcedBudget ?? resolvePrefOrNull(resolveBudget, prefs.budget) ?? null,
    forcedWebResults: resolveFlagOrExit((v) => resolveWebResultsFlag({ webResults: v }), opts.webResults),
    smoothSpeed: resolveFlagOrExit(resolveSmoothSpeed, opts.smoothSpeed) ?? normalizeSmoothSpeed(prefs.smoothSpeed),
    zdr: opts.zdr === true,
  }
}

export function attachGateOptions(selection, providerMeta) {
  return {
    visionSupported: selection.visionSupported,
    fileSupported: selection.fileSupported,
    providerName: providerMeta.name,
  }
}

export async function persistSession({ finalState, prefs, config }) {
  if (finalState.sessionId && finalState.messages && finalState.messages.length > 1) {
    try {
      const dir = await ensureSessionsDir()
      await saveSession(dir, finalState.sessionId, buildSessionPayload(finalState))
    } catch {
      // save failures are non-fatal
    }
  }

  await savePreferences(applyPreferenceUpdates(prefs, {
    modelId: finalState.modelId,
    lastModel: finalState.modelId,
    lastProvider: finalState.endpointProviderName,
    reasoningEffort: finalState.reasoningEffort,
    temperature: finalState.temperature,
    webSearch: finalState.webSearch,
  }), config)
}
