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
  loader.stop()
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
  loader.stop({ done: true })
  const doneLine = `\r${green('✓')} Waiting for response\x1b[K\n`
  assert.deepEqual(chunks, [`\r${dim('Waiting for response')} ${frameAt(0)}\x1b[K`, doneLine])
  loader.stop()
  loader.stop({ done: true })
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${dim('Waiting for response')} ${frameAt(0)}\x1b[K`, doneLine])
})

test('stop with done before grace writes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const loader = createLoader({ stdout, graceMs: 200, tickMs: 150 })
  loader.start('Waiting')
  loader.stop({ done: true })
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
    `\r${green('✓')} Thinking · 1k · 0s\x1b[K\n`,
  ])
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
