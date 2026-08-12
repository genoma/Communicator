import { ExitPromptError } from '@inquirer/core'
import { basename, join } from 'node:path'
import { copyFile, mkdir } from 'node:fs/promises'
import { getProvider } from '../providers/index.js'
import { createNewSession, removeEmptySessionClaim, persistSessionFile, buildSessionPayload } from '../sessions.js'
import { attachmentDirFor, externalizeAttachments, savedAttachmentPath } from '../attachment-store.js'
import { selectImageModelNonInteractive, selectImageEndpoint } from '../model-selection.js'
import { selectImageModel, selectSizingOption } from '../prompts.js'
import { SESSIONS_DIR, DEFAULT_SYSTEM_PROMPT } from '../constants.js'
import { CliError, formatError } from '../errors.js'
import { readStdin, NO_PROMPT_MESSAGE } from '../cli-utils.js'
import { getImageDefaults, mergeImageDefaults, savePreferences, applyPreferenceUpdates } from '../config.js'
import { createLoader } from '../ui/loader.js'
import { resolveAspectRatio, resolveHeight, resolveImageFormat, resolveQuality, resolveResolution, resolveSeed, resolveVariants, resolveWidth } from '../flags.js'
import { computePixelSize, formatSize, isPixelModel, sizeLabel, sizePresets, SIZE_PRESET_RATIOS } from '../image-sizing.js'

function validateSizingConstraints(model, { aspectRatio, format, resolution, quality, width, height, variants }) {
  if (!model) return
  const constraints = model.constraints || {}
  if (aspectRatio && Array.isArray(constraints.aspectRatios) && !constraints.aspectRatios.includes(aspectRatio)) {
    throw new CliError(`Error: --aspect-ratio ${aspectRatio} is not supported by ${model.id}. Supported: ${constraints.aspectRatios.join(', ')}.`)
  }
  if (aspectRatio && constraints.aspectRatios === null) {
    if (constraints.widthHeightDivisor != null) {
      // Pixel-based models size through the hardcoded ratio list; the pixels
      // are derived, never passed to the API.
      if (!SIZE_PRESET_RATIOS.includes(aspectRatio)) {
        throw new CliError(`Error: --aspect-ratio ${aspectRatio} is not supported by ${model.id}. Supported: ${SIZE_PRESET_RATIOS.join(', ')}.`)
      }
    } else {
      throw new CliError(`Error: --aspect-ratio ${aspectRatio} is not supported by ${model.id}.`)
    }
  }
  if (format && Array.isArray(constraints.formats) && !constraints.formats.includes(format)) {
    throw new CliError(`Error: --image-format ${format} is not supported by ${model.id}. Supported: ${constraints.formats.join(', ')}.`)
  }
  if (format && constraints.formats === null) {
    throw new CliError(`Error: --image-format ${format} is not supported by ${model.id}.`)
  }
  if (resolution && Array.isArray(constraints.resolutions) && !constraints.resolutions.includes(resolution)) {
    throw new CliError(`Error: --resolution ${resolution} is not supported by ${model.id}. Supported: ${constraints.resolutions.join(', ')}.`)
  }
  if (quality && Array.isArray(constraints.qualities) && !constraints.qualities.includes(quality)) {
    throw new CliError(`Error: --quality ${quality} is not supported by ${model.id}. Supported: ${constraints.qualities.join(', ')}.`)
  }
  if (variants != null && constraints.maxN != null && variants > constraints.maxN) {
    throw new CliError(`Error: --variants ${variants} is not supported by ${model.id}. Supported: 1-${constraints.maxN}.`)
  }
  if (constraints.widthHeightDivisor != null) {
    for (const [flag, value] of [['--width', width], ['--height', height]]) {
      if (value != null && value % constraints.widthHeightDivisor !== 0) {
        throw new CliError(`Error: ${flag} ${value} must be divisible by ${constraints.widthHeightDivisor} for ${model.id}.`)
      }
    }
  }
}

function sizingDropNote(kind, value, modelId) {
  return `note: saved ${kind} ${value} is not supported by ${modelId}; it was not sent.`
}

// Applies a saved default only when the model supports it. A null list
// means the model cannot take the parameter at all (OpenRouter models
// without the param); the default is dropped with a visible note instead
// of being sent blindly.
function applySizingDefault(list, value, kind, modelId) {
  if (value === undefined) return { value: undefined, note: null }
  if (Array.isArray(list) && list.includes(value)) return { value, note: null }
  return { value: undefined, note: sizingDropNote(kind, value, modelId) }
}

