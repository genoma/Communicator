import { WEB_SEARCH_MODES } from './flags.js'

const SESSION_FLAGS_LIST = '--temperature, --top-p, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --system-prompt, --rpg, --attach, --scrape'

export function hasAttachments(opts) {
  return (opts.attach?.length ?? 0) > 0
}

export function isInteractiveFlag(opts) {
  // Bare --resume next to --rpg continues a story chapter: the chapter picker
  // only opens when more than one chapter exists and stdin is a TTY, while
  // piped/prompt one-shots fall back to the most recent chapter, so it never
  // needs a TTY here.
  return (opts.resume !== undefined && opts.rpg === undefined) || opts.export !== undefined || opts.delete !== undefined
}

export function isExitMode(opts) {
  return Boolean(opts.listModels || opts.listImageModels || opts.listEndpoints !== undefined || opts.listSessions)
}

export function isSessionOnly(opts) {
  return (
    opts.temperature !== undefined ||
    opts.topP !== undefined ||
    opts.budget !== undefined ||
    opts.reasoningEffort !== undefined ||
    opts.webSearch !== undefined ||
    opts.webResults !== undefined ||
    opts.smoothSpeed !== undefined ||
    opts.smoothStreaming === false ||
    opts.compactThinking === true ||
    opts.systemPrompt !== undefined ||
    opts.rpg !== undefined ||
    hasAttachments(opts) ||
    opts.scrape !== undefined
  )
}

export function hasConfigSetterFlags(opts) {
  return (
    opts.model !== undefined ||
    opts.outputDir !== undefined ||
    opts.temperature !== undefined ||
    opts.topP !== undefined ||
    opts.budget !== undefined ||
    opts.reasoningEffort !== undefined ||
    opts.webSearch !== undefined ||
    opts.webResults !== undefined ||
    opts.smoothSpeed !== undefined ||
    opts.smoothStreaming === false ||
    opts.compactThinking === true ||
    opts.watermark === false ||
    opts.aspectRatio !== undefined ||
    opts.imageFormat !== undefined
  )
}

// Flags that are ONLY config setters (never session flags): piped stdin can
// never be a prompt for them, so the config-set path may run without a TTY.
export function isPureConfigSetter(opts) {
  return (
    opts.aspectRatio !== undefined ||
    opts.imageFormat !== undefined ||
    opts.watermark === false ||
    opts.safeMode === false
  )
}

export function isConfigSetter(opts) {
  return hasConfigSetterFlags(opts) || opts.safeMode === false
}

// The two set-and-exit dispatches in src/cli-main.js only persist a
// preference: no session, no request. Validation shares this predicate so it
// never gates a flag on a run that cannot use it.
export function isConfigSetDispatch(opts, { promptArg, isTTY }) {
  // --system-prompt and --scrape shape a chat session, not a preference:
  // with either present this is a chat launch on every input mode, otherwise
  // the set-and-exit dispatch would drop the flag unread.
  if (opts.systemPrompt !== undefined || opts.scrape !== undefined) return false
  if (isTTY) {
    const onlySafeModeSetter = opts.safeMode === false && !hasConfigSetterFlags(opts)
    return isConfigSetter(opts) && !onlySafeModeSetter && opts.rpg === undefined && !promptArg && opts.resume === undefined && opts.image !== true
  }
  // Pure config-setter flags have no session meaning, so piped stdin can never
  // be a prompt for them; -m is excluded because piped stdin means one-shot.
  return !promptArg && opts.model === undefined && opts.resume === undefined && opts.image !== true && opts.rpg === undefined && isPureConfigSetter(opts)
}

const exclusionError = (prefix, forbidden) =>
  `Error: ${prefix} and the session flags (${SESSION_FLAGS_LIST}) cannot be combined with ${forbidden}.`

