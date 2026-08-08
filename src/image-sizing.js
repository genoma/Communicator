import { MAX_IMAGE_DIMENSION } from './constants.js'

// Pixel sizing for pixel-based Venice image models (no aspect-ratio list;
// width/height in multiples of the model's widthHeightDivisor). Live API
// facts: the cap is 1280 per side (the web UI's 1344x576 preset exceeds it
// and is not replicable), and the API divisor wins over the web UI's
// rounding (2:3 → 848x1272 on d8, 848x1264 on d16 — the web shows 1264).
// These models behave like aspect models with a hardcoded ratio list: the
// ratio is the knob, the pixel size is always derived from it.

export const SIZE_PRESET_RATIOS = ['1:1', '3:2', '16:9', '21:9', '9:16', '2:3', '3:4', '4:5']

export function isPixelModel(model) {
  return model?.constraints?.aspectRatios === null && model.constraints.widthHeightDivisor != null
}

export function computePixelSize(ratio, divisor) {
  const [w, h] = ratio.split(':').map(Number)
  const scale = MAX_IMAGE_DIMENSION / Math.max(w, h)
  const small = Math.floor((Math.min(w, h) * scale) / divisor) * divisor
  if (small === 0) {
    throw new Error(`aspect ratio ${ratio} is too extreme for this model (divisor ${divisor}).`)
  }
  const large = Math.floor(((small * Math.max(w, h)) / Math.min(w, h)) / divisor) * divisor
  return w >= h ? { width: large, height: small } : { width: small, height: large }
}

export function sizePresets(model) {
  const divisor = model?.constraints?.widthHeightDivisor
  if (divisor == null) return []
  return SIZE_PRESET_RATIOS.map((ratio) => {
    const { width, height } = computePixelSize(ratio, divisor)
    return { ratio, width, height }
  })
}

export function formatSize(width, height) {
  return `${width}x${height}`
}

export function sizeLabel(preset) {
  return `${preset.ratio} · ${formatSize(preset.width, preset.height)}`
}
