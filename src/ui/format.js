import { sanitizeAnsi } from './hyperlink.js'

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
    return `$${String(Math.round(unit * 1000) / 1000)} per image`
  }
  const floor = imagePriceFloor(pricing)
  if (floor != null) return `from $${String(Math.round(floor * 1000) / 1000)} per image`
  const perToken = pricing?.perToken
  if (perToken != null) return `$${(perToken * 1_000_000).toFixed(2)} per 1M tokens`
  return '?'
}

export function sessionLabel(endpointProviderName, modelId) {
  const name = endpointProviderName ? `${endpointProviderName} / ${modelId}` : modelId
  return sanitizeAnsi(name)
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

export function formatSessionItem(s) {
  const time = formatSessionTime(s.id)
  const model = s.model.length > 35 ? s.model.slice(0, 32) + '...' : s.model
  const count = `${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}`
  const preview = s.title || s.preview || ''
  const previewText = preview ? `"${preview}${preview.length >= 60 ? '...' : ''}"` : ''
  const line = `${time}  ${model.padEnd(37)} ${count.padEnd(12)} ${previewText}`
  return { time, model, count, preview, line }
}
