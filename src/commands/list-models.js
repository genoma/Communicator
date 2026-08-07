import { formatModelPrice, formatImagePrice } from '../ui/format.js'
import { sanitizeAnsi } from '../ui/hyperlink.js'

export async function listModelsCmd(provider, apiKey) {
  const models = await provider.fetchModels(apiKey)
  for (const m of models) {
    const pricingCol = m.pricing?.prompt != null || m.pricing?.completion != null
      ? `  ${formatModelPrice(m.pricing?.prompt, m.pricing?.completion)}`
      : ''
    const visionTag = m.visionSupported === true ? '  [vision]' : ''
    const privacyTag = m.capabilities?.privacy ? `  [${m.capabilities.privacy}]` : ''
    const zdrTag = m.zdr ? '  [zdr]' : ''
    console.log(
      `${sanitizeAnsi(m.name).padEnd(40)} ${sanitizeAnsi(m.id).padEnd(50)} ${m.contextLength?.toLocaleString() || '?'} ctx${pricingCol}${visionTag}${privacyTag}${zdrTag}`
    )
  }
}

export async function listImageModelsCmd(provider, apiKey) {
  const models = await provider.fetchImageModels(apiKey, { withPricing: true })
  for (const m of models) {
    const priceCol = `  ${formatImagePrice(m.pricing)}`
    const aspectTag = m.constraints?.aspectRatios?.length ? `  [aspect: ${m.constraints.aspectRatios.join(', ')}]` : ''
    const resTag = m.constraints?.resolutions?.length ? `  [resolution: ${m.constraints.resolutions.join(', ')}]` : ''
    const qualityTag = m.constraints?.qualities?.length ? `  [quality: ${m.constraints.qualities.join(', ')}]` : ''
    const privacyTag = m.privacy ? `  [${m.privacy}]` : ''
    const offlineTag = m.offline ? '  [offline]' : ''
    console.log(`${sanitizeAnsi(m.name).padEnd(40)} ${sanitizeAnsi(m.id).padEnd(50)}${priceCol}${aspectTag}${resTag}${qualityTag}${privacyTag}${offlineTag}`)
  }
}
