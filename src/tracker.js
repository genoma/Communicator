import { formatCost } from './constants.js'
import { sep, green, cyan, yellow, red } from './ui/style.js'

const BAR_WIDTH = 10

export function computeTurnCost(usage, pricing) {
  if (!usage || pricing?.prompt == null || pricing?.completion == null) return 0
  const promptPrice = parseFloat(pricing.prompt)
  const completionPrice = parseFloat(pricing.completion)
  if (Number.isNaN(promptPrice) || Number.isNaN(completionPrice)) return 0
  const pt = usage.prompt_tokens ?? 0
  const ct = usage.completion_tokens ?? 0
  return pt * promptPrice + ct * completionPrice
}

export function budgetStatus(cost, budget) {
  if (budget == null || !(budget > 0)) return null
  const pct = Math.min(100, (cost / budget) * 100)
  return { pct, remaining: Math.max(0, budget - cost) }
}

export function budgetExhaustedMessage(cost, budget) {
  return `Budget exhausted (${formatCost(cost)} of ${formatCost(budget)}).`
}

export function budgetStatusLine(cost, budget) {
  const status = budgetStatus(cost, budget)
  if (!status) return null
  return `Budget: ${formatCost(cost)} of ${formatCost(budget)} used (${status.pct.toFixed(0)}%). ${formatCost(status.remaining)} remaining.`
}

function formatCompactCost(cost) {
  return `$${cost.toFixed(4)}`
}

function renderBar(pct) {
  const filled = Math.round((pct / 100) * BAR_WIDTH)
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

export function budgetLine(cost, budget) {
  const status = budgetStatus(cost, budget)
  if (!status || status.pct < 80) return null
  const pct = status.pct.toFixed(0)
  const style = status.pct >= 95 ? red : yellow
  return style(
    `  Budget  ${renderBar(status.pct)} ${pct}% used (${formatCompactCost(cost)} of ${formatCompactCost(budget)}), ${formatCompactCost(status.remaining)} remaining`
  )
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
    const label = (text) => `  ${text.padEnd(6)} `

    console.log(
      `${label('Tokens')}${arrowUp} ${pt.toLocaleString()} prompt  ${arrowDown} ${ct.toLocaleString()} completion  ${eq} ${tt.toLocaleString()} total`
    )

    if (hit) {
      const parts = []
      if (cached > 0) {
        const pct = pt > 0 ? Math.round((cached / pt) * 100) : null
        const ratio = pct != null ? ` (${pct}% of prompt)` : ''
        parts.push(`${cached.toLocaleString()} cached tokens${ratio}`)
      }
      if (usage.cacheHit) parts.push('response cache hit')
      console.log(green(`${label('Cache')}⚡ ${parts.join(', ')}`))
    }

    if (pricing) {
      const turnPart = formatCost(turnCost)
      const sessionPart = formatCost(this.cost)
      console.log(cyan(`${label('Cost')}${turnPart} this turn  |  ${sessionPart} session`))
    }
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
