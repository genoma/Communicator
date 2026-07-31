import { formatCost } from './constants.js'
import { sep } from './ui/style.js'

export function computeTurnCost(usage, pricing) {
  if (!usage || pricing?.prompt == null || pricing?.completion == null) return 0
  const promptPrice = parseFloat(pricing.prompt)
  const completionPrice = parseFloat(pricing.completion)
  if (Number.isNaN(promptPrice) || Number.isNaN(completionPrice)) return 0
  const pt = usage.prompt_tokens ?? 0
  const ct = usage.completion_tokens ?? 0
  return pt * promptPrice + ct * completionPrice
}

function computeMetrics(usage, pricing) {
  const pt = usage.prompt_tokens ?? 0
  const ct = usage.completion_tokens ?? 0
  const tt = usage.total_tokens ?? pt + ct
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  const hit = cached > 0 || usage.cacheHit
  const turnCost = computeTurnCost(usage, pricing)
  return { pt, ct, tt, cached, hit, turnCost }
}

export class UsageTracker {
  constructor() {
    this.promptTokens = 0
    this.completionTokens = 0
    this.totalTokens = 0
    this.cost = 0
    this.requests = 0
    this.cacheHits = 0
    this.cachedTokens = 0
  }

  record(usage, pricing) {
    if (!usage) return

    const { pt, ct, tt, cached, hit, turnCost } = computeMetrics(usage, pricing)

    this.promptTokens += pt
    this.completionTokens += ct
    this.totalTokens += tt
    this.requests += 1
    if (hit) this.cacheHits += 1
    this.cachedTokens += cached
    this.cost += turnCost
  }

  printTurn(usage, pricing) {
    if (!usage) return

    const { pt, ct, tt, cached, hit, turnCost } = computeMetrics(usage, pricing)

    console.log(sep())

    const arrowUp = '\u2191'
    const arrowDown = '\u2193'
    const eq = '\u003d'

    console.log(
      `  Tokens  ${arrowUp} ${pt.toLocaleString()} prompt  ${arrowDown} ${ct.toLocaleString()} completion  ${eq} ${tt.toLocaleString()} total`
    )

    if (hit) {
      const parts = []
      if (cached > 0) parts.push(`${cached.toLocaleString()} cached tokens`)
      if (usage.cacheHit) parts.push('response cache hit')
      console.log(`  Cache   ${parts.join(', ')}`)
    }

    if (pricing) {
      const turnPart = formatCost(turnCost)
      const sessionPart = formatCost(this.cost)
      console.log(`  Cost    ${turnPart} this turn  |  ${sessionPart} session`)
    }

    console.log(sep())
  }

  summary() {
    const arrowUp = '\u2191'
    const arrowDown = '\u2193'
    const eq = '\u003d'

    let s = `${arrowUp} ${this.promptTokens.toLocaleString()} prompt  ${arrowDown} ${this.completionTokens.toLocaleString()} completion  ${eq} ${this.totalTokens.toLocaleString()} total  |  ${this.requests} request(s)`
    if (this.cacheHits > 0) {
      s += `  |  ${this.cacheHits} cache hit(s) [${this.cachedTokens.toLocaleString()} cached tokens]`
    }
    if (this.cost > 0) {
      s += `  |  ${formatCost(this.cost)} cost`
    }
    return s
  }
}
