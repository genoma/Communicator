import { formatError, commandErrorLine } from '../../errors.js'
import { selectModelAndEndpoint } from '../../model-selection.js'
import { getEffortLabel, selectReasoningEffort } from '../../prompts.js'
import { resolveTemperatureFlag, resolveWebResultsFlag, resolveSmoothSpeed, resolveBudget, webSearchGate } from '../../flags.js'
import { DEFAULT_WEB_SEARCH_RESULTS, formatCost, cpsToCharsPerTick, formatSmoothSpeed, SCRAPE_COST_USD } from '../../constants.js'
import { budgetStatusLine, budgetExhaustedMessage } from '../../tracker.js'
import { sessionLabel } from '../../ui/format.js'
import { dim } from '../../ui/style.js'
import { loadAttachments, attachmentGate, messageText, formatBytes, splitPathArgs } from '../../attachments.js'
import { attachGateOptions } from '../../session-setup.js'
import { fetchModelPubKey } from '../../e2ee.js'
import { buildStatusLine } from '../../status-line.js'
import { scrapeContext, scrapeMessage } from '../../scrape.js'
const ARG_COMMANDS = new Set(['/temp', '/budget', '/web-search', '/web-results', '/smooth', '/attach', '/attachments', '/scrape'])

export function showStatus(ctx) {
  console.log(`Current settings: ${buildStatusLine(ctx.state).join('  ')}\n`)
}

export function budgetGuard(ctx) {
  const { state, tracker } = ctx
  if (state.budget == null || tracker.cost < state.budget) return null
  return `${budgetExhaustedMessage(tracker.cost, state.budget)} /new to start fresh or /quit.\n`
}

function attachmentGateOptions(ctx) {
  return attachGateOptions(ctx.state, ctx.provider.meta)
}

