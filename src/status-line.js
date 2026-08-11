import { getEffortLabel } from './prompts.js'
import { DEFAULT_TEMPERATURE, formatCost, formatSmoothSpeed } from './constants.js'

export function buildStatusBadges(state) {
  const parts = []
  if (state.reasoningEffort != null) parts.push(`[thinking: ${getEffortLabel(state.reasoningEffort)}]`)
  if (state.temperature !== DEFAULT_TEMPERATURE) parts.push(`[temp: ${state.temperature}]`)
  if (state.zdr) parts.push('[zdr]')
  if (state.e2ee) parts.push('[e2ee]')
  if (state.webSearch !== 'off') {
    const results = state.webResults != null ? `: ${state.webResults}` : ''
    parts.push(`[web: ${state.webSearch}${results}]`)
  }
  return parts
}

export function buildStatusLine(state) {
  const parts = buildStatusBadges(state)
  if (state.budget != null) parts.push(`[budget: ${formatCost(state.budget)}]`)
  parts.push(state.smoothStreaming ? `[smooth: on (${formatSmoothSpeed(state.smoothSpeed)})]` : '[smooth: off]')
  return parts
}