function ratioPreselect(list, savedDefault, modelDefault) {
  if (savedDefault && list.includes(savedDefault)) return savedDefault
  if (modelDefault && list.includes(modelDefault)) return modelDefault
  if (list.includes('auto')) return 'auto'
  return undefined
}

// Pixel-based models get the same picker as aspect models but over the
// hardcoded preset list; the saved ratio is preselected when it is a preset,
// else 1:1.
function pixelRatioPreselect(presets, savedDefault) {
  if (savedDefault && presets.some((p) => p.ratio === savedDefault)) return savedDefault
  const oneToOne = presets.find((p) => p.ratio === '1:1')
  return oneToOne ? oneToOne.ratio : presets[0]?.ratio
}

function formatPreselect(list, savedDefault, providerName) {
  if (savedDefault && list.includes(savedDefault)) return savedDefault
  const fallback = providerName === 'venice' ? 'webp' : 'png'
  if (list.includes(fallback)) return fallback
  return undefined
}

export async function runImageGeneration({ provider, apiKey, prompt, opts = {}, prefs = {}, sessionId, sizingInteractive, model = null, stdout = process.stdout }) {
  const picker = selectImageModel
  const sizingPicker = selectSizingOption
  const providerName = provider.meta.name

  let resolved = model
  let modelId = (resolved?.modelId ?? resolved?.id) || opts.imageModel || null
  if (!resolved && opts.imageModel) {
    resolved = await selectImageModelNonInteractive({ provider, apiKey, imageModelId: opts.imageModel })
  } else if (!resolved && stdout.isTTY === true && process.stdin.isTTY === true) {
    // The picker needs a TTY on both streams: with piped stdin the prompt
    // would run against EOF and fail/hang instead of falling through.
    const models = await provider.fetchImageModels(apiKey)
    const chosen = await picker(models, prefs.lastImageModel)
    resolved = models.find((m) => m.id === chosen?.id) || null
    modelId = chosen?.id || null
  } else if (!resolved) {
    throw new CliError('Error: interactive model selection needs a TTY. Use --image-model <id> when piping input.')
  }
  if (!modelId) {
    throw new CliError('Error: no image model selected.')
  }

  // OpenRouter image models route through their own endpoints: pick a
  // provider (interactively on a TTY, cheapest otherwise) unless the model
  // already carries one from the selection layer or a resumed session.
  if (resolved && !resolved.imageProvider && typeof provider.fetchImageModelEndpoints === 'function') {
    const endpoint = await selectImageEndpoint({
      provider,
      apiKey,
      model: resolved,
      interactive: stdout.isTTY === true && process.stdin.isTTY === true,
    })
    if (endpoint) {
      resolved.imageProvider = endpoint.slug || endpoint.providerName
      resolved.endpointProviderName = endpoint.providerName
      resolved.pricing = endpoint.pricing || resolved.pricing
    }
  }

  let format
  let variants
  let aspectRatio
  let resolution
  let quality
  let seed
  let width
  let height
  try {
    format = resolveImageFormat(opts.imageFormat)
    variants = resolveVariants(opts.variants) ?? 1
    aspectRatio = resolveAspectRatio(opts.aspectRatio)
    resolution = resolveResolution(opts.resolution)
    quality = resolveQuality(opts.quality)
    seed = resolveSeed(opts.seed)
    width = resolveWidth(opts.width)
    height = resolveHeight(opts.height)
  } catch (err) {
    throw new CliError(`Error: ${err.message}`)
  }

  validateSizingConstraints(resolved, { aspectRatio, format, resolution, quality, width, height, variants })

  const savedDefaults = getImageDefaults(prefs, providerName)
  const interactive = sizingInteractive === true || (sizingInteractive !== false && stdout.isTTY === true && process.stdin.isTTY === true)
  const notes = []
  const prefsUpdates = {}
  let pickedRatio = false
  let pickedFormat = false

  if (interactive) {
    const ratios = resolved?.constraints?.aspectRatios
    if (aspectRatio === undefined && Array.isArray(ratios)) {
      aspectRatio = await sizingPicker('Select an aspect ratio:', ratios, ratioPreselect(ratios, savedDefaults.aspectRatio, resolved?.constraints?.defaultAspectRatio))
      pickedRatio = true
    }
    if (aspectRatio === undefined && isPixelModel(resolved)) {
      const presets = sizePresets(resolved)
      const labels = new Map(presets.map((p) => [p.ratio, sizeLabel(p)]))
      aspectRatio = await sizingPicker('Select an aspect ratio:', presets.map((p) => p.ratio), pixelRatioPreselect(presets, savedDefaults.aspectRatio), (ratio) => labels.get(ratio))
      pickedRatio = true
    }
    const formats = resolved?.constraints?.formats
    if (format === undefined && Array.isArray(formats)) {
      format = await sizingPicker('Select an image format:', formats, formatPreselect(formats, savedDefaults.format, providerName))
      pickedFormat = true
    }
  }

  if (!pickedRatio && opts.aspectRatio === undefined) {
    // Pixel-based models restrict the saved ratio to the hardcoded presets,
    // exactly like an aspect model restricts it to its advertised list.
    const ratios = isPixelModel(resolved) ? SIZE_PRESET_RATIOS : resolved?.constraints?.aspectRatios
    const applied = applySizingDefault(ratios, savedDefaults.aspectRatio, 'aspect ratio', resolved?.id)
    aspectRatio = applied.value
    if (applied.note) notes.push(applied.note)
  }
  if (!pickedFormat && opts.imageFormat === undefined) {
    const formats = resolved?.constraints?.formats
    if (savedDefaults.format) {
      const applied = applySizingDefault(formats, savedDefaults.format, 'format', resolved?.id)
      format = applied.value
      if (applied.note) notes.push(applied.note)
    } else if (Array.isArray(formats)) {
      const fallback = providerName === 'venice' ? 'webp' : 'png'
      if (formats.includes(fallback)) format = fallback
    }
  }

  if (opts.resolution === undefined) {
    const applied = applySizingDefault(resolved?.constraints?.resolutions, savedDefaults.resolution, 'resolution', resolved?.id)
    resolution = applied.value
    if (applied.note) notes.push(applied.note)
  }
  if (opts.quality === undefined) {
    const applied = applySizingDefault(resolved?.constraints?.qualities, savedDefaults.quality, 'quality', resolved?.id)
    quality = applied.value
    if (applied.note) notes.push(applied.note)
  }
  if (opts.variants === undefined && savedDefaults.variants != null) {
    if (resolved?.constraints?.maxN != null && savedDefaults.variants > resolved.constraints.maxN) {
      notes.push(sizingDropNote('variants', savedDefaults.variants, resolved.id))
    } else {
      variants = savedDefaults.variants
    }
  }

  if (opts.aspectRatio !== undefined) prefsUpdates.aspectRatio = aspectRatio
  else if (pickedRatio && aspectRatio !== savedDefaults.aspectRatio) prefsUpdates.aspectRatio = aspectRatio
  if (opts.imageFormat !== undefined) prefsUpdates.format = format
  else if (pickedFormat && format !== savedDefaults.format) prefsUpdates.format = format
  for (const note of notes) console.warn(note)

  // Pixel-based models take width/height in multiples of their divisor, never
  // aspect_ratio (they ignore it and return a square default): derive the
  // pixels from the ratio and drop the parameter. Explicit --width/--height
  // win over a saved ratio.
  if (aspectRatio !== undefined && isPixelModel(resolved)) {
    if (width === undefined && height === undefined) {
      const computed = computePixelSize(aspectRatio, resolved.constraints.widthHeightDivisor)
      width = computed.width
      height = computed.height
    }
    aspectRatio = undefined
  }

  const loader = createLoader({ stdout })
  loader.start(variants > 1 ? `Generating image (${variants} variants)` : 'Generating image')
  let result
  try {
    result = await provider.generateImage({
      apiKey,
      model: modelId,
      prompt,
      format,
      variants,
      safeMode: opts.safeMode !== false && prefs.safeMode !== false,
      hideWatermark: opts.watermark === false || prefs.hideWatermark === true,
      aspectRatio,
      resolution,
      quality,
      seed,
      width,
      height,
      provider: resolved?.imageProvider || undefined,
      pricing: resolved?.pricing || null,
    })
  } finally {
    loader.stop({ done: true })
  }

  const dir = attachmentDirFor(SESSIONS_DIR, sessionId)
  const message = {
    role: 'assistant',
    content: result.images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
  }
  const [externalized] = await externalizeAttachments([message], dir)
  const savedPaths = (externalized.content || []).map((part) => savedAttachmentPath(part.image_url.url, sessionId)).filter(Boolean)

  if (opts.outputDir) {
    try {
      await mkdir(opts.outputDir, { recursive: true })
      for (const src of savedPaths) {
        await copyFile(src, join(opts.outputDir, basename(src)))
      }
    } catch (err) {
      console.warn(`Warning: could not copy images to ${opts.outputDir}: ${err.message}`)
    }
  }

  const count = result.images.length
  const unit = result.cost
  let costLine = null
  if (unit != null) {
    costLine = `Cost: $${String(Math.round(unit * 1000) / 1000)} per image × ${count} = $${String(Math.round(unit * count * 10000) / 10000)}`
  }

  const sizingParts = []
  if (aspectRatio) sizingParts.push(aspectRatio)
  else if (width != null && height != null) sizingParts.push(formatSize(width, height))
  if (format) sizingParts.push(format)

  return {
    message: externalized,
    savedPaths,
    blurred: result.blurred === true,
    costLine,
    modelId,
    endpointProviderName: resolved?.endpointProviderName || provider.meta.name,
    pricing: resolved?.pricing || null,
    ...(Object.keys(prefsUpdates).length > 0 && { prefsUpdates }),
    ...(sizingParts.length > 0 && { sizing: sizingParts.join(' · ') }),
  }
}

