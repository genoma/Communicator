import { MAX_TEMPERATURE } from './constants.js'

export function resolveReasoningFlag({ reasoningEffort }) {
  if (reasoningEffort === 'none') return null
  return reasoningEffort
}

export function validateTemperature(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TEMPERATURE
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

export function resolveWebSearchFlag({ webSearch, webResults, prefValue } = {}) {
  if (webResults != null) return true
  if (webSearch === true) return true
  return prefValue ?? false
}

export function resolveBudget(value) {
  if (value === undefined || value === null || value === '') return null
  const budget = Number(value)
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error('--budget must be a positive number (USD).')
  }
  return budget
}
