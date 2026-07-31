import { formatModelPrice } from "../ui/format.js"

export async function listEndpointsCmd(provider, apiKey, modelId) {
  const endpoints = await provider.fetchEndpoints(apiKey, modelId)
  if (!endpoints.length) {
    if (!provider.meta.hasEndpoints) {
      console.log(`${modelId} is directly available on Venice (no multi-provider routing)`)
    } else {
      console.log(`No endpoints found for ${modelId}`)
    }
    return
  }
  console.log(`${endpoints.length} provider(s) for ${modelId}:\n`)
  for (const ep of endpoints) {
    const priceText = formatModelPrice(ep.pricing?.prompt, ep.pricing?.completion)
    const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}%` : "?"
    console.log(
      `${ep.providerName.padEnd(20)} | ${priceText.padEnd(26)} | uptime ${uptime} | tag ${ep.tag}`
    )
  }
}
