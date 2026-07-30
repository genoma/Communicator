export async function listModelsCmd(provider, apiKey) {
  const models = await provider.fetchModels(apiKey)
  for (const m of models) {
    let pricingCol = ""
    if (m._rawPricing?.input?.usd != null) {
      const inp = Number(m._rawPricing.input.usd).toFixed(2)
      const out = Number(m._rawPricing.output.usd).toFixed(2)
      pricingCol = `  in $${inp} / out $${out}/M`
    }
    const privacyTag = m.privacy ? `  [${m.privacy}]` : ""
    console.log(
      `${m.name.padEnd(40)} ${m.id.padEnd(50)} ${m.contextLength?.toLocaleString() || "?"} ctx${pricingCol}${privacyTag}`
    )
  }
}
