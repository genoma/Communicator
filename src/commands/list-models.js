import { formatModelPrice } from '../ui/format.js'

export async function listModelsCmd(provider, apiKey) {
  const models = await provider.fetchModels(apiKey)
  for (const m of models) {
    const pricingCol = m.pricing?.prompt != null || m.pricing?.completion != null
      ? `  ${formatModelPrice(m.pricing?.prompt, m.pricing?.completion)}`
      : ''
    const privacyTag = m.capabilities?.privacy ? `  [${m.capabilities.privacy}]` : ''
    const zdrTag = m.zdr ? '  [zdr]' : ''
    console.log(
      `${m.name.padEnd(40)} ${m.id.padEnd(50)} ${m.contextLength?.toLocaleString() || '?'} ctx${pricingCol}${privacyTag}${zdrTag}`
    )
  }
}
