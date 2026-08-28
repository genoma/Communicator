import { resolveFlagValues, resolveWebSearchFlag, webSearchGate, resolvePrefOrNull, resolveBudget, resolveWebResultsFlag, normalizeSmoothSpeed } from './flags.js'
import { CliError } from './errors.js'
import { selectModelAndEndpoint, selectModelNonInteractive } from './model-selection.js'

import { persistSessionFile, buildSessionPayload } from './sessions.js'
import { savePreferences, savePrefsBestEffort, syncPreferenceUpdates } from './config.js'

export function resolveSessionFlags(opts, prefs) {
  try {
    const { reasoningEffort: forcedEffort, temperature: forcedTemperature, topP: forcedTopP, budget: forcedBudget, webResults: forcedWebResults, smoothSpeed } = resolveFlagValues(opts)
    return {
      forcedEffort,
      forcedTemperature,
      forcedTopP,
      forcedBudget,
      budget: forcedBudget ?? resolvePrefOrNull(resolveBudget, prefs.budget) ?? null,
      forcedWebResults,
      smoothSpeed: smoothSpeed ?? normalizeSmoothSpeed(prefs.smoothSpeed),
      compactThinking: opts.compactThinking === true || prefs.compactThinking === true,
      zdr: opts.zdr === true,
      e2ee: opts.e2ee === true,
    }
  } catch (err) {
    throw new CliError(`Error: ${err.message}`)
  }
}

export function attachGateOptions(selection, providerMeta) {
  return {
    visionSupported: selection.visionSupported,
    fileSupported: selection.fileSupported,
    providerName: providerMeta.name,
  }
}

// Resolves a sampling param (temperature/top-p): an explicit flag wins over
// the persisted per-model pref; a null forced value (the "default" keyword)
// clears the persisted pref and falls back to the provider default.
function samplingPrefValue(forced, persisted, prefs, section, modelId) {
  if (forced === null) {
    if (prefs[section]?.[modelId] !== undefined) {
      syncPreferenceUpdates(prefs, { modelId, [section]: null })
    }
    return undefined
  }
  return forced ?? persisted
}

export async function buildSessionContext({ provider, apiKey, opts, prefs, forcedEffort, forcedTemperature, forcedTopP, forcedWebResults, zdr, e2ee = false, allowInteractive = true }) {
  let selection
  if (opts.model) {
    selection = await selectModelNonInteractive({ provider, apiKey, prefs, modelId: opts.model, forcedEffort, zdr, e2ee })
  } else if (allowInteractive) {
    selection = await selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort: forcedEffort, zdr, e2ee })
  } else {
    throw new CliError('Error: interactive model selection needs a TTY. Use -m <model-id> when piping input.')
  }

  const webSearch = e2ee ? 'off' : resolveWebSearchFlag({ webSearch: opts.webSearch, webResults: forcedWebResults, prefValue: prefs.webSearch?.[selection.modelId] })
  const webSearchExplicit = !e2ee && (opts.webSearch !== undefined || forcedWebResults != null)
  const gateError = webSearchGate(webSearch, selection.webSearchSupported)
  if (gateError) throw new CliError(`Error: ${gateError}`)

  if (opts.rpg !== undefined && selection.isImageModel === true) {
    throw new CliError('Error: --rpg is for text chat models only; the selected model is an image model.')
  }

  return {
    selection,
    temperature: samplingPrefValue(forcedTemperature, prefs.temperature?.[selection.modelId], prefs, 'temperature', selection.modelId),
    topP: samplingPrefValue(forcedTopP, prefs.topP?.[selection.modelId], prefs, 'topP', selection.modelId),
    webSearch,
    webSearchExplicit,
    webResults: e2ee ? null : forcedWebResults ?? resolvePrefOrNull((v) => resolveWebResultsFlag({ webResults: v }), prefs.webResults) ?? null,
  }
}

export async function persistSession({ finalState, prefs, config }) {
  if (finalState.sessionId && finalState.messages && finalState.messages.length > 1) {
    await persistSessionFile(finalState.sessionId, buildSessionPayload(finalState))
  }

  // prefs save failures are non-fatal: the session already persisted
  await savePrefsBestEffort((finalPrefs) => savePreferences(finalPrefs, config))(syncPreferenceUpdates(prefs, {
    modelId: finalState.modelId,
    lastModel: finalState.modelId,
    lastProvider: finalState.endpointProviderName,
    reasoningEffort: finalState.reasoningEffort,
    temperature: finalState.temperature,
    topP: finalState.topP,
    // Only persist webSearch when the session explicitly chose it; otherwise a
    // default/forced 'off' would overwrite a user's per-model pref on exit.
    ...(finalState.webSearchExplicit ? { webSearch: finalState.webSearch } : {}),
  }))
}
