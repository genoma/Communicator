import { dim, cyan, green } from './style.js'
import { LOADER_GRACE_MS, LOADER_TICK_MS } from '../constants.js'
import { formatCompactCount } from './format.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function createLoader({ stdout = process.stdout, graceMs = LOADER_GRACE_MS, tickMs = LOADER_TICK_MS } = {}) {
  let label = ''
  let frames = 0
  let shown = false
  let graceTimer = null
  let tickTimer = null

  const draw = () => {
    stdout.write(`\r${dim(label)} ${cyan(SPINNER_FRAMES[frames % SPINNER_FRAMES.length])}\x1b[K`)
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
    start(nextLabel) {
      label = nextLabel
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
    stop({ done = false } = {}) {
      stopTimers()
      if (!shown) return
      shown = false
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
  let frames = 0
  let shown = false
  let stopped = true
  let graceTimer = null
  let tickTimer = null

  const draw = () => {
    stdout.write(`\r${dim(`${label} · ${formatCompactCount(count)}`)} ${cyan(SPINNER_FRAMES[frames % SPINNER_FRAMES.length])}\x1b[K`)
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
      count = 0
      frames = 0
      stopped = false
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
    update(chars) {
      count += chars
    },
    stop({ done = false } = {}) {
      if (stopped) return
      stopped = true
      stopTimers()
      if (done) {
        stdout.write(`\r${green('✓')} ${label} · ${formatCompactCount(count)}\x1b[K\n`)
        return
      }
      if (shown) stdout.write('\r\x1b[K')
      shown = false
    },
  }
}
