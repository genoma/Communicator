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

test('thinking meter shows nothing before grace, then label count with cycling spinner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150 })
  meter.start()
  meter.update(10)
  meter.update(1124)
  t.mock.timers.tick(199)
  assert.deepEqual(chunks, [])
  t.mock.timers.tick(1)
  assert.deepEqual(chunks, [`\r${dim('Thinking · 1.1k')} ${frameAt(0)}\x1b[K`])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Thinking · 1.1k')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.1k')} ${frameAt(1)}\x1b[K`,
  ])
})

test('thinking meter stop clears only when shown and cancels pending frames', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150 })
  meter.start()
  meter.stop()
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [])

  meter.start()
  t.mock.timers.tick(200)
  meter.stop()
  assert.deepEqual(chunks, [`\r${dim('Thinking · 0')} ${frameAt(0)}\x1b[K`, '\r\x1b[K'])
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${dim('Thinking · 0')} ${frameAt(0)}\x1b[K`, '\r\x1b[K'])
})

test('thinking meter stop with done always writes the checkpoint with the final count', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150 })
  meter.start()
  meter.update(999)
  meter.stop({ done: true })
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 999\x1b[K\n`])
  meter.stop()
  meter.stop({ done: true })
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 999\x1b[K\n`])
})

test('thinking meter start resets the count and keeps accumulating updates', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150 })
  meter.start()
  meter.update(500)
  meter.stop({ done: true })
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 500\x1b[K\n`])

  meter.start()
  meter.update(500)
  meter.update(500)
  meter.stop({ done: true })
  assert.deepEqual(chunks, [
    `\r${green('✓')} Thinking · 500\x1b[K\n`,
    `\r${green('✓')} Thinking · 1k\x1b[K\n`,
  ])
})

test('thinking meter restarts cleanly after a checkpointed turn (retry path)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const meter = createThinkingMeter({ stdout, graceMs: 200, tickMs: 150 })
  meter.start()
  meter.update(500)
  meter.stop({ done: true })
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 500\x1b[K\n`])
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 500\x1b[K\n`])

  meter.start()
  t.mock.timers.tick(199)
  assert.deepEqual(chunks, [`\r${green('✓')} Thinking · 500\x1b[K\n`])
  meter.update(1200)
  t.mock.timers.tick(1)
  assert.deepEqual(chunks, [
    `\r${green('✓')} Thinking · 500\x1b[K\n`,
    `\r${dim('Thinking · 1.2k')} ${frameAt(0)}\x1b[K`,
  ])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${green('✓')} Thinking · 500\x1b[K\n`,
    `\r${dim('Thinking · 1.2k')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.2k')} ${frameAt(1)}\x1b[K`,
  ])
  meter.stop({ done: true })
  assert.deepEqual(chunks, [
    `\r${green('✓')} Thinking · 500\x1b[K\n`,
    `\r${dim('Thinking · 1.2k')} ${frameAt(0)}\x1b[K`,
    `\r${dim('Thinking · 1.2k')} ${frameAt(1)}\x1b[K`,
    `\r${green('✓')} Thinking · 1.2k\x1b[K\n`,
  ])
})