// Flags an exit path (--list-*, --export, --delete, --delete-all-sessions)
// exits before honoring: --zdr/--e2ee shape a chat session, and the pure prefs
// are only written by the set-and-exit dispatch. Only flags actually passed
// are named.
function exitIgnoredFlags(opts) {
  const flags = ['zdr', 'e2ee'].filter((flag) => opts[flag] === true).map((flag) => `--${flag}`)
  if (opts.watermark === false) flags.push('--no-watermark')
  if (opts.safeMode === false) flags.push('--no-safe-mode')
  if (opts.aspectRatio !== undefined) flags.push('--aspect-ratio')
  if (opts.imageFormat !== undefined) flags.push('--image-format')
  return flags
}

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
    opts.rpg !== undefined ||
    opts.reasoningEffort !== undefined ||
    opts.temperature !== undefined ||
    opts.topP !== undefined ||
    opts.budget !== undefined ||
    opts.webSearch !== undefined ||
    opts.webResults !== undefined ||
    opts.smoothStreaming === false ||
    opts.smoothSpeed !== undefined ||
    opts.compactThinking === true ||
    opts.watermark === false ||
    opts.safeMode === false ||
    opts.aspectRatio !== undefined ||
    opts.imageFormat !== undefined ||
    opts.delete !== undefined ||
    opts.deleteAllSessions !== undefined ||
    opts.image === true ||
    opts.e2ee === true ||
    opts.zdr === true ||
    hasAttachments(opts) ||
    opts.scrape !== undefined
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

  // A resumed run executes on the provider saved in its session, so only the
  // resolved provider can decide this (src/session-setup.js).
  if (opts.e2ee === true && opts.provider !== 'venice' && opts.resume === undefined) {
    errors.push('Error: --e2ee is only available with --provider venice.')
  }

  // A resumed run executes on the provider saved in its session, so only the
  // resolved provider can decide this (src/session-setup.js).
  if (opts.zdr === true && opts.provider !== 'openrouter' && opts.resume === undefined) {
    errors.push('Error: --zdr is only available with --provider openrouter.')
  }

  // Venice has no result-count knob: the flag would only flip its web search
  // to `auto`, turning billed search on while the count itself is dropped.
  // Neither a resumed run (the provider comes from the session) nor a
  // set-and-exit dispatch (no request at all) is decided by the flag's own
  // --provider; the resolved provider is checked in src/session-setup.js.
  const webResultsDeferred = opts.resume !== undefined || isConfigSetDispatch(opts, { promptArg, isTTY })
  if (opts.webResults !== undefined && opts.provider !== 'openrouter' && !webResultsDeferred) {
    errors.push('Error: --web-results is only available with --provider openrouter.')
  }

  if (opts.e2ee === true && opts.zdr === true) {
    errors.push('Error: --e2ee cannot be combined with --zdr.')
  }

  if (opts.e2ee === true && (opts.webSearch !== undefined || opts.webResults !== undefined)) {
    errors.push('Error: --e2ee cannot be combined with --web-search or --web-results (E2EE does not support web search).')
  }

  if (opts.e2ee === true && hasAttachments(opts)) {
    errors.push('Error: --e2ee cannot be combined with --attach (E2EE does not support file uploads).')
  }

  if (opts.e2ee === true && opts.image === true) {
    errors.push('Error: --e2ee cannot be combined with --image (E2EE is text-only).')
  }

  if (opts.e2ee === true && opts.scrape !== undefined) {
    errors.push('Error: --e2ee cannot be combined with --scrape (E2EE does not support web scraping).')
  }

  if (opts.rpg !== undefined && opts.systemPrompt !== undefined) {
    errors.push('Error: --rpg cannot be combined with --system-prompt.')
  }

  if (typeof opts.rpg === 'string' && opts.rpg.startsWith('-')) {
    errors.push(`Error: --rpg expects a directory argument (got "${opts.rpg}").`)
  }

  if (opts.debug === true && opts.rpg === undefined) {
    errors.push('Error: --debug requires --rpg.')
  }

  if (opts.rpg !== undefined && opts.resume !== undefined && opts.resume !== true) {
    errors.push("Error: --rpg --resume does not take a session id (the story resumes from the RPG directory's chapter sessions, or its history.json for stories saved before that layout).")
  }

  // A resumed run executes on the provider saved in its session, so only the
  // resolved provider can decide this: the chapter resume path reaches
  // scrapeForSession in src/cli-main.js, which rejects a provider without
  // scrapePage.
  if (opts.scrape !== undefined && opts.provider !== 'venice' && opts.resume === undefined) {
    errors.push('Error: --scrape is only available with --provider venice.')
  }

  if (opts.exportFormat !== undefined && opts.export === undefined) {
    errors.push('Error: --export-format requires --export.')
  }

  if (opts.exportFormat !== undefined && opts.exportFormat !== 'markdown' && opts.exportFormat !== 'jsonl') {
    errors.push('Error: --export-format expects "markdown" or "jsonl".')
  }

  if (opts.resume !== undefined && opts.export !== undefined) {
    errors.push('Error: Cannot use --resume and --export together. Use one at a time.')
  }

  if (opts.delete !== undefined && (opts.resume !== undefined || opts.export !== undefined)) {
    errors.push('Error: Cannot use --delete with --resume or --export. Use one at a time.')
  }

  if (opts.deleteAllSessions !== undefined && (opts.resume !== undefined || opts.export !== undefined || opts.delete !== undefined)) {
    errors.push('Error: Cannot use --delete-all-sessions with --resume, --export or --delete. Use one at a time.')
  }

  if (promptArg && opts.deleteAllSessions !== undefined) {
    errors.push('Cannot combine a prompt argument with --delete-all-sessions.')
  }

  if (opts.deleteAllSessions !== undefined && exitModeFlags) {
    errors.push('Error: --delete-all-sessions cannot be combined with --list-* flags.')
  }

  if (opts.deleteAllSessions !== undefined && (sessionOnlyFlags || opts.model !== undefined || opts.outputDir !== undefined)) {
    errors.push(exclusionError('--model, --output-dir', '--delete-all-sessions'))
  }

  if (opts.image && opts.deleteAllSessions !== undefined) {
    errors.push('Error: --image cannot be combined with --delete-all-sessions.')
  }

  // The bare flag (boolean true from Commander) could not be confirmed without
  // a prompt; with piped stdin it would skip the TTY confirm and delete
  // everything silently. y/yes (a string) is the explicit non-interactive
  // confirmation and stays legal with piped stdin.
  if (opts.deleteAllSessions === true && !isTTY) {
    errors.push('Error: bare --delete-all-sessions needs a TTY (pass y to confirm non-interactively).')
  }

  if (promptArg && (interactiveFlags || exitModeFlags)) {
    errors.push('Cannot combine a prompt argument with --resume, --export, --delete, or --list-* flags.')
  }

  if (!isTTY && interactiveFlags) {
    errors.push('Cannot use --resume, --export, or --delete with piped stdin (interactive pickers need a TTY).')
  }

  if (exitModeFlags && (sessionOnlyFlags || opts.model !== undefined || opts.outputDir !== undefined)) {
    errors.push(exclusionError('--model, --output-dir', '--list-* flags'))
  }

  // --zdr/--e2ee and the pure prefs only shape a chat session or a persisted
  // preference, so next to an exit mode they are just as meaningless as the
  // session flags above. Only the flags actually passed are named.
  const exitIgnored = exitIgnoredFlags(opts)
  if (exitModeFlags && exitIgnored.length > 0) {
    errors.push(`Error: ${exitIgnored.join(' and ')} cannot be combined with --list-* flags.`)
  }

  if (opts.export !== undefined && (sessionOnlyFlags || opts.model !== undefined)) {
    errors.push(exclusionError('--model', '--export'))
  }

  if (opts.delete !== undefined && (sessionOnlyFlags || opts.model !== undefined || opts.outputDir !== undefined)) {
    errors.push(exclusionError('--model, --output-dir', '--delete'))
  }

  // --export, --delete and --delete-all-sessions read them even less than an
  // exit mode does, and --e2ee would otherwise still print the session-file
  // warning before those paths dispatch. --resume stays exempt: a resumed
  // session re-passes --zdr/--e2ee to keep its routing (docs/providers.md).
  if (exitIgnored.length > 0) {
    const exitPath = opts.export !== undefined ? '--export'
      : opts.delete !== undefined ? '--delete'
        : opts.deleteAllSessions !== undefined ? '--delete-all-sessions'
          : undefined
    if (exitPath !== undefined) {
      errors.push(`Error: ${exitIgnored.join(' and ')} cannot be combined with ${exitPath}.`)
    }
  }

  if (opts.resume !== undefined && opts.rpg === undefined && (opts.model !== undefined || opts.outputDir !== undefined || attachments || opts.scrape !== undefined)) {
    errors.push('Error: --model, --output-dir, --attach and --scrape cannot be combined with --resume (resumed sessions keep their own model; --output-dir only applies to --export).')
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

  // Generation-only flags are meaningless outside --image (image sessions
  // validate them on their own paths). --aspect-ratio and --image-format are
  // exempt: they double as persisted image defaults.
  const imageOnlyFlags = ['variants', 'seed', 'resolution', 'quality', 'width', 'height']
  const usedImageOnly = imageOnlyFlags.filter((f) => opts[f] !== undefined)
  if (opts.image !== true && usedImageOnly.length > 0) {
    errors.push(`Error: ${usedImageOnly.map((f) => `--${f}`).join(', ')} ${usedImageOnly.length === 1 ? 'requires' : 'require'} --image.`)
  }

  if (opts.image && (opts.resume !== undefined || opts.export !== undefined || opts.delete !== undefined || exitModeFlags)) {
    errors.push('Error: --image cannot be combined with --resume, --export, --delete, or --list-* flags.')
  }

  if (opts.image && (opts.model !== undefined || opts.zdr === true || sessionOnlyFlags)) {
    errors.push('Error: --image cannot be combined with chat session flags (--model, --attach, --system-prompt, --rpg, --temperature, --top-p, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming, --compact-thinking, --zdr, --scrape).')
  }

  if (opts.image && (opts.width !== undefined || opts.height !== undefined)) {
    if ((opts.width !== undefined) !== (opts.height !== undefined)) {
      errors.push('Error: --width and --height must be used together.')
    } else {
      if (opts.aspectRatio !== undefined) {
        errors.push('Error: --width and --height cannot be combined with --aspect-ratio.')
      }
      if (opts.resolution !== undefined) {
        errors.push('Error: --width and --height cannot be combined with --resolution.')
      }
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
