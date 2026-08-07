import { WEB_SEARCH_MODES } from './flags.js'

const SESSION_FLAGS_LIST = '--temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --attach'

export function hasAttachments(opts) {
  return (opts.attach?.length ?? 0) > 0
}

export function isInteractiveFlag(opts) {
  return opts.resume !== undefined || opts.export !== undefined || opts.delete !== undefined
}

export function isExitMode(opts) {
  return Boolean(opts.listModels || opts.listImageModels || opts.listEndpoints !== undefined || opts.listSessions)
}

export function isSessionOnly(opts) {
  return (
    opts.temperature !== undefined ||
    opts.budget !== undefined ||
    opts.reasoningEffort !== undefined ||
    opts.webSearch !== undefined ||
    opts.webResults !== undefined ||
    opts.smoothSpeed !== undefined ||
    opts.smoothStreaming === false ||
    opts.systemPrompt !== undefined ||
    hasAttachments(opts)
  )
}

export function hasConfigSetterFlags(opts) {
  return (
    opts.model !== undefined ||
    opts.outputDir !== undefined ||
    opts.temperature !== undefined ||
    opts.budget !== undefined ||
    opts.reasoningEffort !== undefined ||
    opts.webSearch !== undefined ||
    opts.webResults !== undefined ||
    opts.smoothSpeed !== undefined ||
    opts.smoothStreaming === false ||
    opts.watermark === false ||
    opts.aspectRatio !== undefined ||
    opts.imageFormat !== undefined
  )
}

export function isConfigSetter(opts) {
  return hasConfigSetterFlags(opts) || opts.safeMode === false
}

const exclusionError = (prefix, forbidden) =>
  `Error: ${prefix} and the session flags (${SESSION_FLAGS_LIST}) cannot be combined with ${forbidden}.`

function hasBareConfigOtherFlags(opts, promptArg) {
  return (
    promptArg ||
    opts.model !== undefined ||
    opts.provider !== 'openrouter' ||
    opts.listModels ||
    opts.listImageModels ||
    opts.listEndpoints !== undefined ||
    opts.resume !== undefined ||
    opts.export !== undefined ||
    opts.outputDir !== undefined ||
    opts.listSessions ||
    opts.systemPrompt !== undefined ||
    opts.reasoningEffort !== undefined ||
    opts.temperature !== undefined ||
    opts.budget !== undefined ||
    opts.webSearch !== undefined ||
    opts.webResults !== undefined ||
    opts.smoothStreaming === false ||
    opts.smoothSpeed !== undefined ||
    opts.watermark === false ||
    opts.safeMode === false ||
    opts.aspectRatio !== undefined ||
    opts.imageFormat !== undefined ||
    opts.delete !== undefined ||
    opts.image === true ||
    hasAttachments(opts)
  )
}

// Flag-combination validation, in the same order main() previously checked
// them. Returns every violated message; callers surface the first one.
export function validateCliFlags(opts, { promptArg, isTTY }) {
  const errors = []
  const exitModeFlags = isExitMode(opts)
  const interactiveFlags = isInteractiveFlag(opts)
  const sessionOnlyFlags = isSessionOnly(opts)
  const attachments = hasAttachments(opts)

  if (opts.webSearch !== undefined && opts.webSearch !== true && !WEB_SEARCH_MODES.has(opts.webSearch)) {
    errors.push('Error: --web-search expects "auto", "always", "on", or "off" (bare flag = auto).')
  }

  if (opts.resume !== undefined && opts.export !== undefined) {
    errors.push('Cannot use --resume and --export together. Use one at a time.')
  }

  if (opts.delete !== undefined && (opts.resume !== undefined || opts.export !== undefined)) {
    errors.push('Cannot use --delete with --resume or --export. Use one at a time.')
  }

  if (promptArg && (interactiveFlags || exitModeFlags)) {
    errors.push('Cannot combine a prompt argument with --resume, --export, --delete, or --list-* flags.')
  }

  if (!isTTY && interactiveFlags) {
    errors.push('Cannot use --resume, --export, or --delete with piped stdin (interactive pickers need a TTY).')
  }

  if (exitModeFlags && (sessionOnlyFlags || opts.model !== undefined || opts.outputDir !== undefined)) {
    errors.push(exclusionError('--model, --output-dir, --system-prompt', '--list-* flags'))
  }

  if (opts.export !== undefined && (sessionOnlyFlags || opts.model !== undefined)) {
    errors.push(exclusionError('--model, --system-prompt', '--export'))
  }

  if (opts.delete !== undefined && (sessionOnlyFlags || opts.model !== undefined || opts.outputDir !== undefined)) {
    errors.push(exclusionError('--model, --output-dir, --system-prompt', '--delete'))
  }

  if (opts.resume !== undefined && (opts.model !== undefined || opts.outputDir !== undefined || attachments)) {
    errors.push('Error: --model, --output-dir and --attach cannot be combined with --resume (resumed sessions keep their own model; --output-dir only applies to --export).')
  }

  if (interactiveFlags && exitModeFlags) {
    errors.push('Error: --resume, --export and --delete cannot be combined with --list-* flags.')
  }

  if (opts.outputDir !== undefined && opts.export === undefined && opts.image !== true && (promptArg || !isTTY)) {
    errors.push('Error: --output-dir sets the default export directory. Use it alone (with a TTY) or with --export.')
  }

  if (opts.imageModel !== undefined && opts.image !== true) {
    errors.push('Error: --image-model requires --image.')
  }

  if (opts.image && (opts.resume !== undefined || opts.export !== undefined || opts.delete !== undefined || exitModeFlags)) {
    errors.push('Error: --image cannot be combined with --resume, --export, --delete, or --list-* flags.')
  }

  if (opts.image && (opts.model !== undefined || opts.zdr === true || sessionOnlyFlags)) {
    errors.push('Error: --image cannot be combined with chat session flags (--model, --attach, --system-prompt, --temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --zdr).')
  }

  if (opts.image && (opts.width !== undefined || opts.height !== undefined)) {
    if (opts.aspectRatio !== undefined) {
      errors.push('Error: --width and --height cannot be combined with --aspect-ratio.')
    }
    if (opts.resolution !== undefined) {
      errors.push('Error: --width and --height cannot be combined with --resolution.')
    }
  }

  if (opts.config === true && hasBareConfigOtherFlags(opts, promptArg)) {
    errors.push('Error: bare --config (config view) cannot be combined with other flags.')
  }

  if (attachments && !promptArg && isTTY) {
    errors.push('Error: --attach requires a prompt argument or piped stdin.')
  }

  return errors
}
