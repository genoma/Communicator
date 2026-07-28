const THIN_SEP = "───────────────────────────────────────";

export class UsageTracker {
  constructor() {
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalTokens = 0;
    this.cost = 0;
    this.requests = 0;
    this.cacheHits = 0;
    this.cachedTokens = 0;
  }

  record(usage, pricing) {
    if (!usage) return;

    const pt = usage.prompt_tokens ?? 0;
    const ct = usage.completion_tokens ?? 0;
    const tt = usage.total_tokens ?? pt + ct;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const hit = cached > 0 || usage.cacheHit;

    this.promptTokens += pt;
    this.completionTokens += ct;
    this.totalTokens += tt;
    this.requests += 1;
    if (hit) this.cacheHits += 1;
    this.cachedTokens += cached;

    if (pricing?.prompt != null && pricing?.completion != null) {
      const promptPrice = parseFloat(pricing.prompt);
      const completionPrice = parseFloat(pricing.completion);
      if (!Number.isNaN(promptPrice) && !Number.isNaN(completionPrice)) {
        this.cost += pt * promptPrice + ct * completionPrice;
      }
    }
  }

  printTurn(usage, pricing) {
    if (!usage) return;

    const pt = usage.prompt_tokens ?? 0;
    const ct = usage.completion_tokens ?? 0;
    const tt = usage.total_tokens ?? pt + ct;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const hit = cached > 0 || usage.cacheHit;

    console.log(`\x1b[90m${THIN_SEP}\x1b[0m`);

    const arrowUp = "\u2191";
    const arrowDown = "\u2193";
    const eq = "\u003d";

    console.log(
      `  Tokens  ${arrowUp} ${pt.toLocaleString()} prompt  ${arrowDown} ${ct.toLocaleString()} completion  ${eq} ${tt.toLocaleString()} total`
    );

    if (hit) {
      const parts = [];
      if (cached > 0) parts.push(`${cached.toLocaleString()} cached tokens`);
      if (usage.cacheHit) parts.push("response cache hit");
      console.log(`  Cache   ${parts.join(", ")}`);
    }

    let turnCost = 0;
    if (pricing?.prompt != null && pricing?.completion != null) {
      const promptPrice = parseFloat(pricing.prompt);
      const completionPrice = parseFloat(pricing.completion);
      if (!Number.isNaN(promptPrice) && !Number.isNaN(completionPrice)) {
        turnCost = pt * promptPrice + ct * completionPrice;
      }
    }

    if (pricing) {
      const turnPart = turnCost < 0.000001 ? "$0.000000" : `$${turnCost.toFixed(6)}`;
      const sessionPart = this.cost < 0.000001 ? "$0.000000" : `$${this.cost.toFixed(6)}`;
      console.log(`  Cost    ${turnPart} this turn  |  ${sessionPart} session`);
    }

    console.log(`\x1b[90m${THIN_SEP}\x1b[0m`);
  }

  summary() {
    const arrowUp = "\u2191";
    const arrowDown = "\u2193";
    const eq = "\u003d";

    let s = `${arrowUp} ${this.totalTokens.toLocaleString()} prompt  ${arrowDown} ${this.completionTokens.toLocaleString()} completion  ${eq} ${this.totalTokens.toLocaleString()} total  |  ${this.requests} request(s)`;
    if (this.cacheHits > 0) {
      s += `  |  ${this.cacheHits} cache hit(s) [${this.cachedTokens.toLocaleString()} cached tokens]`;
    }
    if (this.cost > 0) {
      s += `  |  $${this.cost.toFixed(6)} cost`;
    }
    return s;
  }
}
