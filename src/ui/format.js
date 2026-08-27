import { sanitizeAnsi, sanitizeSingleLine } from './hyperlink.js'

// Rounds to `decimals` places and returns a plain string (no locale/sign
// formatting): the money formatter for image prices and the image-generation
// cost line. Session/turn costs use `formatCost` (src/constants.js) instead —
// see the money-tier contract in MEMORY.md §Display consistency contract.
export function formatUsd(value, decimals) {
  const factor = 10 ** decimals
  return String(Math.round(value * factor) / factor)
}

function priceParts(prompt, completion) {
  const inPrice = prompt != null ? `$${(prompt * 1_000_000).toFixed(2)}` : '?'
  const outPrice = completion != null ? `$${(completion * 1_000_000).toFixed(2)}` : '?'
  return { inPrice, outPrice }
}

export function formatModelPrice(prompt, completion, { perM = false } = {}) {
  const { inPrice, outPrice } = priceParts(prompt, completion)
  if (inPrice === '?' && outPrice === '?') return '?'
  return `in ${inPrice} / out ${outPrice}${perM ? ' per 1M' : '/M'}`
}

export function formatPricePerM(pricing) {
  return formatModelPrice(pricing?.prompt, pricing?.completion, { perM: true })
}

export function imageUnitPrice(pricing, { resolution, quality } = {}) {
  const p = pricing || {}
  if (p.byQuality && resolution && p.byQuality[resolution]) {
    const tier = p.byQuality[resolution]
    if (quality != null && tier[quality] != null) return tier[quality]
    const values = Object.values(tier).filter((v) => typeof v === 'number')
    if (values.length > 0) return Math.min(...values)
  }
  if (p.byResolution && resolution && p.byResolution[resolution] != null) return p.byResolution[resolution]
  if (p.perImage != null) return p.perImage
  return null
}

function imagePriceFloor(pricing) {
  const p = pricing || {}
  const candidates = []
  if (p.byQuality) {
    for (const tier of Object.values(p.byQuality)) {
      if (tier && typeof tier === 'object') candidates.push(...Object.values(tier).filter((v) => typeof v === 'number'))
    }
  }
  if (p.byResolution) candidates.push(...Object.values(p.byResolution).filter((v) => typeof v === 'number'))
  if (p.perImage != null) candidates.push(p.perImage)
  if (candidates.length === 0) return null
  return Math.min(...candidates)
}

export function formatImagePrice(pricing, opts = {}) {
  const unit = imageUnitPrice(pricing, opts)
  if (unit != null) {
    return `$${formatUsd(unit, 3)} per image`
  }
  const floor = imagePriceFloor(pricing)
  if (floor != null) return `from $${formatUsd(floor, 3)} per image`
  const perToken = pricing?.perToken
  if (perToken != null) return `$${(perToken * 1_000_000).toFixed(2)} per 1M tokens`
  return '?'
}

export function sessionLabel(endpointProviderName, modelId) {
  const name = endpointProviderName ? `${endpointProviderName} / ${modelId}` : modelId
  return sanitizeAnsi(name)
}

// Compact count for the thinking meter: 999 -> "999", 1234 -> "1.2k",
// 999_999 -> "1M" (rounded scales, one decimal trimmed when exact).
export function formatCompactCount(value) {
  if (value < 1000) return String(value)
  if (value < 999_500) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// Elapsed time for the thinking meter: one decimal under 10s (0.8s, 5.7s),
// rounded seconds below a minute (42s), then minutes with padded seconds
// (1m05s, 2m).
export function formatElapsedSeconds(ms) {
  const total = ms / 1000
  if (total < 10) return `${(Math.round(total * 10) / 10).toFixed(1).replace(/\.0$/, '')}s`
  const seconds = Math.round(total)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, '0')}s`
}

export function formatSessionTime(value, { utc = false } = {}) {
  if (!value) return 'Unknown'
  let time = String(value).replace('T', ' ')
  time = time.replace(/^(\d{4}-\d{2}-\d{2} )(\d{2})-(\d{2})-(\d{2})/, '$1$2:$3:$4')
  // UTC rendering drops the trailing Z or numeric offset (with or without
  // fractional seconds) and appends a single explicit suffix.
  if (utc) time = `${time.replace(/(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, '')} UTC`
  return time
}

// Session ids store the UTC clock with dashes (2026-01-01T00-00-00); normalize
// ISO timestamps to the same shape so formatSessionTime renders both identically.
function pickerTimestamp(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().replace(/:/g, '-').replace(/\.\d+.*$/, '')
}

export function formatSessionItem(s) {
  // The leading timestamp is last activity (updatedAt), not creation: after a
  // resume an old session surfaces with its fresh date instead of its birth.
  const time = sanitizeSingleLine(formatSessionTime(pickerTimestamp(s.updatedAt || s.createdAt || s.id)))
  const model = sanitizeSingleLine(s.model)
  const modelText = model.length > 35 ? model.slice(0, 32) + '...' : model
  const count = `${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}`
  const preview = sanitizeSingleLine(s.title || s.preview || '')
  const previewText = preview ? `"${preview}${preview.length >= 60 ? '...' : ''}"` : ''
  const line = `${time}  ${modelText.padEnd(37)} ${count.padEnd(12)} ${previewText}`
  return { time, model: modelText, count, preview, line }
}
