import { dim, cyan, green } from './style.js'
import { LOADER_GRACE_MS, LOADER_TICK_MS } from '../constants.js'
import { formatCompactCount, formatElapsedSeconds } from './format.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Shared spinner machine (grace window before the line appears, braille tick,
 * timer hygiene). The label line itself is supplied by the caller via
 * `drawLine`, but the lifecycle is identical for the loader and the
 * compact-thinking meter.
 */
function createSpinner({ stdout, graceMs, tickMs, drawLine }) {
  let frames = 0
  let shown = false
  let graceTimer = null
  let tickTimer = null

  const draw = () => {
    stdout.write(drawLine(SPINNER_FRAMES[frames % SPINNER_FRAMES.length]) + '\x1b[K')
  }

  const scheduleTick = () => {
    tickTimer = setTimeout(() => {
      frames += 1
      draw()
      scheduleTick()
    }, tickMs)
    tickTimer.unref?.()
  }

  const stopTimers = () => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    if (tickTimer !== null) {
      clearTimeout(tickTimer)
      tickTimer = null
    }
  }

  return {
    start() {
      frames = 0
      if (shown) {
        draw()
        return
      }
      if (graceTimer !== null) return
      graceTimer = setTimeout(() => {
        graceTimer = null
        shown = true
        draw()
        scheduleTick()
      }, graceMs)
      graceTimer.unref?.()
    },
    stopTimers,
    isShown() {
      return shown
    },
    hide() {
      shown = false
    },
  }
}

export function createLoader({ stdout = process.stdout, graceMs = LOADER_GRACE_MS, tickMs = LOADER_TICK_MS } = {}) {
  let label = ''
  const spinner = createSpinner({
    stdout,
    graceMs,
    tickMs,
    drawLine: (frame) => `\r${dim(label)} ${cyan(frame)}`,
  })
  return {
    start(nextLabel) {
      label = nextLabel
      spinner.start()
    },
    // Returns true only when `done` actually wrote the green checkpoint
    // line (the spinner was visible): a bare stop, a stop after an instant
    // reply (nothing within the grace window) and a non-TTY stop all return
    // false, so callers can add the one blank row below the checkpoint
    // exactly once and never introduce a stray blank in those cases.
    stop({ done = false } = {}) {
      spinner.stopTimers()
      if (!spinner.isShown()) return false
      spinner.hide()
      if (done) {
        stdout.write(`\r${green('✓')} ${label}\x1b[K\n`)
        return true
      }
      stdout.write('\r\x1b[K')
      return false
    },
  }
}

// The compact-thinking indicator: the same line format as the loader (dim
// label + cyan braille spinner), but the label carries a live count of the
// reasoning characters received so far and the elapsed thinking time. `update`
// only bumps the counter; the next tick paints it (and the seconds), so
// reasoning bursts never flood the terminal with rewrites. `stop({ done: true
// })` always resolves the line to a green checkpoint — even when thinking
// finished inside the grace window, so the final transcript is deterministic
// (`✓ Thinking · N · 3s`).
export function createThinkingMeter({ stdout = process.stdout, graceMs = LOADER_GRACE_MS, tickMs = LOADER_TICK_MS, label = 'Thinking', now = () => performance.now() } = {}) {
  let count = 0
  let startedAt = 0
  let elapsed = 0
  let stopped = true
  const meterLine = (running) => {
    const seconds = formatElapsedSeconds(running ? now() - startedAt : elapsed)
    return `${label} · ${formatCompactCount(count)} · ${seconds}`
  }
  const spinner = createSpinner({
    stdout,
    graceMs,
    tickMs,
    drawLine: (frame) => `\r${dim(meterLine(true))} ${cyan(frame)}`,
  })
  return {
    start() {
      count = 0
      startedAt = now()
      stopped = false
      spinner.start()
    },
    update(chars) {
      count += chars
    },
    stop({ done = false } = {}) {
      if (stopped) return
      stopped = true
      elapsed = now() - startedAt
      spinner.stopTimers()
      if (done) {
        stdout.write(`\r${green('✓')} ${meterLine(false)}\x1b[K\n`)
        spinner.hide()
        return
      }
      if (spinner.isShown()) stdout.write('\r\x1b[K')
      spinner.hide()
    },
  }
}
