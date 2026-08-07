import { readInput as readInputFromInput } from '../input.js'
import { persistSessionFile } from '../sessions.js'
import { getImageDefaults, mergeImageDefaults, savePreferences, applyPreferenceUpdates } from '../config.js'
import { findImageModel, selectImageEndpoint } from '../model-selection.js'
import { CliError, formatError } from '../errors.js'
import { resolveAspectRatio, resolveImageFormat } from '../flags.js'
import { computePixelSize, formatSize, isPixelModel, sizePresets, SIZE_PRESET_RATIOS } from '../image-sizing.js'
import { runImageGeneration, printImageOutcome, buildImageSessionPayload } from './image-gen.js'

const IMAGE_SESSION_COMMANDS = ['/help', '/exit', '/quit', '/watermark', '/aspect', '/format']

function unsupportedListError(kind, value, model, list) {
  return `Error: ${kind} ${value} is not supported by ${model.id}. Supported: ${list.join(', ')}.`
}

// Marks the current value in brackets inside the model's supported list,
// e.g. `1:1 [16:9] 3:2`; a stored value outside the list is reported so the
// user knows it will be dropped instead of sent.
function supportedListLine(kind, values, current, model) {
  const marked = values.map((v) => (v === current ? `[${v}]` : v)).join(' ')
  if (current && values.includes(current)) return `${kind}s: ${marked}.`
  if (current) return `${kind}s: ${marked} (${current} not supported by ${model.id}).`
  return `${kind}s: ${marked} (none set).`
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
  const model = await findImageModel(provider, apiKey, imageModelId)
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

  let messages = initialMessages.length > 0 ? [...initialMessages] : [{ role: 'system', content: 'You are a helpful assistant.' }]
  const persist = () => persistSessionFile(sessionId, buildImageSessionPayload({ messages, modelId: imageModelId, createdAt, providerName: provider.meta.name }))

  let sessionAspectRatio
  let sessionFormat

  console.log(`Image session with ${imageModelId}. Describe an image to generate it; /help lists the available commands.\n`)

  while (true) {
    const result = await read({ commands: IMAGE_SESSION_COMMANDS })
    if (result.cancelled) {
      await persist()
      return
    }

    const input = result.value.trim()
    if (!input) continue

    if (input === '/exit' || input === '/quit') {
      await persist()
      return
    }

    if (input === '/help') {
      console.log('/help            show this help')
      console.log('/exit, /quit     leave the session')
      console.log('/watermark       hide the Venice watermark on generated images (on|off)')
      console.log('/aspect          show the supported aspect ratios and the session one')
      console.log('/aspect <x:y>    set the aspect ratio for this session (clear to unset)')
      console.log('/format          show the supported output formats and the session one')
      console.log('/format <fmt>    set the output format for this session (clear to unset)')
      continue
    }

    if (input === '/watermark' || input.startsWith('/watermark ')) {
      if (provider.meta.name !== 'venice') {
        console.error('Error: /watermark is only supported on Venice sessions.\n')
        continue
      }
      const value = input.slice('/watermark'.length).trim()
      if (!value) {
        console.log(`Venice watermark is ${prefs.hideWatermark === true ? 'off' : 'on'}.\n`)
        continue
      }
      if (value === 'on' || value === 'off') {
        const next = value === 'on'
        prefs.hideWatermark = !next
        await savePreferences(applyPreferenceUpdates(prefs, { hideWatermark: !next }), configPath)
        console.log(`Venice watermark ${next ? 'enabled' : 'disabled'}.\n`)
        continue
      }
      console.error('Error: /watermark expects "on" or "off".\n')
      continue
    }

    if (input === '/aspect' || input.startsWith('/aspect ')) {
      const value = input.slice('/aspect'.length).trim()
      if (!value) {
        // The session value wins when set ("currently used"), else the
        // saved provider default.
        const current = sessionAspectRatio ?? getImageDefaults(prefs, provider.meta.name).aspectRatio
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
        sessionAspectRatio = undefined
        const defaults = { ...getImageDefaults(prefs, provider.meta.name) }
        delete defaults.aspectRatio
        const updated = { ...prefs, imageDefaults: { ...(prefs.imageDefaults || {}), [provider.meta.name]: defaults } }
        Object.assign(prefs, updated)
        await savePreferences(updated, configPath)
        console.log('Aspect ratio cleared.\n')
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
        sessionAspectRatio = parsed
        const updated = mergeImageDefaults(prefs, provider.meta.name, { aspectRatio: parsed })
        Object.assign(prefs, updated)
        await savePreferences(updated, configPath)
        console.log(`Aspect ratio set to ${parsed} (${formatSize(computed.width, computed.height)}).\n`)
        continue
      }
      sessionAspectRatio = parsed
      const updated = mergeImageDefaults(prefs, provider.meta.name, { aspectRatio: parsed })
      Object.assign(prefs, updated)
      await savePreferences(updated, configPath)
      console.log(`Aspect ratio set to ${parsed}.\n`)
      continue
    }

    if (input === '/format' || input.startsWith('/format ')) {
      const value = input.slice('/format'.length).trim()
      if (!value) {
        const current = getImageDefaults(prefs, provider.meta.name).format
        const formats = model.constraints?.formats
        if (Array.isArray(formats)) {
          console.log(`${supportedListLine('Format', formats, current, model)}\n`)
        } else if (model.constraints) {
          console.log(`Format is not supported by ${model.id}.\n`)
        } else {
          console.log(current ? `Format: ${current}.\n` : 'Format: not set.\n')
        }
        continue
      }
      if (value === 'clear') {
        sessionFormat = undefined
        const defaults = { ...getImageDefaults(prefs, provider.meta.name) }
        delete defaults.format
        const updated = { ...prefs, imageDefaults: { ...(prefs.imageDefaults || {}), [provider.meta.name]: defaults } }
        Object.assign(prefs, updated)
        await savePreferences(updated, configPath)
        console.log('Format cleared.\n')
        continue
      }
      let parsed
      try {
        parsed = resolveImageFormat(value)
      } catch (err) {
        console.error(`Error: ${err.message}\n`)
        continue
      }
      const constraints = model.constraints
      const formats = constraints?.formats
      if (constraints && !Array.isArray(formats)) {
        console.error(`Error: format is not supported by ${model.id}.\n`)
        continue
      }
      if (Array.isArray(formats) && !formats.includes(parsed)) {
        console.error(`${unsupportedListError('format', parsed, model, formats)}\n`)
        continue
      }
      sessionFormat = parsed
      const updated = mergeImageDefaults(prefs, provider.meta.name, { format: parsed })
      Object.assign(prefs, updated)
      await savePreferences(updated, configPath)
      console.log(`Format set to ${parsed}.\n`)
      continue
    }

    if (input.startsWith('/')) {
      console.log(`Unknown command "${input}". Available: ${IMAGE_SESSION_COMMANDS.join(', ')}`)
      continue
    }

    let outcome
    try {
      outcome = await runImageGeneration({
        provider,
        apiKey,
        prompt: input,
        opts: {
          ...(sessionAspectRatio !== undefined && { aspectRatio: sessionAspectRatio }),
          ...(sessionFormat !== undefined && { imageFormat: sessionFormat }),
        },
        prefs,
        sessionId,
        model,
        stdout,
        sizingInteractive: false,
      })
    } catch (err) {
      console.error(err instanceof CliError ? `\n${err.message}\n` : `\nError: ${formatError(err)}\n`)
      continue
    }

    messages.push({ role: 'user', content: input })
    messages.push(outcome.message)
    await persist()
    const updated = applyPreferenceUpdates(prefs, { lastImageModel: outcome.modelId })
    const withImageDefaults = outcome.prefsUpdates ? mergeImageDefaults(updated, provider.meta.name, outcome.prefsUpdates) : updated
    Object.assign(prefs, withImageDefaults)
    await savePreferences(withImageDefaults, configPath)
    printImageOutcome(outcome, stdout)
  }
}
