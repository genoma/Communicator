import { MAX_TEMPERATURE, SMOOTH_DEFAULT_SPEED, SMOOTH_SPEED_PRESETS } from './constants.js'

export function resolveReasoningFlag({ reasoningEffort }) {
  if (reasoningEffort === 'none') return null
  return reasoningEffort
}

export function resolveTemperatureFlag({ temperature } = {}) {
  if (temperature === undefined || temperature === null || temperature === '') return undefined
  const num = Number(temperature)
  if (!Number.isFinite(num) || num < 0 || num > MAX_TEMPERATURE) {
    throw new Error(`Temperature must be a number between 0 and ${MAX_TEMPERATURE}.`)
  }
  return num
}

export function resolveWebResultsFlag({ webResults } = {}) {
  if (webResults === undefined || webResults === null || webResults === '') return undefined
  const num = Number(webResults)
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error('--web-results must be a positive integer.')
  }
  return num
}

export function normalizeWebSearchMode(value) {
  if (value === true || value === 'on') return 'auto'
  if (value === 'auto' || value === 'always' || value === 'off') return value
  return 'off'
}

export function resolveWebSearchFlag({ webSearch, webResults, prefValue } = {}) {
  if (webSearch !== undefined && webSearch !== null && webSearch !== '') return normalizeWebSearchMode(webSearch)
  if (webResults != null) return 'auto'
  return normalizeWebSearchMode(prefValue)
}

export function webSearchGate(webSearch, webSearchSupported) {
  if (webSearch !== 'off' && webSearchSupported === false) {
    return 'The selected model does not support web search.'
  }
  return null
}

export function resolveBudget(value) {
  if (value === undefined || value === null || value === '') return null
  const budget = Number(value)
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error('--budget must be a positive number (USD).')
  }
  return budget
}

export function resolveSmoothSpeed(value) {
  if (value === undefined || value === null || value === '') return undefined
  const preset = SMOOTH_SPEED_PRESETS[value]
  if (preset !== undefined) return preset
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('Smooth speed must be "slow", "normal", "fast", or a positive number of chars per second.')
  }
  return num
}

export function normalizeSmoothSpeed(value) {
  try {
    return resolveSmoothSpeed(value) ?? SMOOTH_SPEED_PRESETS[SMOOTH_DEFAULT_SPEED]
  } catch {
    return SMOOTH_SPEED_PRESETS[SMOOTH_DEFAULT_SPEED]
  }
}
