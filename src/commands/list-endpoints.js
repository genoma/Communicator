import { fetchEndpoints } from "../openrouter.js"

export async function listEndpointsCmd(apiKey, modelId) {
  const endpoints = await fetchEndpoints(apiKey, modelId)
  if (!endpoints.length) {
    console.log(`No endpoints found for ${modelId}`)
    return
  }
  console.log(`${endpoints.length} provider(s) for ${modelId}:\n`)
  for (const ep of endpoints) {
    const promptPrice = ep.pricing?.prompt
      ? `$${(parseFloat(ep.pricing.prompt) * 1_000_000).toFixed(2)}/M`
      : "?"
    const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}%` : "?"
    console.log(
      `${ep.providerName.padEnd(20)} | prompt ${promptPrice.padEnd(12)} | uptime ${uptime} | tag ${ep.tag}`
    )
  }
}
