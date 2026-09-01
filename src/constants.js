import { homedir } from 'node:os'
import { join } from 'node:path'

export const THIN_SEP = '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'

export const DATA_DIR = join(homedir(), '.communicator')

export const SESSIONS_DIR = join(DATA_DIR, 'sessions')

export const DEFAULT_CONFIG_FILE = join(homedir(), '.communicator.json')

export const DEFAULT_SYSTEM_PROMPT_FILE = join(homedir(), '.communicator-system-prompt.md')

export const MAX_TEMPERATURE = 2

export const MAX_TOP_P = 1

export const DEFAULT_WEB_SEARCH_RESULTS = 10

export const MAX_WEB_SEARCH_RESULTS = 20

// Venice web scraping is billed per request regardless of content size.
export const SCRAPE_COST_USD = 0.01

// Scraped pages are truncated at this many characters before they enter the
// conversation context (pages are full-page markdown and can be huge).
export const MAX_SCRAPE_CHARS = 200_000

export const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024

export const MAX_FILE_ATTACHMENT_BYTES = 25 * 1024 * 1024

// Hard cap on one streamed model response: text plus embedded data-URL parts
// stay far below this; it only trips on a hostile or runaway stream (infinite
// slow-drip or a giant newline-less chunk line).
export const MAX_STREAM_BYTES = 128 * 1024 * 1024

export const MAX_INLINE_TEXT_ATTACHMENT_BYTES = 256 * 1024

// A single answer can name an unbounded number of artifacts (structured parts
// or markdown images in model-authored text), and every one becomes an
// outbound download holding up to MAX_FILE_ATTACHMENT_BYTES in memory. The
// cap and the concurrency bound keep one response from exhausting sockets and
// heap, and from turning the client into a request amplifier.
export const MAX_PRODUCED_PARTS = 16

export const ARTIFACT_DOWNLOAD_CONCURRENCY = 4

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

// Sampling params are only sent when explicitly set: unset sessions omit them
// from the request so the provider applies its own default.
export function formatSamplingValue(value) {
  return value ?? 'default'
}

export const LOADER_GRACE_MS = 200

export const LOADER_TICK_MS = 150

export const STREAM_IDLE_TIMEOUT_MS = 60_000

export const IMAGE_FORMATS = new Set(['png', 'jpeg', 'webp'])
export const IMAGE_RESOLUTIONS = new Set(['1K', '2K', '4K'])
export const IMAGE_QUALITIES = new Set(['low', 'medium', 'high'])
export const MAX_IMAGE_DIMENSION = 1280
export const MAX_SEED = 999999999

// Image generations are synchronous and queue on the provider: live runs
// took ~20 s to 2 min, far beyond the default 30 s request timeout.
export const IMAGE_GEN_TIMEOUT_MS = 600_000

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'

export const VENICE_BASE = 'https://api.venice.ai/api/v1'

export const EFFORT_LABELS = {
  max: 'X-High (max)',
  xhigh: 'X-High',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  minimal: 'Minimal',
  none: 'Disabled',
}

export const SSE_DONE = '[DONE]'

export const CITATION_GROUP = '(\\d+(?:,\\d+)*)'

export function formatCost(cost) {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return 'N/A'
  if (cost === 0) return '$0.000000'
  if (cost < 0.000001) return '< $0.000001'
  return `$${cost.toFixed(6)}`
}