export function printImageOutcome({ savedPaths = [], blurred = false, costLine = null, sizing = null } = {}, stdout = process.stdout) {
  for (const path of savedPaths) {
    stdout.write(`saved to ${path}\n`)
  }
  if (sizing) stdout.write(`${sizing}\n`)
  if (costLine) stdout.write(`${costLine}\n`)
  if (blurred) process.stderr.write('Warning: the generated image was returned blurred (safe mode).\n')
}

export function buildImageSessionPayload({ messages, modelId, createdAt, providerName = 'venice', endpointProviderName = providerName, pricing = null }) {
  return buildSessionPayload({
    messages,
    modelId,
    endpointProviderName,
    providerType: providerName,
    reasoningEffort: 'auto',
    temperature: null,
    budget: null,
    webSearch: 'off',
    webResults: null,
    pricing,
    contextLength: null,
    isImageModel: true,
    createdAt,
  })
}

export async function finalizeImageSession({ prefs, opts = {}, config, sessionId, messages, outcome, createdAt, providerName = 'venice', stdout = process.stdout }) {
  await persistSessionFile(sessionId, buildImageSessionPayload({ messages, modelId: outcome.modelId, createdAt, providerName, endpointProviderName: outcome.endpointProviderName, pricing: outcome.pricing }))
  const updated = applyPreferenceUpdates(prefs, {
    lastImageModel: outcome.modelId,
    outputDir: opts.outputDir,
    hideWatermark: opts.watermark === false ? true : undefined,
    safeMode: opts.safeMode === false ? false : undefined,
  })
  try {
    await savePreferences(mergeImageDefaults(updated, providerName, outcome.prefsUpdates), config)
  } catch (err) {
    // prefs save failures are non-fatal: the session already persisted
    console.warn(`Warning: could not save preferences: ${err.message}`)
  }
  printImageOutcome(outcome, stdout)
}

