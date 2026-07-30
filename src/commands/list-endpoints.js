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
    const inPrice = ep.pricing?.prompt != null
      ? `$${(parseFloat(ep.pricing.prompt) * 1_000_000).toFixed(2)}`
      : "?"
    const outPrice = ep.pricing?.completion != null
      ? `$${(parseFloat(ep.pricing.completion) * 1_000_000).toFixed(2)}`
      : "?"
    const priceText = inPrice !== "?" || outPrice !== "?"
      ? `in ${inPrice} / out ${outPrice}/M`
      : "?"
    const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}%` : "?"
    console.log(
      `${ep.providerName.padEnd(20)} | ${priceText.padEnd(26)} | uptime ${uptime} | tag ${ep.tag}`
    )
  }
}
