import { getEffortLabel } from './prompts.js'
import { DEFAULT_TEMPERATURE, formatCost, formatSmoothSpeed } from './constants.js'
import { formatModelPrice, sessionLabel } from './ui/format.js'
import { dim } from './ui/style.js'
import { getImageDefaults } from './config.js'
import { isPixelModel } from './image-sizing.js'

// Badge keys and brackets are dimmed so values read as the headline; the
// model label and the values themselves stay plain. styleText emits nothing
// on non-TTY output, so pipes and tests see the exact plain string.
const kv = (key, value) => `${dim(`[${key}: `)}${value}${dim(']')}`
const tag = (text) => `${dim('[')}${text}${dim(']')}`

export function buildStatusBadges(state) {
  const parts = []
  if (state.reasoningEffort != null) parts.push(kv('thinking', getEffortLabel(state.reasoningEffort)))
  if (state.temperature !== DEFAULT_TEMPERATURE) parts.push(kv('temp', state.temperature))
  parts.push(kv('top-p', state.topP))
  if (state.zdr) parts.push(tag('zdr'))
  if (state.e2ee) parts.push(tag('e2ee'))
  if (state.webSearch !== 'off') {
    const results = state.webResults != null ? `: ${state.webResults}` : ''
    parts.push(kv('web', `${state.webSearch}${results}`))
  }
  return parts
}

// The complete session snapshot: model identity, context window, pricing and
// every badge (budget and smooth included). The session banner and /status
// print exactly these segments, so entering a model and checking status can
// never drift apart.
export function buildStatusLine(state) {
  const parts = [sessionLabel(state.endpointProviderName, state.modelId)]
  if (state.contextLength) parts.push(tag(`${state.contextLength.toLocaleString()} context`))
  const pricing = state.pricing
  if (pricing?.prompt != null || pricing?.completion != null) {
    parts.push(tag(formatModelPrice(pricing.prompt, pricing.completion)))
  }
  parts.push(...buildStatusBadges(state))
  if (state.budget != null) parts.push(kv('budget', formatCost(state.budget)))
  parts.push(kv('smooth', state.smoothStreaming ? `on (${formatSmoothSpeed(state.smoothSpeed)})` : 'off'))
  return parts
}

// The image-session parity snapshot: model label + [image] marker + one
// badge per sizing setting the model supports, showing the effective value
// (session value wins over the saved provider default). The image banner
// and /status print exactly these segments. Badges only appear for values
// that are actually set; the Venice watermark badge only when hidden.
export function buildImageStatusLine({ model, imageModelId, endpointProviderName, sessionValues = {}, prefs, providerName }) {
  const c = model?.constraints
  const saved = getImageDefaults(prefs, providerName)
  const badges = []
  const current = (sessionKey, defaultKey) => sessionValues[sessionKey] ?? saved[defaultKey]
  if (providerName === 'venice' && prefs?.hideWatermark === true) badges.push('[watermark: off]')
  if (Array.isArray(c?.aspectRatios) || isPixelModel(model)) {
    const value = current('aspectRatio', 'aspectRatio')
    if (value) badges.push(`[aspect: ${value}]`)
  }
  if (Array.isArray(c?.resolutions)) {
    const value = current('resolution', 'resolution')
    if (value) badges.push(`[resolution: ${value}]`)
  }
  if (Array.isArray(c?.qualities)) {
    const value = current('quality', 'quality')
    if (value) badges.push(`[quality: ${value}]`)
  }
  if (Array.isArray(c?.formats)) {
    const value = current('imageFormat', 'format')
    if (value) badges.push(`[format: ${value}]`)
  }
  if (c?.maxN == null || c?.maxN > 1) {
    const value = current('variants', 'variants')
    if (value != null) badges.push(`[variants: ${value}]`)
  }
  if (sessionValues.seed !== undefined) badges.push(`[seed: ${sessionValues.seed}]`)
  return [sessionLabel(endpointProviderName, imageModelId), '[image]', ...badges]
}

// The one session greeting shared by chat, one-shot (TTY) and the image
// session: leading blank line, `Connected to <segments joined '  '>`,
// optional hint lines joined with "  |  ". Callers pass it to console.log
// (the trailing newline is not included).
export function connectedBanner(segments, { hints = [] } = {}) {
  const hintText = hints.length > 0 ? `${hints.join('  |  ')}\n` : ''
  return `\n${dim('Connected to')} ${segments.join('  ')}\n${hintText}`
}
