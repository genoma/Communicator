import { getEffortLabel } from './prompts.js'
import { DEFAULT_TEMPERATURE, formatCost, formatSmoothSpeed } from './constants.js'
import { formatModelPrice, sessionLabel } from './ui/format.js'

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

// The complete session snapshot: model identity, context window, pricing and
// every badge (budget and smooth included). The session banner and /status
// print exactly these segments, so entering a model and checking status can
// never drift apart.
export function buildStatusLine(state) {
  const parts = [sessionLabel(state.endpointProviderName, state.modelId)]
  if (state.contextLength) parts.push(`[${state.contextLength.toLocaleString()} context]`)
  const pricing = state.pricing
  if (pricing?.prompt != null || pricing?.completion != null) {
    parts.push(`[${formatModelPrice(pricing.prompt, pricing.completion)}]`)
  }
  parts.push(...buildStatusBadges(state))
  if (state.budget != null) parts.push(`[budget: ${formatCost(state.budget)}]`)
  parts.push(state.smoothStreaming ? `[smooth: on (${formatSmoothSpeed(state.smoothSpeed)})]` : '[smooth: off]')
  return parts
}

// The one session greeting shared by chat, one-shot (TTY) and the image
// session: leading blank line, `Connected to <segments joined '  '>`,
// optional hint lines joined with "  |  ". Callers pass it to console.log
// (the trailing newline is not included).
export function connectedBanner(segments, { hints = [] } = {}) {
  const hintText = hints.length > 0 ? `${hints.join('  |  ')}\n` : ''
  return `\nConnected to ${segments.join('  ')}\n${hintText}`
}
