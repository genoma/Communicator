import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-image-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const { handleWatermarkCommand } = await import('../src/commands/image-gen.js')

function run({ providerName = 'venice', args, prefs = {} }) {
  const state = { out: [], errOut: [], saved: [] }
  const call = handleWatermarkCommand({
    providerName,
    args,
    prefs,
    savePrefs: async (updates) => { state.saved.push(updates) },
    out: (line) => state.out.push(line),
    errOut: (line) => state.errOut.push(line),
  })
  return { state, prefs, call }
}

test('handleWatermarkCommand shows the current Venice watermark state without saving', async () => {
  const on = run({ args: '' })
  await on.call
  assert.deepEqual(on.state.out, ['Venice watermark is on.\n'])
  assert.deepEqual(on.state.saved, [], 'showing the state must not persist anything')

  const off = run({ args: '', prefs: { hideWatermark: true } })
  await off.call
  assert.deepEqual(off.state.out, ['Venice watermark is off.\n'])
  assert.deepEqual(off.state.saved, [])
})

test('handleWatermarkCommand toggles the watermark and persists hideWatermark', async () => {
  const prefs = {}
  const off = run({ args: 'off', prefs })
  await off.call
  assert.equal(prefs.hideWatermark, true, 'watermark off is stored as hideWatermark true')
  assert.deepEqual(off.state.saved, [{ hideWatermark: true }])
  assert.deepEqual(off.state.out, ['Venice watermark disabled.\n'])
  assert.deepEqual(off.state.errOut, [])

  const on = run({ args: 'on', prefs })
  await on.call
  assert.equal(prefs.hideWatermark, false)
  assert.deepEqual(on.state.saved, [{ hideWatermark: false }])
  assert.deepEqual(on.state.out, ['Venice watermark enabled.\n'])
  assert.deepEqual(on.state.errOut, [])
})

test('handleWatermarkCommand rejects a non-Venice provider without touching the pref', async () => {
  const rejected = run({ providerName: 'openrouter', args: 'off' })
  await rejected.call

  assert.deepEqual(rejected.state.errOut, ['Error: /watermark is only supported on Venice sessions.\n'])
  assert.deepEqual(rejected.state.out, [])
  assert.deepEqual(rejected.state.saved, [], 'a non-Venice session must not write the Venice pref')
  assert.equal(rejected.prefs.hideWatermark, undefined)
})

test('handleWatermarkCommand rejects an argument other than "on" or "off"', async () => {
  const rejected = run({ args: 'sometimes' })
  await rejected.call

  assert.deepEqual(rejected.state.errOut, ['Error: /watermark expects "on" or "off".\n'])
  assert.deepEqual(rejected.state.out, [])
  assert.deepEqual(rejected.state.saved, [])
  assert.equal(rejected.prefs.hideWatermark, undefined)
})
