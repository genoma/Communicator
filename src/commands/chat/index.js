import { formatError, CliError } from '../../errors.js'
import { selectModelAndEndpoint } from '../../model-selection.js'
import { getEffortLabel, selectReasoningEffort } from '../../prompts.js'
import { resolveTemperatureFlag, resolveWebResultsFlag, resolveSmoothSpeed, resolveBudget, webSearchGate, resolveAspectRatio, resolveImageFormat } from '../../flags.js'
import { DEFAULT_WEB_SEARCH_RESULTS, formatCost, cpsToCharsPerTick, formatSmoothSpeed } from '../../constants.js'
import { budgetStatusLine, budgetExhaustedMessage } from '../../tracker.js'
import { sessionLabel } from '../../ui/format.js'
import { dim } from '../../ui/style.js'
import { loadAttachments, attachmentGate, messageText, formatBytes, splitPathArgs } from '../../attachments.js'
import { attachGateOptions } from '../../session-setup.js'
import { getImageDefaults } from '../../config.js'
import { runImageGeneration, printImageOutcome, handleWatermarkCommand } from '../image-gen.js'

const ARG_COMMANDS = new Set(['/temp', '/budget', '/web-search', '/web-results', '/smooth', '/attach', '/attachments', '/image', '/watermark'])

export const IMAGE_USAGE = 'Usage: /image [--ratio <x:y>] [--format <png|jpeg|webp>] <description>'

const RATIO_FLAGS = new Set(['--ratio', '--aspect-ratio'])
const FORMAT_FLAGS = new Set(['--format'])

function parseImageArgs(args) {
  const tokens = args.trim().split(/\s+/)
  let ratio
  let format
  let i = 0
  while (i < tokens.length && tokens[i].startsWith('--')) {
    const token = tokens[i]
    const value = tokens[i + 1]
    if (RATIO_FLAGS.has(token)) {
      if (!value || value.startsWith('--')) throw new CliError(`Error: ${token} expects a value like 16:9.`)
      ratio = value
      i += 2
    } else if (FORMAT_FLAGS.has(token)) {
      if (!value || value.startsWith('--')) throw new CliError(`Error: ${token} expects a value like png.`)
      format = value
      i += 2
    } else {
      throw new CliError(`Error: unknown /image option ${token}. ${IMAGE_USAGE}`)
    }
  }
  return { ratio, format, description: tokens.slice(i).join(' ') }
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
      sel = await (ctx.selectModelAndEndpoint ?? selectModelAndEndpoint)({ provider: ctx.provider, apiKey: ctx.apiKey, prefs: ctx.prefs, reasoningEffort: undefined, zdr: ctx.state.zdr })
    } catch (err) {
      console.error(err instanceof CliError ? `\n${err.message}\n` : `\nError: ${formatError(err)}\n`)
      return
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
  },

  '/attach': async (ctx) => {
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
      let parsed
      try {
        parsed = resolveBudget(value)
      } catch (err) {
        console.error(`\nError: ${err.message}\n`)
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
    const line = budgetStatusLine(ctx.tracker.cost, ctx.state.budget)
    console.log(`${line ?? 'No budget set. Use /budget <usd> to cap this session.'}\n`)
  },

  '/web-search': async (ctx) => {
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
    await ctx.savePrefs({ webResults: parsed })
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
  },

  '/cost': async (ctx) => {
    console.log(`${dim('Current session:')} ${ctx.tracker.summary()}`)
    console.log(`${dim('Reasoning:')} ${ctx.state.reasoningEffort === undefined ? 'auto' : getEffortLabel(ctx.state.reasoningEffort)}\n`)
  },

  '/image': async (ctx) => {
    if (typeof ctx.provider.fetchImageModels !== 'function') {
      console.error(`Error: /image is not supported by ${ctx.provider.meta.name}.\n`)
      return
    }
    if (!ctx.args) {
      console.log(`${IMAGE_USAGE}\n`)
      return
    }
    let parsed
    try {
      parsed = parseImageArgs(ctx.args)
    } catch (err) {
      console.error(err instanceof CliError ? `${err.message}\n` : `\nError: ${formatError(err)}\n`)
      return
    }
    const { ratio, format, description } = parsed
    if (!description) {
      console.log(`${IMAGE_USAGE}\n`)
      return
    }
    let resolvedRatio
    let resolvedFormat
    try {
      resolvedRatio = resolveAspectRatio(ratio)
      resolvedFormat = resolveImageFormat(format)
    } catch (err) {
      console.error(`\nError: ${err.message}\n`)
      return
    }
    await ctx.saveSession()
    let outcome
    try {
      outcome = await runImageGeneration({
        provider: ctx.provider,
        apiKey: ctx.apiKey,
        prompt: description,
        opts: { aspectRatio: resolvedRatio, imageFormat: resolvedFormat },
        prefs: ctx.prefs,
        sessionId: ctx.state.sessionId,
        selectImage: ctx.selectImageModel,
        selectImageSizing: ctx.selectImageSizing,
      })
    } catch (err) {
      console.error(err instanceof CliError ? `\n${err.message}\n` : `\nError: ${formatError(err)}\n`)
      return
    }
    ctx.state.appendUser(description)
    ctx.state.appendAssistant(outcome.message)
    await ctx.saveSession()
    const prefsUpdates = { lastImageModel: outcome.modelId }
    if (outcome.prefsUpdates) {
      prefsUpdates.imageDefaults = {
        [ctx.provider.meta.name]: { ...getImageDefaults(ctx.prefs, ctx.provider.meta.name), ...outcome.prefsUpdates },
      }
    }
    await ctx.savePrefs(prefsUpdates)
    printImageOutcome(outcome, ctx.stdout)
  },

  '/watermark': async (ctx) => {
    await handleWatermarkCommand({
      providerName: ctx.provider.meta.name,
      args: ctx.args,
      prefs: ctx.prefs,
      savePrefs: ctx.savePrefs,
    })
  },
}

export const chatCommands = handlers

export const CHAT_COMMANDS = Object.keys(handlers)

export function visibleChatCommands({ visionSupported }) {
  return visionSupported === false
    ? CHAT_COMMANDS.filter((c) => c !== '/attach' && c !== '/attachments')
    : CHAT_COMMANDS
}

export function commandAcceptsArgs(command) {
  return ARG_COMMANDS.has(command)
}
