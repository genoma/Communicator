import { formatError } from '../../errors.js'
import { selectModelAndEndpoint } from '../../model-selection.js'
import { getEffortLabel, selectReasoningEffort } from '../../prompts.js'
import { resolveTemperatureFlag, resolveWebResultsFlag } from '../../flags.js'
import { DEFAULT_WEB_SEARCH_RESULTS, formatCost } from '../../constants.js'
import { budgetStatus } from '../../tracker.js'
import { dim } from '../../ui/style.js'

const ARG_COMMANDS = new Set(['/temp', '/budget', '/web-search', '/web-results'])

export function budgetGuard(ctx) {
  const { state, tracker } = ctx
  if (state.budget == null || tracker.cost < state.budget) return null
  return `Budget exhausted (${formatCost(tracker.cost)} of ${formatCost(state.budget)}). /new to start fresh or /quit.\n`
}

const handlers = {
  '/quit': async () => ({ exit: true }),

  '/new': async (ctx) => {
    await ctx.saveSession()
    ctx.state.sessionId = await ctx.newSessionId()
    ctx.state.createdAt = new Date().toISOString()
    ctx.state.resetForNewSession(ctx.systemContent)
    console.log('\nNew session started.\n')
    return { reset: true }
  },

  '/model': async (ctx) => {
    await ctx.saveSession()
    let sel
    try {
      sel = await (ctx.selectModelAndEndpoint ?? selectModelAndEndpoint)({ provider: ctx.provider, apiKey: ctx.apiKey, prefs: ctx.prefs, reasoningEffort: undefined })
    } catch (err) {
      console.error(`\nError: ${formatError(err)}\n`)
      return
    }
    ctx.state.applyModelSelection(sel, ctx.prefs)
    await ctx.savePrefs({
      modelId: sel.modelId,
      lastModel: sel.modelId,
      lastProvider: sel.endpointProviderName,
      reasoningEffort: sel.reasoningEffort,
    })
    const label = sel.endpointProviderName ? `${sel.endpointProviderName} / ${sel.modelId}` : sel.modelId
    console.log(`\nSwitched to ${label}\n`)
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
  },

  '/budget': async (ctx) => {
    const value = ctx.args
    if (value) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error('Error: budget must be a positive number (USD).\n')
        return
      }
      ctx.state.setBudget(parsed)
      console.log(`Budget set to ${formatCost(parsed)} for this session.\n`)
      return { resetBudgetWarning: true }
    }
    if (ctx.state.budget == null) {
      console.log('No budget set. Use /budget <usd> to cap this session.\n')
      return
    }
    const { pct, remaining } = budgetStatus(ctx.tracker.cost, ctx.state.budget)
    console.log(`Budget: ${formatCost(ctx.tracker.cost)} of ${formatCost(ctx.state.budget)} used (${pct.toFixed(0)}%). ${formatCost(remaining)} remaining.\n`)
  },

  '/web-search': async (ctx) => {
    const value = ctx.args
    if (!value) {
      const results = ctx.state.webResults != null ? ` (${ctx.state.webResults} results)` : ''
      console.log(`Web search is ${ctx.state.webSearch ? 'enabled' : 'disabled'}${results}.\n`)
      return
    }
    const on = value === 'on' ? true : value === 'off' ? false : undefined
    if (on === undefined) {
      console.error('Error: /web-search expects "on" or "off".\n')
      return
    }
    if (on && ctx.state.webSearchSupported === false) {
      console.log('This model does not support web search.\n')
      return
    }
    ctx.state.setWebSearch(on)
    await ctx.savePrefs({ modelId: ctx.state.modelId, webSearch: on })
    console.log(`Web search ${on ? 'enabled' : 'disabled'}.\n`)
  },

  '/web-results': async (ctx) => {
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
    console.log(`Web search results set to ${parsed}.\n`)
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
    const result = await ctx.copyText(last.content)
    console.log(result.ok ? 'Copied last response to clipboard.\n' : `Copy failed: ${result.error}\n`)
  },

  '/markdown': async (ctx) => {
    ctx.state.toggleMarkdown()
    ctx.render.markdown = ctx.state.markdown
    console.log(`Markdown rendering ${ctx.state.markdown ? 'enabled' : 'disabled'}. The current line is styled once it completes.\n`)
  },

  '/cost': async (ctx) => {
    console.log(`${dim('Current session:')} ${ctx.tracker.summary()}`)
    console.log(`${dim('Reasoning:')} ${ctx.state.reasoningEffort === undefined ? 'auto' : getEffortLabel(ctx.state.reasoningEffort)}\n`)
  },
}

export const chatCommands = handlers

export const CHAT_COMMANDS = Object.keys(handlers)

export function commandAcceptsArgs(command) {
  return ARG_COMMANDS.has(command)
}
