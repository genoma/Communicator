import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLoader, createThinkingMeter } from '../src/ui/loader.js'
import { dim, cyan, green } from '../src/ui/style.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function frameAt(i) {
  return cyan(FRAMES[i % FRAMES.length])
}

test('loader shows nothing before the grace period, then dim label with cycling spinner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const loader = createLoader({ stdout, graceMs: 200, tickMs: 150 })
  loader.start('Waiting for response')

  t.mock.timers.tick(199)
  assert.deepEqual(chunks, [])
  t.mock.timers.tick(1)
  assert.deepEqual(chunks, [`\r${dim('Waiting for response')} ${frameAt(0)}\x1b[K`])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(1)}\x1b[K`,
  ])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(1)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(2)}\x1b[K`,
  ])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(1)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(2)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(3)}\x1b[K`,
  ])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(1)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(2)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(3)}\x1b[K`,
    `\r${dim('Waiting for response')} ${frameAt(4)}\x1b[K`,
  ])
})

test('stop before grace writes nothing and cancels pending frames', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const loader = createLoader({ stdout, graceMs: 200, tickMs: 150 })
  loader.start('Waiting')
  assert.equal(loader.stop(), false, 'an unshown stop reports no checkpoint was written')
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [])
})

test('stop erases the loader line only when shown and cancels further frames', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const loader = createLoader({ stdout, graceMs: 200, tickMs: 150 })
  loader.start('Searching the web')
  t.mock.timers.tick(200)
  loader.stop()
  assert.deepEqual(chunks, [`\r${dim('Searching the web')} ${frameAt(0)}\x1b[K`, '\r\x1b[K'])
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${dim('Searching the web')} ${frameAt(0)}\x1b[K`, '\r\x1b[K'])
})

test('stop with done writes a green check line once and is idempotent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const loader = createLoader({ stdout, graceMs: 200, tickMs: 150 })
  loader.start('Waiting for response')
  t.mock.timers.tick(200)
  assert.equal(loader.stop({ done: true }), true, 'a shown done stop reports the checkpoint was written')
  const doneLine = `\r${green('✓')} Waiting for response\x1b[K\n`
  assert.deepEqual(chunks, [`\r${dim('Waiting for response')} ${frameAt(0)}\x1b[K`, doneLine])
  assert.equal(loader.stop(), false, 'a second stop writes nothing and reports no checkpoint')
  assert.equal(loader.stop({ done: true }), false, 'a third done stop is idempotent and reports no checkpoint')
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${dim('Waiting for response')} ${frameAt(0)}\x1b[K`, doneLine])
})

test('stop with done before grace writes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const loader = createLoader({ stdout, graceMs: 200, tickMs: 150 })
  loader.start('Waiting')
  assert.equal(loader.stop({ done: true }), false, 'an instant reply writes no checkpoint and reports it')
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [])
})

test('start with a new label while shown redraws immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const loader = createLoader({ stdout, graceMs: 200, tickMs: 150 })
  loader.start('First')
  t.mock.timers.tick(200)
  loader.start('Second')
  assert.deepEqual(chunks, [`\r${dim('First')} ${frameAt(0)}\x1b[K`, `\r${dim('Second')} ${frameAt(0)}\x1b[K`])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('First')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Second')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Second')} ${frameAt(1)}\x1b[K`,
  ])
})

test('thinking meter shows nothing before grace, then count and seconds with cycling spinner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.start()
  meter.update(10)
  meter.update(1124)
  nowMs = 300
  t.mock.timers.tick(199)
  assert.deepEqual(chunks, [])
  t.mock.timers.tick(1)
  assert.deepEqual(chunks, [`\r${dim('Thinking · 1.1k · 0.3s')} ${frameAt(0)}\x1b[K`])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Thinking · 1.1k · 0.3s')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.1k · 0.3s')} ${frameAt(1)}\x1b[K`,
  ])
})

test('thinking meter repaints seconds as the clock advances', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.start()
  meter.update(1200)
  nowMs = 1500
  t.mock.timers.tick(200)
  assert.deepEqual(chunks, [`\r${dim('Thinking · 1.2k · 1.5s')} ${frameAt(0)}\x1b[K`])
  nowMs = 3700
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Thinking · 1.2k · 1.5s')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.2k · 3.7s')} ${frameAt(1)}\x1b[K`,
  ])
  nowMs = 43_000
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Thinking · 1.2k · 1.5s')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.2k · 3.7s')} ${frameAt(1)}\x1b[K`,
    `\r${dim('Thinking · 1.2k · 43s')} ${frameAt(2)}\x1b[K`,
  ])
})

