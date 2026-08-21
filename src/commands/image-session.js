import { readInput as readInputFromInput } from '../input.js'
import { persistSessionFile } from '../sessions.js'
import { DEFAULT_SYSTEM_PROMPT } from '../constants.js'
import { getImageDefaults, mergeImageDefaults, clearImageDefault, savePreferences, savePrefsBestEffort, syncPreferenceUpdates } from '../config.js'
import { findImageModel, selectImageEndpoint, selectModelAndEndpoint } from '../model-selection.js'
import { sessionLabel } from '../ui/format.js'
import { dim } from '../ui/style.js'
import { connectedBanner, buildImageStatusLine, wrapStatusLine } from '../status-line.js'
import { CliError, commandErrorLine } from '../errors.js'
import { resolveAspectRatio, resolveImageFormat, resolveQuality, resolveResolution, resolveSeed, resolveVariants } from '../flags.js'
import { computePixelSize, formatSize, isPixelModel, sizePresets, SIZE_PRESET_RATIOS } from '../image-sizing.js'
import { runImageGeneration, printImageOutcome, buildImageSessionPayload, handleWatermarkCommand } from './image-gen.js'

// /watermark is Venice-only: OpenRouter image models have no watermark
// parameter, so the command is only offered on Venice sessions.
function imageSessionCommands(providerName, model) {
  const c = model?.constraints
  const showAspect = Array.isArray(c?.aspectRatios) || isPixelModel(model)
  const showVariants = c?.maxN == null || c?.maxN > 1
  const cmds = ['/help', '/status', '/model', '/quit']
  if (providerName === 'venice') cmds.push('/watermark')
  if (showAspect) cmds.push('/aspect')
  if (Array.isArray(c?.resolutions)) cmds.push('/resolution')
  if (Array.isArray(c?.qualities)) cmds.push('/quality')
  if (Array.isArray(c?.formats)) cmds.push('/format')
  if (showVariants) cmds.push('/variants')
  cmds.push('/seed')
  return cmds
}

// Shared handler table for the sizing commands: `/format` and the new
// `/resolution`, `/quality`, `/variants`, `/seed`. The list-based commands
// are gated against the model's constraint lists; variants and seed are not.
const SIZING_HANDLERS = {
  '/resolution': { kind: 'Resolution', errorKind: 'resolution', resolve: resolveResolution, listKey: 'resolutions', defaultKey: 'resolution', flagKey: 'resolution', persisted: true },
  '/quality': { kind: 'Quality', errorKind: 'quality', resolve: resolveQuality, listKey: 'qualities', defaultKey: 'quality', flagKey: 'quality', persisted: true },
  '/variants': { kind: 'Variants', errorKind: 'variants', resolve: resolveVariants, listKey: null, defaultKey: 'variants', flagKey: 'variants', persisted: true },
  '/seed': { kind: 'Seed', errorKind: 'seed', resolve: resolveSeed, listKey: null, defaultKey: null, flagKey: 'seed', persisted: false },
  '/format': { kind: 'Format', errorKind: 'format', resolve: resolveImageFormat, listKey: 'formats', defaultKey: 'format', flagKey: 'imageFormat', persisted: true },
}

// Replaces image_url parts with a text placeholder when the history is
// handed to a text model that cannot take image input; text and other parts
// pass through untouched.
function stripImageParts(content) {
  if (!Array.isArray(content)) return content
  const parts = []
  for (const part of content) {
    if (part?.type === 'image_url') parts.push({ type: 'text', text: '[generated image]' })
    else parts.push(part)
  }
  return parts
}

// Clears a persisted image-default key (aspectRatio/format) and persists the
// change through the given saver.
async function persistClearedDefault(prefs, providerName, key, save, message) {
  const updated = clearImageDefault(prefs, providerName, key)
  Object.assign(prefs, updated)
  await save(updated)
  console.log(message)
}

function unsupportedListError(kind, value, model, list) {
  return `Error: ${kind} ${value} is not supported by ${model.id}. Supported: ${list.join(', ')}.`
}

// Marks the current value in brackets inside the model's supported list,
// e.g. `1:1 [16:9] 3:2`; a stored value outside the list is reported so the
// user knows it will be dropped instead of sent.
function pluralKind(kind) {
  return /[^aeiou]y$/i.test(kind) ? `${kind.slice(0, -1)}ies` : `${kind}s`
}

function supportedListLine(kind, values, current, model) {
  const marked = values.map((v) => (v === current ? `[${v}]` : v)).join(' ')
  const label = pluralKind(kind)
  if (current && values.includes(current)) return `${label}: ${marked}.`
  if (current) return `${label}: ${marked} (${current} not supported by ${model.id}).`
  return `${label}: ${marked} (none set).`
}

