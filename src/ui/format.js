function priceParts(prompt, completion) {
  const inPrice = prompt != null ? `$${(prompt * 1_000_000).toFixed(2)}` : '?'
  const outPrice = completion != null ? `$${(completion * 1_000_000).toFixed(2)}` : '?'
  return { inPrice, outPrice }
}

export function formatModelPrice(prompt, completion) {
  const { inPrice, outPrice } = priceParts(prompt, completion)
  if (inPrice === '?' && outPrice === '?') return '?'
  return `in ${inPrice} / out ${outPrice}/M`
}

export function formatPricePerM(pricing) {
  const { inPrice, outPrice } = priceParts(pricing?.prompt, pricing?.completion)
  if (inPrice === '?' && outPrice === '?') return '?'
  return `in ${inPrice} / out ${outPrice} per 1M`
}