// /watermark handler for the image-session REPL: toggles the global Venice
// watermark preference. The caller wraps the provided saver so only the
// changed key is applied to the full prefs object.
export async function handleWatermarkCommand({ providerName, args, prefs, savePrefs, out = console.log, errOut = console.error }) {
  if (providerName !== 'venice') {
    errOut('Error: /watermark is only supported on Venice sessions.\n')
    return
  }
  if (!args) {
    out(`Venice watermark is ${prefs.hideWatermark === true ? 'off' : 'on'}.\n`)
    return
  }
  if (args === 'on' || args === 'off') {
    const next = args === 'on'
    prefs.hideWatermark = !next
    await savePrefs({ hideWatermark: !next })
    out(`Venice watermark ${next ? 'enabled' : 'disabled'}.\n`)
    return
  }
  errOut('Error: /watermark expects "on" or "off".\n')
}

export async function imageGenCmd({ apiKey, opts, prefs, providerType, prompt, stdout = process.stdout }) {
  const provider = getProvider(providerType)
  const stdinPiped = !process.stdin.isTTY

  let text = prompt
  if (!text && stdinPiped) {
    text = await readStdin()
  }
  if (!text) {
    throw new CliError(NO_PROMPT_MESSAGE)
  }

  // createdAt comes from createNewSession, not generation-end time: the id
  // encodes the true session creation moment and the export header shows it.
  const { dir, sessionId, createdAt } = await createNewSession()

  let outcome
  try {
    outcome = await runImageGeneration({ provider, apiKey, prompt: text, opts, prefs, sessionId, stdout })
  } catch (err) {
    await removeEmptySessionClaim(dir, sessionId)
    if (err instanceof CliError || err instanceof ExitPromptError) throw err
    throw new CliError(`Error: ${formatError(err)}`)
  }

  const messages = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: text },
    outcome.message,
  ]

  await finalizeImageSession({
    prefs,
    opts,
    config: opts.config,
    sessionId,
    messages,
    outcome,
    createdAt,
    providerName: providerType,
    stdout,
  })
}
