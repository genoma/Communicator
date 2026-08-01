import { homedir } from 'node:os'
import { join } from 'node:path'

export const THIN_SEP = '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'

export const SESSIONS_DIR = join(homedir(), '.communicator', 'sessions')

export const DEFAULT_CONFIG_FILE = join(homedir(), '.communicator.json')

export const DEFAULT_SYSTEM_PROMPT_FILE = join(homedir(), '.communicator-system-prompt.md')

export const DEFAULT_TEMPERATURE = 0.7

export const MAX_TEMPERATURE = 2

export const DEFAULT_WEB_SEARCH_RESULTS = 10

export const SMOOTH_CHARS_PER_TICK = 40

export const SMOOTH_TICK_MS = 20

export const SMOOTH_SPEED_PRESETS = { slow: 500, normal: 2000, fast: 8000 }

export const SMOOTH_DEFAULT_SPEED = 'normal'

export function cpsToCharsPerTick(cps, tickMs = SMOOTH_TICK_MS) {
  return Math.max(1, Math.round(cps * tickMs / 1000))
}

export function formatSmoothSpeed(cps) {
  const preset = Object.entries(SMOOTH_SPEED_PRESETS).find(([, value]) => value === cps)
  if (preset) return `${preset[0]}, ~${preset[1]} chars/s`
  return `${cps} chars/s`
}

export const LOADER_GRACE_MS = 200

export const LOADER_TICK_MS = 150

export const EFFORT_LABELS = {
  max: 'X-High (max)',
  xhigh: 'X-High',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  minimal: 'Minimal',
  none: 'Disabled',
}

export const SSE_DATA_PREFIX = 'data: '

export const SSE_DONE = '[DONE]'

export function formatCost(cost) {
  if (cost === null || cost === undefined) return 'N/A'
  if (cost < 0.000001) return '$0.000000'
  return `$${cost.toFixed(6)}`
}
