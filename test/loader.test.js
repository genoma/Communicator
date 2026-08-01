import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLoader } from '../src/ui/loader.js'
import { dim } from '../src/ui/style.js'

test('loader shows nothing before the grace period, then dim label with cycling dots', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const loader = createLoader({ stdout, graceMs: 200, tickMs: 150 })
  loader.start('Waiting for response')

  t.mock.timers.tick(199)
  assert.deepEqual(chunks, [])
  t.mock.timers.tick(1)
  assert.deepEqual(chunks, [`\r${dim('Waiting for response')}\x1b[K`])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response')}\x1b[K`,
    `\r${dim('Waiting for response')}.\x1b[K`,
  ])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response')}\x1b[K`,
    `\r${dim('Waiting for response')}.\x1b[K`,
    `\r${dim('Waiting for response')}..\x1b[K`,
  ])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response')}\x1b[K`,
    `\r${dim('Waiting for response')}.\x1b[K`,
    `\r${dim('Waiting for response')}..\x1b[K`,
    `\r${dim('Waiting for response')}...\x1b[K`,
  ])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('Waiting for response')}\x1b[K`,
    `\r${dim('Waiting for response')}.\x1b[K`,
    `\r${dim('Waiting for response')}..\x1b[K`,
    `\r${dim('Waiting for response')}...\x1b[K`,
    `\r${dim('Waiting for response')}\x1b[K`,
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
  assert.deepEqual(chunks, [`\r${dim('Searching the web')}\x1b[K`, '\r\x1b[K'])
  t.mock.timers.tick(1000)
  assert.deepEqual(chunks, [`\r${dim('Searching the web')}\x1b[K`, '\r\x1b[K'])
})

test('start with a new label while shown redraws immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { write(chunk) { chunks.push(String(chunk)); return true } }
  const loader = createLoader({ stdout, graceMs: 200, tickMs: 150 })
  loader.start('First')
  t.mock.timers.tick(200)
  loader.start('Second')
  assert.deepEqual(chunks, [`\r${dim('First')}\x1b[K`, `\r${dim('Second')}\x1b[K`])
  t.mock.timers.tick(150)
  assert.deepEqual(chunks, [
    `\r${dim('First')}\x1b[K`,
    `\r${dim('Second')}\x1b[K`,
    `\r${dim('Second')}.\x1b[K`,
  ])
})
