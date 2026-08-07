import { basename, join } from 'node:path'
import { copyFile, mkdir } from 'node:fs/promises'
import { getProvider } from '../providers/index.js'
import { ensureSessionsDir, generateSessionId, persistSessionFile, buildSessionPayload } from '../sessions.js'
import { attachmentDirFor, externalizeAttachments, savedAttachmentPath } from '../attachment-store.js'
import { selectImageModelNonInteractive } from '../model-selection.js'
import { selectImageModel, selectSizingOption } from '../prompts.js'
import { SESSIONS_DIR } from '../constants.js'
import { CliError, formatError } from '../errors.js'
import { readStdin } from '../cli-utils.js'
import { getImageDefaults, mergeImageDefaults, savePreferences, applyPreferenceUpdates } from '../config.js'
import { createLoader } from '../ui/loader.js'
import { resolveAspectRatio, resolveHeight, resolveImageFormat, resolveQuality, resolveResolution, resolveSeed, resolveVariants, resolveWidth } from '../flags.js'

function validateSizingConstraints(model, { aspectRatio, format, resolution, quality, width, height }) {
  if (!model) return
  const constraints = model.constraints || {}
  if (aspectRatio && Array.isArray(constraints.aspectRatios) && !constraints.aspectRatios.includes(aspectRatio)) {
    throw new CliError(`Error: --aspect-ratio ${aspectRatio} is not supported by ${model.id}. Supported: ${constraints.aspectRatios.join(', ')}.`)
  }
  if (format && Array.isArray(constraints.formats) && !constraints.formats.includes(format)) {
    throw new CliError(`Error: --image-format ${format} is not supported by ${model.id}. Supported: ${constraints.formats.join(', ')}.`)
  }
  if (resolution && Array.isArray(constraints.resolutions) && !constraints.resolutions.includes(resolution)) {
    throw new CliError(`Error: --resolution ${resolution} is not supported by ${model.id}. Supported: ${constraints.resolutions.join(', ')}.`)
  }
  if (quality && Array.isArray(constraints.qualities) && !constraints.qualities.includes(quality)) {
    throw new CliError(`Error: --quality ${quality} is not supported by ${model.id}. Supported: ${constraints.qualities.join(', ')}.`)
  }
  if (constraints.widthHeightDivisor != null) {
    for (const [flag, value] of [['--width', width], ['--height', height]]) {
      if (value != null && value % constraints.widthHeightDivisor !== 0) {
        throw new CliError(`Error: ${flag} ${value} must be divisible by ${constraints.widthHeightDivisor} for ${model.id}.`)
      }
    }
  }
}

export function sizingDropNote(kind, value, modelId) {
  return `note: saved ${kind} ${value} is not supported by ${modelId}; it was not sent.`
}

// Applies a saved default only when the model supports it. A null list
// means the model cannot take the parameter at all (OpenRouter models that
// lack the param entirely); Venice models without an advertised list pass
// the value through as before.
function applySizingDefault(list, value, providerName, kind, modelId) {
  if (value === undefined) return { value: undefined, note: null }
  if (Array.isArray(list)) {
    if (list.includes(value)) return { value, note: null }
    return { value: undefined, note: sizingDropNote(kind, value, modelId) }
  }
  if (providerName === 'openrouter') {
    return { value: undefined, note: sizingDropNote(kind, value, modelId) }
  }
  return { value, note: null }
}

function ratioPreselect(list, savedDefault, modelDefault) {
  if (savedDefault && list.includes(savedDefault)) return savedDefault
  if (modelDefault && list.includes(modelDefault)) return modelDefault
  if (list.includes('auto')) return 'auto'
  return undefined
}

function formatPreselect(list, savedDefault, providerName) {
  if (savedDefault && list.includes(savedDefault)) return savedDefault
  const fallback = providerName === 'venice' ? 'webp' : 'png'
  if (list.includes(fallback)) return fallback
  return undefined
}

