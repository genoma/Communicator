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

export function sessionLabel(endpointProviderName, modelId) {
  return endpointProviderName ? `${endpointProviderName} / ${modelId}` : modelId
}
