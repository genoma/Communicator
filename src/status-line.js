import { getEffortLabel } from './prompts.js'
import { formatCost, formatSmoothSpeed, formatSamplingValue } from './constants.js'
import { formatModelPrice, sessionLabel } from './ui/format.js'
import { dim } from './ui/style.js'
import { sanitizeAnsi } from './ui/hyperlink.js'
import { getImageDefaults } from './config.js'
import { isPixelModel } from './image-sizing.js'

// Badge keys and brackets are dimmed so values read as the headline; the
// model label and the values themselves stay plain. styleText emits nothing
// on non-TTY output, so pipes and tests see the exact plain string.
const kv = (key, value) => `${dim(`[${key}: `)}${value}${dim(']')}`
const tag = (text) => `${dim('[')}${text}${dim(']')}`

// Greedy wrap of a status line at the terminal width: segments are atomic (a
// badge never splits mid-way) and continuation lines align under the first
// segment. With no usable width (pipes, unknown columns) the line stays
// unwrapped, so non-TTY output is byte-identical to the pre-wrap layout.
export function wrapStatusLine(prefix, segments, width = process.stdout.columns ?? 0) {
  if (!(width > 0)) return `${prefix} ${segments.join('  ')}`
  const indent = ' '.repeat(sanitizeAnsi(prefix).length + 1)
  const rows = []
  let row = prefix
  for (const segment of segments) {
    const sep = row === prefix ? ' ' : '  '
    const next = `${row}${sep}${segment}`
    if (row === prefix || sanitizeAnsi(next).length <= width) {
      row = next
    } else {
      rows.push(row)
      row = `${indent}${segment}`
    }
  }
  rows.push(row)
  return rows.join('\n')
}

export function buildStatusBadges(state) {
  const parts = []
  if (state.reasoningEffort != null) parts.push(kv('thinking', getEffortLabel(state.reasoningEffort)))
  parts.push(kv('temp', formatSamplingValue(state.temperature)))
  parts.push(kv('top-p', formatSamplingValue(state.topP)))
  if (state.zdr) parts.push(tag('zdr'))
  if (state.e2ee) parts.push(tag('e2ee'))
  if (state.webSearch !== 'off') {
    const results = state.webResults != null ? `: ${state.webResults}` : ''
    parts.push(kv('web', `${state.webSearch}${results}`))
  }
  if (state.compactThinking) parts.push(tag('compact-thinking'))
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
  if (providerName === 'venice' && prefs?.hideWatermark === true) badges.push(kv('watermark', 'off'))
  if (Array.isArray(c?.aspectRatios) || isPixelModel(model)) {
    const value = current('aspectRatio', 'aspectRatio')
    if (value) badges.push(kv('aspect', value))
  }
  if (Array.isArray(c?.resolutions)) {
    const value = current('resolution', 'resolution')
    if (value) badges.push(kv('resolution', value))
  }
  if (Array.isArray(c?.qualities)) {
    const value = current('quality', 'quality')
    if (value) badges.push(kv('quality', value))
  }
  if (Array.isArray(c?.formats)) {
    const value = current('imageFormat', 'format')
    if (value) badges.push(kv('format', value))
  }
  if (c?.maxN == null || c?.maxN > 1) {
    const value = current('variants', 'variants')
    if (value != null) badges.push(kv('variants', value))
  }
  if (sessionValues.seed !== undefined) badges.push(kv('seed', sessionValues.seed))
  return [sessionLabel(endpointProviderName, imageModelId), tag('image'), ...badges]
}

// The one session greeting shared by chat, one-shot (TTY) and the image
// session: leading blank line, `Connected to <segments joined '  '>`,
// optional hint lines joined with "  |  ". Callers pass it to console.log
// (the trailing newline is not included).
export function connectedBanner(segments, { hints = [], width } = {}) {
  const hintText = hints.length > 0 ? `${hints.join('  |  ')}\n` : ''
  return `\n${wrapStatusLine(dim('Connected to'), segments, width)}\n${hintText}`
}
