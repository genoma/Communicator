import { readInput as readInputFromInput } from '../input.js'
import { persistSessionFile } from '../sessions.js'
import { getImageDefaults, mergeImageDefaults, savePreferences, applyPreferenceUpdates } from '../config.js'
import { findImageModel } from '../model-selection.js'
import { CliError, formatError } from '../errors.js'
import { resolveAspectRatio, resolveImageFormat, resolveSize } from '../flags.js'
import { computePixelSize, formatSize, sizePresets } from '../image-sizing.js'
import { runImageGeneration, printImageOutcome, buildImageSessionPayload, pixelSizingHint } from './image-gen.js'

const IMAGE_SESSION_COMMANDS = ['/help', '/exit', '/quit', '/watermark', '/aspect', '/format', '/size']

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

// Marks the current size in brackets inside the preset list, e.g.
// `Sizes: 1:1 1280x1280 · 2:3 [848x1272] · ...`; a stored value outside the
// presets is reported so the user knows it differs from them.
function sizeListLine(presets, current) {
  const marked = presets
    .map((p) => {
      const size = formatSize(p.width, p.height)
      return `${p.ratio} ${size === current ? `[${size}]` : size}`
    })
    .join(' · ')
  if (current && presets.some((p) => formatSize(p.width, p.height) === current)) return `Sizes: ${marked}.`
  if (current) return `Sizes: ${marked} (current: ${current}).`
  return `Sizes: ${marked} (none set).`
}

export async function startImageSession({ provider, apiKey, prefs, imageModelId, sessionId, createdAt, initialMessages = [], configPath, stdout = process.stdout, readInput: read = readInputFromInput }) {
  const model = await findImageModel(provider, apiKey, imageModelId)
  if (!model) {
    throw new CliError(`Error: image model ${imageModelId} is no longer available. Use --list-image-models to see available models.`)
  }

  let messages = initialMessages.length > 0 ? [...initialMessages] : [{ role: 'system', content: 'You are a helpful assistant.' }]
  const persist = () => persistSessionFile(sessionId, buildImageSessionPayload({ messages, modelId: imageModelId, createdAt, providerName: provider.meta.name }))

  let sessionAspectRatio
  let sessionFormat
  let sessionSize

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
      console.log('/size            show the supported sizes and the session one')
      console.log('/size <x:y|WxH>  set the size for this session (clear to unset)')
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
        const current = getImageDefaults(prefs, provider.meta.name).aspectRatio
        const ratios = model.constraints?.aspectRatios
        if (Array.isArray(ratios)) {
          console.log(`${supportedListLine('Aspect ratio', ratios, current, model)}\n`)
        } else if (model.constraints) {
          console.log(`Aspect ratio is not supported by ${model.id}.${pixelSizingHint(model)}\n`)
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
      // A model without an advertised list cannot take the parameter: pixel-
      // based Venice models (z-image-turbo, venice-sd35) ignore aspect_ratio
      // and return a square default, and OpenRouter models would silently
      // ignore it and still bill — so the value is always rejected here.
      if (constraints && !Array.isArray(ratios)) {
        console.error(`Error: aspect ratio is not supported by ${model.id}.${pixelSizingHint(model)}\n`)
        continue
      }
      if (Array.isArray(ratios) && !ratios.includes(parsed)) {
        console.error(`${unsupportedListError('aspect ratio', parsed, model, ratios)}\n`)
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

    if (input === '/size' || input.startsWith('/size ')) {
      const value = input.slice('/size'.length).trim()
      const divisor = model.constraints?.widthHeightDivisor
      if (!value) {
        if (divisor == null) {
          const ratios = model.constraints?.aspectRatios
          console.log(`Size is not supported by ${model.id}.${Array.isArray(ratios) ? ' Use /aspect instead.' : ''}\n`)
          continue
        }
        const current = getImageDefaults(prefs, provider.meta.name).size
        console.log(`${sizeListLine(sizePresets(model), current)}\n`)
        continue
      }
      if (value === 'clear') {
        sessionSize = undefined
        const defaults = { ...getImageDefaults(prefs, provider.meta.name) }
        delete defaults.size
        const updated = { ...prefs, imageDefaults: { ...(prefs.imageDefaults || {}), [provider.meta.name]: defaults } }
        Object.assign(prefs, updated)
        await savePreferences(updated, configPath)
        console.log('Size cleared.\n')
        continue
      }
      if (divisor == null) {
        const ratios = model.constraints?.aspectRatios
        console.error(`Error: size is not supported by ${model.id}.${Array.isArray(ratios) ? ' Use /aspect instead.' : ''}\n`)
        continue
      }
      let parsed
      try {
        parsed = resolveSize(value)
      } catch (err) {
        console.error(`Error: ${err.message}\n`)
        continue
      }
      let size
      if (parsed.ratio !== undefined) {
        try {
          const computed = computePixelSize(parsed.ratio, divisor)
          size = formatSize(computed.width, computed.height)
        } catch (err) {
          console.error(`Error: ${err.message}\n`)
          continue
        }
      } else {
        if (parsed.width % divisor !== 0 || parsed.height % divisor !== 0) {
          console.error(`Error: size ${value} must be divisible by ${divisor} for ${model.id}.\n`)
          continue
        }
        size = formatSize(parsed.width, parsed.height)
      }
      sessionSize = size
      const updated = mergeImageDefaults(prefs, provider.meta.name, { size })
      Object.assign(prefs, updated)
      await savePreferences(updated, configPath)
      console.log(`Size set to ${size}.\n`)
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
          ...(sessionSize !== undefined && { size: sessionSize }),
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
