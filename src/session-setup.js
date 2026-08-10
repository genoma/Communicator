import { resolveFlagValues, resolveWebSearchFlag, webSearchGate, resolvePrefOrNull, resolveBudget, resolveWebResultsFlag, normalizeSmoothSpeed } from './flags.js'
import { CliError } from './errors.js'
import { selectModelAndEndpoint, selectModelNonInteractive } from './model-selection.js'
import { DEFAULT_TEMPERATURE } from './constants.js'
import { persistSessionFile, buildSessionPayload } from './sessions.js'
import { savePreferences, applyPreferenceUpdates } from './config.js'

export function resolveSessionFlags(opts, prefs) {
  try {
    const { reasoningEffort: forcedEffort, temperature: forcedTemperature, budget: forcedBudget, webResults: forcedWebResults, smoothSpeed } = resolveFlagValues(opts)
    return {
      forcedEffort,
      forcedTemperature,
      forcedBudget,
      budget: forcedBudget ?? resolvePrefOrNull(resolveBudget, prefs.budget) ?? null,
      forcedWebResults,
      smoothSpeed: smoothSpeed ?? normalizeSmoothSpeed(prefs.smoothSpeed),
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

export async function buildSessionContext({ provider, apiKey, opts, prefs, forcedEffort, forcedTemperature, forcedWebResults, zdr, e2ee = false, allowInteractive = true }) {
  let selection
  if (opts.model) {
    selection = await selectModelNonInteractive({ provider, apiKey, prefs, modelId: opts.model, forcedEffort, zdr, e2ee })
  } else if (allowInteractive) {
    selection = await selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort: forcedEffort, zdr, e2ee })
  } else {
    throw new CliError('Error: interactive model selection needs a TTY. Use -m <model-id> when piping input.')
  }

  const webSearch = e2ee ? 'off' : resolveWebSearchFlag({ webSearch: opts.webSearch, webResults: forcedWebResults, prefValue: prefs.webSearch?.[selection.modelId] })
  const gateError = webSearchGate(webSearch, selection.webSearchSupported)
  if (gateError) throw new CliError(`Error: ${gateError}`)

  return {
    selection,
    temperature: forcedTemperature ?? prefs.temperature?.[selection.modelId] ?? DEFAULT_TEMPERATURE,
    webSearch,
    webResults: e2ee ? null : forcedWebResults ?? resolvePrefOrNull((v) => resolveWebResultsFlag({ webResults: v }), prefs.webResults) ?? null,
  }
}

export async function persistSession({ finalState, prefs, config }) {
  if (finalState.sessionId && finalState.messages && finalState.messages.length > 1) {
    await persistSessionFile(finalState.sessionId, buildSessionPayload(finalState))
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
