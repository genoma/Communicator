import { dim, cyan, green } from './style.js'
import { LOADER_GRACE_MS, LOADER_TICK_MS } from '../constants.js'
import { formatCompactCount } from './format.js'

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
    stop({ done = false } = {}) {
      spinner.stopTimers()
      if (!spinner.isShown()) return
      spinner.hide()
      if (done) {
        stdout.write(`\r${green('✓')} ${label}\x1b[K\n`)
        return
      }
      stdout.write('\r\x1b[K')
    },
  }
}

// The compact-thinking indicator: the same line format as the loader (dim
// label + cyan braille spinner), but the label carries a live count of the
// reasoning characters received so far. `update` only bumps the counter; the
// next tick paints it, so reasoning bursts never flood the terminal with
// rewrites. `stop({ done: true })` always resolves the line to a green
// checkpoint — even when thinking finished inside the grace window, so the
// final transcript is deterministic (`✓ Thinking · N`).
export function createThinkingMeter({ stdout = process.stdout, graceMs = LOADER_GRACE_MS, tickMs = LOADER_TICK_MS, label = 'Thinking' } = {}) {
  let count = 0
  let stopped = true
  const spinner = createSpinner({
    stdout,
    graceMs,
    tickMs,
    drawLine: (frame) => `\r${dim(`${label} · ${formatCompactCount(count)}`)} ${cyan(frame)}`,
  })
  return {
    start() {
      count = 0
      stopped = false
      spinner.start()
    },
    update(chars) {
      count += chars
    },
    stop({ done = false } = {}) {
      if (stopped) return
      stopped = true
      spinner.stopTimers()
      if (done) {
        stdout.write(`\r${green('✓')} ${label} · ${formatCompactCount(count)}\x1b[K\n`)
        spinner.hide()
        return
      }
      if (spinner.isShown()) stdout.write('\r\x1b[K')
      spinner.hide()
    },
  }
}
