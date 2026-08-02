import { dim, cyan, green } from './style.js'
import { LOADER_GRACE_MS, LOADER_TICK_MS } from '../constants.js'

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