// Pixel-based models behave like aspect models with a hardcoded ratio list:
// every ratio shows its derived pixel size, and the current ratio is marked
// in brackets, e.g. `Aspect ratios: 1:1 1280x1280 · 3:2 1272x848 · [2:3]
// 848x1272 · ...`; a stored ratio outside the presets is reported as such.
function aspectPresetLine(presets, current) {
  const marked = presets
    .map((p) => {
      const label = `${p.ratio} ${formatSize(p.width, p.height)}`
      return p.ratio === current ? `[${label}]` : label
    })
    .join(' · ')
  if (current && presets.some((p) => p.ratio === current)) return `Aspect ratios: ${marked}.`
  if (current) return `Aspect ratios: ${marked} (current: ${current}).`
  return `Aspect ratios: ${marked} (none set).`
}

export async function startImageSession({ provider, apiKey, prefs, imageModelId, sessionId, createdAt, initialMessages = [], configPath, imageProviderName = null, pricing = null, stdout = process.stdout, readInput: read = readInputFromInput }) {
  let model = await findImageModel(provider, apiKey, imageModelId)
  if (!model) {
    throw new CliError(`Error: image model ${imageModelId} is no longer available. Use --list-image-models to see available models.`)
  }

  // OpenRouter sessions route through a provider endpoint: reuse the one
  // persisted for the session, or pick one interactively once at session
  // start (the picker prints the price, mirroring text sessions).
  if (typeof provider.fetchImageModelEndpoints === 'function') {
    const endpoints = await provider.fetchImageModelEndpoints(apiKey, model.id)
    const saved = endpoints.find((ep) => ep.providerName === imageProviderName)
    let chosen
    if (saved) {
      chosen = saved
    } else if (endpoints.length > 0) {
      chosen = await selectImageEndpoint({ provider, apiKey, model })
    }
    if (chosen) {
      model.imageProvider = chosen.slug || chosen.providerName
      model.endpointProviderName = chosen.providerName
      model.pricing = pricing ?? chosen.pricing
    }
  }

  let messages = initialMessages.length > 0 ? [...initialMessages] : [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }]
  const persist = () => persistSessionFile(sessionId, buildImageSessionPayload({ messages, modelId: imageModelId, createdAt, providerName: provider.meta.name, endpointProviderName: model.endpointProviderName, pricing: model.pricing }))

  // Preference writes are non-fatal here: a failing disk must not take the
  // whole session down with a raw fs error.
  const savePrefs = savePrefsBestEffort((updates) => savePreferences(updates, configPath))

  const sessionValues = {}

  const statusSegments = () => buildImageStatusLine({ model, imageModelId, endpointProviderName: model.endpointProviderName, sessionValues, prefs, providerName: provider.meta.name })

  console.log(connectedBanner(statusSegments(), {
    hints: ['Describe an image to generate it; /help lists the available commands.'],
  }))

  while (true) {
    const result = await read({ commands: imageSessionCommands(provider.meta.name, model) })
    if (result.cancelled) {
      await savePrefs(syncPreferenceUpdates(prefs, { lastImageModel: imageModelId }))
      await persist()
      return
    }

    const input = result.value.trim()
    if (!input) continue

    if (input === '/quit') {
      await savePrefs(syncPreferenceUpdates(prefs, { lastImageModel: imageModelId }))
      await persist()
      return
    }

    if (input === '/help') {
      const c = model?.constraints
      const showAspect = Array.isArray(c?.aspectRatios) || isPixelModel(model)
      const showVariants = c?.maxN == null || c?.maxN > 1
      console.log('/help            show this help')
      console.log('/status          show the current settings snapshot')
      console.log('/model           switch image model, or pick a text model to continue in chat')
      console.log('/quit            leave the session')
      if (provider.meta.name === 'venice') console.log('/watermark       hide the Venice watermark on generated images (on|off)')
      if (showAspect) {
        console.log('/aspect          show the supported aspect ratios and the session one')
        console.log('/aspect <x:y>    set the aspect ratio for this session (clear to unset)')
      }
      if (Array.isArray(c?.formats)) {
        console.log('/format          show the supported output formats and the session one')
        console.log('/format <fmt>    set the output format for this session (clear to unset)')
      }
      if (Array.isArray(c?.resolutions)) {
        console.log('/resolution      show the supported resolutions and the session one')
        console.log('/resolution <t>  set the resolution tier for this session (clear to unset)')
      }
      if (Array.isArray(c?.qualities)) {
        console.log('/quality         show the supported qualities and the session one')
        console.log('/quality <q>     set the quality tier for this session (clear to unset)')
      }
      if (showVariants) {
        console.log('/variants        show the number of images per generation and the session one')
        console.log('/variants <n>    set the number of images per generation (clear to unset)')
      }
      console.log('/seed            show the session seed')
      console.log('/seed <int>      set the random seed for this session (clear to unset)')
      continue
    }

    if (input === '/status') {
      console.log(`${wrapStatusLine(dim('Current settings:'), statusSegments())}\n`)
      continue
    }

    if (input === '/model') {
      await persist()
      let sel
      try {
        sel = await selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort: undefined, zdr: false })
      } catch (err) {
        console.error(commandErrorLine(err))
        continue
      }
      if (sel.isImageModel === true) {
        const next = await findImageModel(provider, apiKey, sel.modelId)
        if (!next) {
          console.error(`Error: image model ${sel.modelId} is no longer available.\n`)
          continue
        }
        next.imageProvider = sel.imageProvider
        next.endpointProviderName = sel.endpointProviderName
        next.pricing = sel.pricing
        model = next
        imageModelId = next.id
        await persist()
        await savePrefs(syncPreferenceUpdates(prefs, { lastImageModel: next.id }))
        console.log(`Switched to ${sessionLabel(sel.endpointProviderName, sel.modelId)} [image]`)
        console.log(`${wrapStatusLine(dim('Current settings:'), statusSegments())}\n`)
        continue
      }
      // A text-model pick hands the session off to the normal chat REPL,
      // keeping the history; non-vision models get image parts replaced by a
      // placeholder because the API would reject them.
      const transitionMessages = sel.visionSupported === false
        ? messages.map((m) => ({ ...m, content: stripImageParts(m.content) }))
        : messages
      return { switchToChat: { selection: sel, messages: transitionMessages, sessionId, createdAt } }
    }

    if (provider.meta.name === 'venice' && (input === '/watermark' || input.startsWith('/watermark '))) {
      await handleWatermarkCommand({
        providerName: provider.meta.name,
        args: input.slice('/watermark'.length).trim(),
        prefs,
        savePrefs: (updates) => savePrefs(syncPreferenceUpdates(prefs, updates)),
      })
      continue
    }

    const sizingCmd = Object.keys(SIZING_HANDLERS).find((c) => input === c || input.startsWith(`${c} `))
    if (sizingCmd) {
      const handler = SIZING_HANDLERS[sizingCmd]
      const providerName = provider.meta.name
      const value = input.slice(sizingCmd.length).trim()
      if (!value) {
        // The session value wins when set, else the saved provider default.
        const current = sessionValues[handler.flagKey] ?? (handler.persisted ? getImageDefaults(prefs, providerName)[handler.defaultKey] : undefined)
        if (handler.listKey && model.constraints) {
          const list = model.constraints[handler.listKey]
          if (Array.isArray(list)) {
            console.log(`${supportedListLine(handler.kind, list, current, model)}\n`)
          } else {
            console.log(`${handler.kind} is not supported by ${model.id}.\n`)
          }
        } else if (!handler.listKey) {
          if (handler.flagKey === 'variants') {
            const maxN = model.constraints?.maxN != null ? model.constraints.maxN : 4
            console.log(current === undefined ? `Variants: 1-${maxN} (none set).\n` : `Variants: 1-${maxN} (current: ${current}).\n`)
          } else {
            console.log(current === undefined ? 'Seed: not set.\n' : `Seed: ${current}.\n`)
          }
        } else {
          console.log(current ? `${handler.kind}: ${current}.\n` : `${handler.kind}: not set.\n`)
        }
        continue
      }
      if (value === 'clear') {
        sessionValues[handler.flagKey] = undefined
        if (handler.persisted) {
          await persistClearedDefault(prefs, providerName, handler.defaultKey, savePrefs, `${handler.kind} cleared.\n`)
        } else {
          console.log(`${handler.kind} cleared.\n`)
        }
        continue
      }
      let parsed
      try {
        parsed = handler.resolve(value)
      } catch (err) {
        console.error(`Error: ${err.message}\n`)
        continue
      }
      if (handler.listKey) {
        const constraints = model.constraints
        const list = constraints?.[handler.listKey]
        if (constraints && !Array.isArray(list)) {
          console.error(`Error: ${handler.errorKind} is not supported by ${model.id}.\n`)
          continue
        }
        if (Array.isArray(list) && !list.includes(parsed)) {
          console.error(`${unsupportedListError(handler.errorKind, parsed, model, list)}\n`)
          continue
        }
      } else if (handler.flagKey === 'variants' && model.constraints?.maxN != null && parsed > model.constraints.maxN) {
        console.error(`Error: variants ${parsed} is not supported by ${model.id}. Supported: 1-${model.constraints.maxN}.\n`)
        continue
      }
      sessionValues[handler.flagKey] = parsed
      if (handler.persisted) {
        const updated = mergeImageDefaults(prefs, providerName, { [handler.defaultKey]: parsed })
        Object.assign(prefs, updated)
        await savePrefs(updated)
      }
      console.log(`${handler.kind} set to ${parsed}.\n`)
      continue
    }

    if (input === '/aspect' || input.startsWith('/aspect ')) {
      const value = input.slice('/aspect'.length).trim()
      if (!value) {
        // The session value wins when set ("currently used"), else the
        // saved provider default.
        const current = sessionValues.aspectRatio ?? getImageDefaults(prefs, provider.meta.name).aspectRatio
        const ratios = model.constraints?.aspectRatios
        if (Array.isArray(ratios)) {
          console.log(`${supportedListLine('Aspect ratio', ratios, current, model)}\n`)
        } else if (isPixelModel(model)) {
          console.log(`${aspectPresetLine(sizePresets(model), current)}\n`)
        } else if (model.constraints) {
          console.log(`Aspect ratio is not supported by ${model.id}.\n`)
        } else {
          console.log(current ? `Aspect ratio: ${current}.\n` : 'Aspect ratio: not set.\n')
        }
        continue
      }
      if (value === 'clear') {
        sessionValues.aspectRatio = undefined
        await persistClearedDefault(prefs, provider.meta.name, 'aspectRatio', savePrefs, 'Aspect ratio cleared.\n')
        continue
      }
      let parsed
      try {
        parsed = resolveAspectRatio(value)
      } catch (err) {
        console.error(`Error: ${err.message}\n`)
        continue
      }
      const constraints = model.constraints
      const ratios = constraints?.aspectRatios
      // Pixel-based Venice models have no advertised list; they behave like
      // aspect models over the hardcoded preset ratios (the pixels are
      // derived from the ratio). Other models without a list cannot take the
      // parameter at all.
      if (constraints && !Array.isArray(ratios) && !isPixelModel(model)) {
        console.error(`Error: aspect ratio is not supported by ${model.id}.\n`)
        continue
      }
      const supported = isPixelModel(model) ? SIZE_PRESET_RATIOS : ratios
      if (Array.isArray(supported) && !supported.includes(parsed)) {
        console.error(`${unsupportedListError('aspect ratio', parsed, model, supported)}\n`)
        continue
      }
      if (isPixelModel(model)) {
        const computed = computePixelSize(parsed, model.constraints.widthHeightDivisor)
        sessionValues.aspectRatio = parsed
        const updated = mergeImageDefaults(prefs, provider.meta.name, { aspectRatio: parsed })
        Object.assign(prefs, updated)
        await savePrefs(updated)
        console.log(`Aspect ratio set to ${parsed} (${formatSize(computed.width, computed.height)}).\n`)
        continue
      }
      sessionValues.aspectRatio = parsed
      const updated = mergeImageDefaults(prefs, provider.meta.name, { aspectRatio: parsed })
      Object.assign(prefs, updated)
      await savePrefs(updated)
      console.log(`Aspect ratio set to ${parsed}.\n`)
      continue
    }

    if (input.startsWith('/')) {
      console.log(`Unknown command "${input}". Available: ${imageSessionCommands(provider.meta.name, model).join(', ')}`)
      continue
    }

    let outcome
    try {
      outcome = await runImageGeneration({
        provider,
        apiKey,
        prompt: input,
        opts: Object.fromEntries(
          Object.entries(sessionValues).filter(([, v]) => v !== undefined)
        ),
        prefs,
        sessionId,
        model,
        stdout,
        sizingInteractive: false,
      })
    } catch (err) {
      console.error(commandErrorLine(err))
      continue
    }

    messages.push({ role: 'user', content: input })
    messages.push(outcome.message)
    await persist()
    const updated = syncPreferenceUpdates(prefs, { lastImageModel: outcome.modelId })
    const withImageDefaults = outcome.prefsUpdates ? mergeImageDefaults(updated, provider.meta.name, outcome.prefsUpdates) : updated
    Object.assign(prefs, withImageDefaults)
    await savePrefs(withImageDefaults)
    printImageOutcome(outcome, stdout)
  }
}
