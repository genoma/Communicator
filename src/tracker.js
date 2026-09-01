import { formatCost, SCRAPE_COST_USD } from './constants.js'
import { sep, green, cyan, yellow, red } from './ui/style.js'

const BAR_WIDTH = 10
const CTX_MIN_PCT = 5

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

function contextStyle(pct) {
  return pct >= 95 ? red : pct >= 80 ? yellow : (t) => t
}

export function contextSegment(peakTokens, contextLength, hit = false) {
  if (!contextLength || contextLength <= 0) return 'CTX: ?'
  if (hit && peakTokens === 0) return 'CTX: ?'
  const pct = Math.min(100, (peakTokens / contextLength) * 100)
  if (pct < CTX_MIN_PCT) return null
  return contextStyle(pct)(`CTX ${renderBar(pct)} ${pct.toFixed(0)}%`)
}

function contextLine(peakTokens, contextLength) {
  if (!contextLength || contextLength <= 0) return null
  const pct = Math.min(100, (peakTokens / contextLength) * 100)
  if (pct < CTX_MIN_PCT) return null
  return contextStyle(pct)(`${'CTX'.padEnd(6)} ${renderBar(pct)} ${pct.toFixed(0)}%`)
}

export function budgetLine(cost, budget) {
  const status = budgetStatus(cost, budget)
  if (!status || status.pct < 80) return null
  const pct = status.pct.toFixed(0)
  const style = status.pct >= 95 ? red : yellow
  return style(
    `Budget  ${renderBar(status.pct)} ${pct}% used (${formatCompactCost(cost)} of ${formatCompactCost(budget)}), ${formatCompactCost(status.remaining)} remaining`
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
    // Flat-fee operations (Venice web scraping) count toward cost and the
    // session scrape counter but never touch token/request metrics.
    this.scrapes = 0
    // Peak context occupancy (prompt + completion) across the session. Web
    // search tool results transiently inflate a single turn's prompt tokens,
    // so the per-turn value can shrink; the peak never does.
    this.peakContext = 0
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
    this.peakContext = Math.max(this.peakContext, pt + ct)
  }

  // Copies every metric field from another tracker: the single place the
  // field list lives, so a recompute (resyncTracker for /edit and /delete)
  // can never drift from the constructor.
  copyMetricsFrom(other) {
    this.promptTokens = other.promptTokens
    this.completionTokens = other.completionTokens
    this.totalTokens = other.totalTokens
    this.cost = other.cost
    this.requests = other.requests
    this.cacheHits = other.cacheHits
    this.cachedTokens = other.cachedTokens
    this.scrapes = other.scrapes
    this.peakContext = other.peakContext
  }

  addScrapeCost(amount, count = 1) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return
    this.scrapes += count
    this.cost += amount
  }

  printTurn(usage, pricing, contextLength, budgetNote = null) {
    if (!usage) return

    const { pt, ct, tt, cached, hit, turnCost } = computeMetrics(usage, pricing)

    this.peakContext = Math.max(this.peakContext, pt + ct)

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

    const ctx = contextLine(this.peakContext, contextLength)
    if (ctx || budgetNote) {
      console.log(`  ${[ctx, budgetNote].filter(Boolean).join('  |  ')}`)
    }
  }

  summary() {
    const arrowUp = '\u2191'
    const arrowDown = '\u2193'
    const eq = '\u003d'

    let s = `${arrowUp} ${this.promptTokens.toLocaleString()} prompt  ${arrowDown} ${this.completionTokens.toLocaleString()} completion  ${eq} ${this.totalTokens.toLocaleString()} total  |  ${this.requests} request(s)`
    if (this.scrapes > 0) {
      s += `  |  ${this.scrapes} scrape${this.scrapes > 1 ? 's' : ''}`
    }
    if (this.cacheHits > 0) {
      s += `  |  ${this.cacheHits} cache hit(s) [${this.cachedTokens.toLocaleString()} cached tokens]`
    }
    if (this.cost > 0) {
      s += `  |  ${formatCost(this.cost)} cost`
    }
    return s
  }
}

// Seed a tracker from a message history exactly like a resumed session: every
// surviving assistant message's usage is replayed, then the flat-fee scrape
// cost is added from the surviving scrape count. Shared by the resume path in
// runChatSession and the /delete recompute (which replays the messages left
// after the last turn is removed).
export function seedTracker(tracker, messages, pricing, scrapes) {
  let lastUsage = null
  if (messages) {
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.usage) {
        tracker.record(msg.usage, pricing)
        lastUsage = msg.usage
      }
    }
  }
  if (scrapes > 0) {
    tracker.addScrapeCost(SCRAPE_COST_USD * scrapes, scrapes)
  }
  return lastUsage
}

// Flattens a UsageTracker into the cost summary persisted on the session file
// and mirrored into the sidecar. The authoritative per-session totals.
export function trackerCostSummary(tracker) {
  return {
    promptTokens: tracker.promptTokens,
    completionTokens: tracker.completionTokens,
    totalTokens: tracker.totalTokens,
    cost: tracker.cost,
    requests: tracker.requests,
    cacheHits: tracker.cacheHits,
    cachedTokens: tracker.cachedTokens,
    scrapes: tracker.scrapes,
  }
}

// Fallback for legacy sessions saved before the cost summary existed: replay
// the surviving assistant usage (and the flat-fee scrape cost) exactly like a
// resumed session. Returns the same shape as `trackerCostSummary`.
export function computeCostSummary({ pricing, messages, scrapes = 0 }) {
  const tracker = new UsageTracker()
  seedTracker(tracker, messages, pricing, scrapes)
  return trackerCostSummary(tracker)
}