const handlers = {
  '/quit': async () => ({ exit: true }),

  '/status': async (ctx) => {
    showStatus(ctx)
  },

  '/new': async (ctx) => {
    await ctx.saveSession()
    ctx.state.sessionId = await ctx.newSessionId()
    ctx.state.createdAt = new Date().toISOString()
    ctx.state.resetForNewSession(ctx.systemContent)
    console.log('\nNew session started.\n')
    showStatus(ctx)
    return { reset: true }
  },

  '/model': async (ctx) => {
    await ctx.saveSession()
    let sel
    try {
      sel = await (ctx.selectModelAndEndpoint ?? selectModelAndEndpoint)({ provider: ctx.provider, apiKey: ctx.apiKey, prefs: ctx.prefs, reasoningEffort: undefined, zdr: ctx.state.zdr, e2ee: ctx.state.e2ee })
    } catch (err) {
      console.error(commandErrorLine(err))
      return
    }
    if (ctx.state.e2ee) {
      if (sel.supportsE2EE !== true) {
        console.error('\nError: the selected model does not support E2EE; staying on the current model.\n')
        return
      }
      // The client key pair stays per-session; only the model public key
      // changes, so attest the new model before committing the switch.
      try {
        ctx.state.e2eeContext.modelPubKeyHex = await fetchModelPubKey({ apiKey: ctx.apiKey, modelId: sel.modelId })
      } catch (err) {
        console.error(`\nError: ${formatError(err)}\n`)
        return
      }
    }
    ctx.state.applyModelSelection(sel, ctx.prefs)
    const gateOptions = attachmentGateOptions(ctx)
    const kept = []
    for (const att of ctx.state.pendingAttachments) {
      const gateError = attachmentGate([att], gateOptions)
      if (gateError) {
        console.log(`Dropped attachment ${att.filename}: ${gateError}\n`)
      } else {
        kept.push(att)
      }
    }
    ctx.state.pendingAttachments = kept
    await ctx.savePrefs({
      modelId: sel.modelId,
      lastModel: sel.modelId,
      lastProvider: sel.endpointProviderName,
      reasoningEffort: sel.reasoningEffort,
    })
    const label = sessionLabel(sel.endpointProviderName, sel.modelId)
    console.log(`\nSwitched to ${label}\n`)
    showStatus(ctx)
  },

  '/attach': async (ctx) => {
    if (ctx.state.e2ee) {
      console.error('E2EE does not support file uploads.\n')
      return
    }
    if (!ctx.args) return handlers['/attachments'](ctx)
    const gateOptions = attachmentGateOptions(ctx)
    const { attachments, ignored } = await loadAttachments(splitPathArgs(ctx.args), gateOptions, {
      skipNonPaths: true,
      onError: (message) => console.error(`${message}\n`),
      onAttached: (att) => console.log(`attached: ${att.filename} (${att.kind}, ${formatBytes(att.size)})\n`),
    })
    ctx.state.pendingAttachments.push(...attachments)
    if (ignored.length) {
      console.log(`note: "${ignored.join(' ')}" is not a file path — /attach takes file paths only; type your message on the next line.\n`)
    }
  },

  '/attachments': async (ctx) => {
    if (ctx.state.e2ee) {
      console.error('E2EE does not support file uploads.\n')
      return
    }
    if (ctx.args && ctx.args !== 'clear') {
      console.error('Error: /attachments expects "clear" or no argument.\n')
      return
    }
    if (ctx.args === 'clear') {
      ctx.state.pendingAttachments = []
      console.log('Attachment queue cleared.\n')
      return
    }
    const queue = ctx.state.pendingAttachments
    if (!queue.length) {
      console.log('No attachments queued. Use /attach <path> to add one.\n')
      return
    }
    console.log(`Pending attachments (${queue.length}):`)
    for (const att of queue) {
      console.log(`${att.filename}  ${att.kind}  ${formatBytes(att.size)}\n`)
    }
  },

  '/reasoning': async (ctx) => {
    let reasoning = ctx.state.modelReasoning
    if (!reasoning) {
      try {
        const models = await ctx.provider.fetchModels(ctx.apiKey)
        reasoning = models.find((m) => m.id === ctx.state.modelId)?.reasoning || null
        ctx.state.modelReasoning = reasoning
      } catch (err) {
        console.error(`\nError: ${formatError(err)}\n`)
        return
      }
    }
    const newEffort = await (ctx.selectReasoningEffort ?? selectReasoningEffort)(reasoning, ctx.state.reasoningEffort)
    if (newEffort === undefined) {
      console.log('This model does not support reasoning effort control.\n')
      return
    }
    ctx.state.setReasoningEffort(newEffort)
    await ctx.savePrefs({ modelId: ctx.state.modelId, reasoningEffort: newEffort })
    console.log(`Reasoning effort set to ${getEffortLabel(newEffort)}\n`)
    showStatus(ctx)
  },

  '/temp': async (ctx) => {
    const value = ctx.args
    if (!value) {
      console.log(`Current temperature: ${ctx.state.temperature}\n`)
      return
    }
    let parsed
    try {
      parsed = resolveTemperatureFlag({ temperature: value })
    } catch (err) {
      console.error(`\nError: ${err.message}\n`)
      return
    }
    ctx.state.setTemperature(parsed)
    await ctx.savePrefs({ modelId: ctx.state.modelId, temperature: parsed })
    console.log(`Temperature set to ${parsed}\n`)
    showStatus(ctx)
  },

  '/budget': async (ctx) => {
    const value = ctx.args
    if (value) {
      let parsed
      try {
        parsed = resolveBudget(value)
      } catch (err) {
        console.error(`\nError: ${err.message}\n`)
        return
      }
      ctx.state.setBudget(parsed)
      console.log(`Budget set to ${formatCost(parsed)} for this session.\n`)
      showStatus(ctx)
      return { resetBudgetWarning: true }
    }
    if (ctx.state.budget == null) {
      console.log('No budget set. Use /budget <usd> to cap this session.\n')
      return
    }
    const line = budgetStatusLine(ctx.tracker.cost, ctx.state.budget)
    console.log(`${line ?? 'No budget set. Use /budget <usd> to cap this session.'}\n`)
  },

  '/web-search': async (ctx) => {
    if (ctx.state.e2ee) {
      console.error('E2EE does not support web search.\n')
      return
    }
    const value = ctx.args
    if (!value) {
      const results = ctx.state.webResults != null ? ` (${ctx.state.webResults} results)` : ''
      console.log(`Web search is ${ctx.state.webSearch}${results}.\n`)
      return
    }
    const mode = value === 'on' ? 'auto' : ['auto', 'always', 'off'].includes(value) ? value : undefined
    if (mode === undefined) {
      console.error('Error: /web-search expects "on", "off", "auto", or "always".\n')
      return
    }
    const gateError = webSearchGate(mode, ctx.state.webSearchSupported)
    if (gateError) {
      console.log(`${gateError}\n`)
      return
    }
    ctx.state.setWebSearch(mode)
    await ctx.savePrefs({ modelId: ctx.state.modelId, webSearch: mode })
    console.log(mode === 'off' ? 'Web search disabled.\n' : `Web search set to ${mode}.\n`)
    showStatus(ctx)
  },

  '/web-results': async (ctx) => {
    if (ctx.state.e2ee) {
      console.error('E2EE does not support web search.\n')
      return
    }
    const value = ctx.args
    if (!value) {
      if (ctx.state.webResults == null) {
        console.log(`Web search results: default (${DEFAULT_WEB_SEARCH_RESULTS}).\n`)
        return
      }
      console.log(`Web search results: ${ctx.state.webResults}.\n`)
      return
    }
    let parsed
    try {
      parsed = resolveWebResultsFlag({ webResults: value })
    } catch (err) {
      console.error(`\nError: ${err.message}\n`)
      return
    }
    ctx.state.setWebResults(parsed)
    await ctx.savePrefs({ webResults: parsed })
    console.log(`Web search results set to ${parsed}.\n`)
    showStatus(ctx)
  },

  '/scrape': async (ctx) => {
    if (ctx.state.e2ee) {
      console.error('E2EE does not support web scraping.\n')
      return
    }
    if (typeof ctx.provider.scrapePage !== 'function') {
      console.error('Web scraping is only supported on Venice.\n')
      return
    }
    const url = ctx.args.trim()
    if (!url) {
      console.error('Usage: /scrape <url>\n')
      return
    }
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      parsed = null
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      console.error('Error: /scrape expects a valid http(s) URL.\n')
      return
    }
    let result
    try {
      result = await ctx.provider.scrapePage({ apiKey: ctx.apiKey, url })
    } catch (err) {
      console.error(`\nError: ${formatError(err)}\n`)
      return
    }
    const { text, sizeLabel } = scrapeContext(url, result.content)
    ctx.state.appendUser(scrapeMessage(url, text))
    ctx.state.scrapes += 1
    ctx.tracker.addScrapeCost(SCRAPE_COST_USD)
    console.log(`Scraped ${url} (${sizeLabel}, $${SCRAPE_COST_USD.toFixed(2)}) into context — session cost ${formatCost(ctx.tracker.cost)}.\n`)
  },

  '/retry': async (ctx) => {
    const guard = budgetGuard(ctx)
    if (guard) {
      console.log(guard)
      return
    }
    const last = ctx.state.messages[ctx.state.messages.length - 1]
    if (last?.role === 'assistant') {
      ctx.state.popLastMessage()
      await ctx.runTurn()
    } else if (last?.role === 'user') {
      await ctx.runTurn()
    } else {
      console.log('Nothing to retry yet.\n')
    }
  },

  '/copy': async (ctx) => {
    const last = ctx.state.lastAssistantMessage
    if (!last) {
      console.log('No assistant response to copy.\n')
      return
    }
    const result = await ctx.copyText(messageText(last.content))
    console.log(result.ok ? 'Copied last response to clipboard.\n' : `Copy failed: ${result.error}\n`)
  },

  '/markdown': async (ctx) => {
    ctx.state.toggleMarkdown()
    ctx.render.markdown = ctx.state.markdown
    const hint = ctx.state.markdown ? ' Lines are styled and streamed live.' : ''
    console.log(`Markdown rendering ${ctx.state.markdown ? 'enabled' : 'disabled'}.${hint}\n`)
  },

  '/smooth': async (ctx) => {
    const value = ctx.args
    if (!value) {
      const status = ctx.state.smoothStreaming ? `on (${formatSmoothSpeed(ctx.state.smoothSpeed)})` : 'off'
      console.log(`Smooth streaming is ${status}.\n`)
      return
    }
    if (value === 'on' || value === 'off') {
      const next = value === 'on'
      ctx.state.setSmoothStreaming(next)
      ctx.render.smooth = next
      await ctx.savePrefs({ smoothStreaming: next })
      console.log(`Smooth streaming ${next ? 'enabled' : 'disabled'}.\n`)
      showStatus(ctx)
      return
    }
    let cps
    try {
      cps = resolveSmoothSpeed(value)
    } catch (err) {
      console.error(`\nError: ${err.message}\n`)
      return
    }
    ctx.state.setSmoothStreaming(true)
    ctx.state.setSmoothSpeed(cps)
    ctx.render.smooth = true
    ctx.render.smoothCharsPerTick = cpsToCharsPerTick(cps)
    // Persist the canonical cps number (same format as --smooth-speed and
    // /config-set), not the raw preset label.
    await ctx.savePrefs({ smoothStreaming: true, smoothSpeed: cps })
    console.log(`Smooth streaming enabled (${formatSmoothSpeed(cps)}).\n`)
    showStatus(ctx)
  },

  '/cost': async (ctx) => {
    console.log(`${dim('Current session:')} ${ctx.tracker.summary()}`)
    console.log(`${dim('Reasoning:')} ${ctx.state.reasoningEffort === undefined ? 'auto' : getEffortLabel(ctx.state.reasoningEffort)}\n`)
  },
}

export const chatCommands = handlers

export const CHAT_COMMANDS = Object.keys(handlers)

export function visibleChatCommands({ visionSupported, e2ee = false, providerName }) {
  const hidden = []
  if (visionSupported === false || e2ee) hidden.push('/attach', '/attachments')
  if (e2ee) hidden.push('/web-search', '/web-results')
  // Web scraping is a Venice-only feature; the provider is fixed at session
  // start (never switches mid-session), so the list is computed once.
  if (e2ee || providerName !== 'venice') hidden.push('/scrape')
  return CHAT_COMMANDS.filter((c) => !hidden.includes(c))
}

export function commandAcceptsArgs(command) {
  return ARG_COMMANDS.has(command)
}
