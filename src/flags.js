import { MAX_TEMPERATURE, MAX_WEB_SEARCH_RESULTS, SMOOTH_DEFAULT_SPEED, SMOOTH_SPEED_PRESETS, EFFORT_LABELS } from './constants.js'

export const WEB_SEARCH_MODES = new Set(['auto', 'always', 'on', 'off'])

export function resolveReasoningFlag({ reasoningEffort }) {
  if (reasoningEffort === undefined || reasoningEffort === null || reasoningEffort === '') return undefined
  if (reasoningEffort === 'none') return null
  if (!(reasoningEffort in EFFORT_LABELS)) {
    throw new Error(`--reasoning-effort must be one of: ${Object.keys(EFFORT_LABELS).join(', ')}.`)
  }
  return reasoningEffort
}

export function resolveFlagValues(opts) {
  return {
    reasoningEffort: opts.reasoningEffort !== undefined ? resolveReasoningFlag({ reasoningEffort: opts.reasoningEffort }) : undefined,
    temperature: opts.temperature !== undefined ? resolveTemperatureFlag({ temperature: opts.temperature }) : undefined,
    budget: opts.budget !== undefined ? resolveBudget(opts.budget) : undefined,
    webResults: opts.webResults !== undefined ? resolveWebResultsFlag({ webResults: opts.webResults }) : undefined,
    smoothSpeed: opts.smoothSpeed !== undefined ? resolveSmoothSpeed(opts.smoothSpeed) : undefined,
  }
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
  if (num > MAX_WEB_SEARCH_RESULTS) {
    throw new Error(`--web-results must be at most ${MAX_WEB_SEARCH_RESULTS}.`)
  }
  return num
}

export function normalizeWebSearchMode(value) {
  if (value === true || value === 'on') return 'auto'
  if (WEB_SEARCH_MODES.has(value)) return value
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
    throw new Error('Budget must be a positive number (USD).')
  }
  return budget
}

export function resolvePrefOrNull(resolve, value) {
  try {
    return resolve(value)
  } catch {
    return null
  }
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

const IMAGE_FORMATS = new Set(['png', 'jpeg', 'webp'])
const IMAGE_RESOLUTIONS = new Set(['1K', '2K', '4K'])
const IMAGE_QUALITIES = new Set(['low', 'medium', 'high'])
export const MAX_IMAGE_DIMENSION = 1280
const MAX_SEED = 999999999

export function resolveImageFormat(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (!IMAGE_FORMATS.has(value)) {
    throw new Error('--image-format must be one of: png, jpeg, webp.')
  }
  return value
}

export function resolveVariants(value) {
  if (value === undefined || value === null || value === '') return undefined
  const num = Number(value)
  if (!Number.isInteger(num) || num < 1 || num > 4) {
    throw new Error('--variants must be an integer between 1 and 4.')
  }
  return num
}

export function resolveAspectRatio(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (!/^(auto|\d+(\.\d+)?:\d+(\.\d+)?)$/.test(value)) {
    throw new Error('--aspect-ratio must be in the form W:H (e.g. 16:9) or "auto".')
  }
  return value
}

export function resolveResolution(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (!IMAGE_RESOLUTIONS.has(value)) {
    throw new Error('--resolution must be one of: 1K, 2K, 4K.')
  }
  return value
}

export function resolveQuality(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (!IMAGE_QUALITIES.has(value)) {
    throw new Error('--quality must be one of: low, medium, high.')
  }
  return value
}

export function resolveSeed(value) {
  if (value === undefined || value === null || value === '') return undefined
  const num = Number(value)
  if (!Number.isInteger(num) || num < -MAX_SEED || num > MAX_SEED) {
    throw new Error(`--seed must be an integer between -${MAX_SEED} and ${MAX_SEED}.`)
  }
  return num
}

function resolveImageDimension(name, value) {
  if (value === undefined || value === null || value === '') return undefined
  const num = Number(value)
  if (!Number.isInteger(num) || num < 1 || num > MAX_IMAGE_DIMENSION) {
    throw new Error(`--${name} must be an integer between 1 and ${MAX_IMAGE_DIMENSION}.`)
  }
  return num
}

export function resolveWidth(value) {
  return resolveImageDimension('width', value)
}

export function resolveHeight(value) {
  return resolveImageDimension('height', value)
}