export async function runImageGeneration({ provider, apiKey, prompt, opts = {}, prefs = {}, sessionId, selectImage, selectImageSizing, sizingInteractive, model = null, stdout = process.stdout }) {
  const picker = selectImage ?? selectImageModel
  const sizingPicker = selectImageSizing ?? selectSizingOption
  const providerName = provider.meta.name

  let resolved = model
  let modelId = (resolved?.modelId ?? resolved?.id) || opts.imageModel || null
  if (!resolved && opts.imageModel) {
    resolved = await selectImageModelNonInteractive({ provider, apiKey, imageModelId: opts.imageModel })
  } else if (!resolved && (selectImage || stdout.isTTY === true)) {
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

  validateSizingConstraints(resolved, { aspectRatio, format, resolution, quality, width, height })

  const savedDefaults = getImageDefaults(prefs, providerName)
  const interactive = sizingInteractive === true || (sizingInteractive !== false && (selectImage != null || stdout.isTTY === true))
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
    const formats = resolved?.constraints?.formats
    if (format === undefined && Array.isArray(formats)) {
      format = await sizingPicker('Select an image format:', formats, formatPreselect(formats, savedDefaults.format, providerName))
      pickedFormat = true
    }
  }

  if (!pickedRatio && opts.aspectRatio === undefined) {
    const applied = applySizingDefault(resolved?.constraints?.aspectRatios, savedDefaults.aspectRatio, providerName, 'aspect ratio', resolved?.id)
    aspectRatio = applied.value
    if (applied.note) notes.push(applied.note)
  }
  if (!pickedFormat && opts.imageFormat === undefined) {
    const formats = resolved?.constraints?.formats
    if (savedDefaults.format) {
      const applied = applySizingDefault(formats, savedDefaults.format, providerName, 'format', resolved?.id)
      format = applied.value
      if (applied.note) notes.push(applied.note)
    } else if (Array.isArray(formats)) {
      const fallback = providerName === 'venice' ? 'webp' : 'png'
      if (formats.includes(fallback)) format = fallback
    }
  }

  if (opts.aspectRatio !== undefined) prefsUpdates.aspectRatio = aspectRatio
  else if (pickedRatio && aspectRatio !== savedDefaults.aspectRatio) prefsUpdates.aspectRatio = aspectRatio
  if (opts.imageFormat !== undefined) prefsUpdates.format = format
  else if (pickedFormat && format !== savedDefaults.format) prefsUpdates.format = format
  for (const note of notes) console.warn(note)

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
      safeMode: opts.safeMode !== false,
      hideWatermark: opts.watermark === false || prefs.hideWatermark === true,
      aspectRatio,
      resolution,
      quality,
      seed,
      width,
      height,
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
  if (format) sizingParts.push(format)

  return {
    message: externalized,
    savedPaths,
    blurred: result.blurred === true,
    costLine,
    modelId,
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

export function buildImageSessionPayload({ messages, modelId, createdAt, providerName = 'venice' }) {
  return buildSessionPayload({
    messages,
    modelId,
    endpointProviderName: providerName,
    providerType: providerName,
    reasoningEffort: 'auto',
    temperature: null,
    budget: null,
    webSearch: 'off',
    webResults: null,
    pricing: null,
    contextLength: null,
    createdAt,
  })
}

export async function finalizeImageSession({ prefs, opts = {}, config, sessionId, messages, outcome, createdAt, providerName = 'venice', stdout = process.stdout }) {
  await persistSessionFile(sessionId, buildImageSessionPayload({ messages, modelId: outcome.modelId, createdAt, providerName }))
  const updated = applyPreferenceUpdates(prefs, {
    lastImageModel: outcome.modelId,
    outputDir: opts.outputDir,
    hideWatermark: opts.watermark === false ? true : undefined,
  })
  await savePreferences(mergeImageDefaults(updated, providerName, outcome.prefsUpdates), config)
  printImageOutcome(outcome, stdout)
}

export async function imageGenCmd({ apiKey, opts, prefs, providerType, prompt, stdout = process.stdout }) {
  const provider = getProvider(providerType)
  const stdinPiped = !process.stdin.isTTY

  let text = prompt
  if (!text && stdinPiped) {
    text = await readStdin()
  }
  if (!text) {
    throw new CliError('Error: no prompt provided. Pass a prompt argument or pipe input via stdin.')
  }

  const dir = await ensureSessionsDir()
  const sessionId = await generateSessionId(dir)

  let outcome
  try {
    outcome = await runImageGeneration({ provider, apiKey, prompt: text, opts, prefs, sessionId, stdout })
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(`Error: ${formatError(err)}`)
  }

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
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
    createdAt: new Date().toISOString(),
    providerName: providerType,
    stdout,
  })
}