test('thinking meter stop clears only when shown and cancels pending frames', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.start()
  meter.stop()
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [])

  meter.start()
  nowMs = 100
  t.mock.timers.tick(200)
  meter.stop()
  assert.deepEqual(chunks, [`\r${dim('Thinking · 0 · 0.1s')} ${frameAt(0)}\x1b[K`, '\r\x1b[K'])
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${dim('Thinking · 0 · 0.1s')} ${frameAt(0)}\x1b[K`, '\r\x1b[K'])
})

test('thinking meter stop with done always writes the checkpoint with the final count and seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.start()
  meter.update(999)
  nowMs = 2300
  meter.stop({ done: true })
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 999 · 2.3s\x1b[K\n`])
  meter.stop()
  meter.stop({ done: true })
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 999 · 2.3s\x1b[K\n`])
})

test('thinking meter start resets the count and seconds and keeps accumulating updates', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.start()
  meter.update(500)
  nowMs = 500
  meter.stop({ done: true })
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 500 · 0.5s\x1b[K\n`])

  meter.start()
  meter.update(500)
  meter.update(500)
  nowMs = 500
  meter.stop({ done: true })
  assert.deepEqual(chunks, [
    `\r${green('✓')} Thinking · 500 · 0.5s\x1b[K\n`,
    `\r${green('✓')} Thinking · 1k\x1b[K\n`,
  ])
})

test('thinking meter start honors an explicit startedAt override (turn clock)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 3000
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.start({ startedAt: 800 })
  meter.update(999)
  meter.stop({ done: true })
  // Elapsed measured from the override anchor: 3000 - 800 = 2.2s.
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 999 · 2.2s\x1b[K\n`])
})

test('thinking meter checkpoint suppresses a sub-50ms (0s) duration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.start()
  meter.update(999)
  nowMs = 30
  meter.stop({ done: true })
  // 30ms rounds to 0s: checkpoint reports count-only, never `· 0s`.
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 999\x1b[K\n`])
})

test('thinking meter checkpoint still reports substantive seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.start()
  meter.update(999)
  nowMs = 3400
  meter.stop({ done: true })
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 999 · 3.4s\x1b[K\n`])
})

test('thinking meter waiting phase paints the live wait clock and flips to thinking', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.beginWait({ startedAt: 0, label: 'Waiting for response' })
  nowMs = 2300
  t.mock.timers.tick(200)
  assert.deepEqual(chunks, [`\r${dim('Waiting for response · 2.3s')} ${frameAt(0)}\x1b[K`])
  meter.toThinking()
  meter.update(1234)
  nowMs = 3400
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response · 2.3s')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.2k · 3.4s')} ${frameAt(1)}\x1b[K`,
  ])
  nowMs = 4300
  meter.stop({ done: true })
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response · 2.3s')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.2k · 3.4s')} ${frameAt(1)}\x1b[K`,
    `\r${green('✓')} Thinking · 1.2k · 4.3s\x1b[K\n`,
  ])
})

test('thinking meter waiting phase resolves to the wait checkpoint when shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.beginWait({ startedAt: 0, label: 'Waiting for response' })
  nowMs = 500
  t.mock.timers.tick(200)
  assert.equal(meter.isWaiting(), true)
  const wrote = meter.stop({ done: true })
  assert.equal(wrote, true)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response · 0.5s')} ${frameAt(0)}\x1b[K`,
    `\r${green('✓')} Waiting for response\x1b[K\n`,
  ])
})

test('thinking meter waiting-phase done stop before the grace window writes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => 0 })
  meter.beginWait({ startedAt: 0, label: 'Waiting for response' })
  // Nothing within the grace window: no checkpoint, no residual row.
  const wrote = meter.stop({ done: true })
  assert.equal(wrote, false)
  assert.deepEqual(chunks, [])
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [])
})

test('thinking meter restarts cleanly after a checkpointed turn (retry path)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  let nowMs = 0
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150, now: () => nowMs })
  meter.start()
  meter.update(500)
  nowMs = 500
  meter.stop({ done: true })
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 500 · 0.5s\x1b[K\n`])
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 500 · 0.5s\x1b[K\n`])

  meter.start()
  nowMs = 700
  t.mock.timers.tick(199)
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 500 · 0.5s\x1b[K\n`])
  meter.update(1200)
  t.mock.timers.tick(1)
  assert.deepEqual(chunks, [
    `\r${green('✓')} Thinking · 500 · 0.5s\x1b[K\n`,
    `\r${dim('Thinking · 1.2k · 0.2s')} ${frameAt(0)}\x1b[K`,
  ])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${green('✓')} Thinking · 500 · 0.5s\x1b[K\n`,
    `\r${dim('Thinking · 1.2k · 0.2s')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.2k · 0.2s')} ${frameAt(1)}\x1b[K`,
  ])
  nowMs = 2000
  meter.stop({ done: true })
  assert.deepEqual(chunks, [
    `\r${green('✓')} Thinking · 500 · 0.5s\x1b[K\n`,
    `\r${dim('Thinking · 1.2k · 0.2s')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.2k · 0.2s')} ${frameAt(1)}\x1b[K`,
    `\r${green('✓')} Thinking · 1.2k · 1.5s\x1b[K\n`,
  ])
})
