import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePixelSize, isPixelModel, sizePresets, formatSize, sizeLabel, parseSizeInput, SIZE_PRESET_RATIOS } from '../src/image-sizing.js'

const pixelModel = (divisor) => ({
  id: 'z-image-turbo',
  constraints: { aspectRatios: null, widthHeightDivisor: divisor },
})

const aspectModel = {
  id: 'flux-1-1',
  constraints: { aspectRatios: ['1:1', '16:9'], widthHeightDivisor: null },
}

test('computePixelSize computes the full d8 preset table (z-image-turbo)', () => {
  assert.deepEqual(computePixelSize('1:1', 8), { width: 1280, height: 1280 })
  assert.deepEqual(computePixelSize('2:3', 8), { width: 848, height: 1272 })
  assert.deepEqual(computePixelSize('3:4', 8), { width: 960, height: 1280 })
  assert.deepEqual(computePixelSize('4:5', 8), { width: 1024, height: 1280 })
  assert.deepEqual(computePixelSize('9:16', 8), { width: 720, height: 1280 })
  assert.deepEqual(computePixelSize('3:2', 8), { width: 1272, height: 848 })
  assert.deepEqual(computePixelSize('16:9', 8), { width: 1280, height: 720 })
  assert.deepEqual(computePixelSize('21:9', 8), { width: 1264, height: 544 })
})

test('computePixelSize d16 differs only on 2:3/3:2 (matches the web UI rounding)', () => {
  assert.deepEqual(computePixelSize('2:3', 16), { width: 848, height: 1264 })
  assert.deepEqual(computePixelSize('3:2', 16), { width: 1264, height: 848 })
  assert.deepEqual(computePixelSize('1:1', 16), { width: 1280, height: 1280 })
  assert.deepEqual(computePixelSize('16:9', 16), { width: 1280, height: 720 })
  assert.deepEqual(computePixelSize('21:9', 16), { width: 1264, height: 544 })
})

test('computePixelSize handles divisor 1 (bria-bg-remover) without flooring errors', () => {
  assert.deepEqual(computePixelSize('21:9', 1), { width: 1278, height: 548 })
  assert.deepEqual(computePixelSize('1:1', 1), { width: 1280, height: 1280 })
  assert.deepEqual(computePixelSize('2:3', 1), { width: 853, height: 1279 })
})

test('computePixelSize throws when the small side floors to zero', () => {
  assert.throws(
    () => computePixelSize('200:1', 16),
    (err) => err.message === '--size ratio 200:1 is too extreme for this model (divisor 16).'
  )
})

test('isPixelModel only matches models with a null aspect-ratio list and a divisor', () => {
  assert.equal(isPixelModel(pixelModel(8)), true)
  assert.equal(isPixelModel(pixelModel(1)), true)
  assert.equal(isPixelModel(aspectModel), false)
  assert.equal(isPixelModel({ id: 'x', constraints: { aspectRatios: null, widthHeightDivisor: null } }), false)
  assert.equal(isPixelModel({ id: 'x', constraints: {} }), false)
  assert.equal(isPixelModel(null), false)
})

test('sizePresets returns the 8 presets in order with the model divisor applied', () => {
  const presets = sizePresets(pixelModel(8))
  assert.deepEqual(presets.map((p) => p.ratio), SIZE_PRESET_RATIOS)
  assert.deepEqual(presets.map((p) => `${p.width}x${p.height}`), [
    '1280x1280',
    '1272x848',
    '1280x720',
    '1264x544',
    '720x1280',
    '848x1272',
    '960x1280',
    '1024x1280',
  ])
})

test('sizePresets returns an empty list for models without a divisor', () => {
  assert.deepEqual(sizePresets(aspectModel), [])
  assert.deepEqual(sizePresets(null), [])
})

test('formatSize and sizeLabel shape the display strings', () => {
  assert.equal(formatSize(848, 1272), '848x1272')
  assert.equal(sizeLabel({ ratio: '2:3', width: 848, height: 1272 }), '2:3 · 848x1272')
})

test('parseSizeInput accepts WxH and W:H shapes', () => {
  assert.deepEqual(parseSizeInput('848x1272'), { width: 848, height: 1272 })
  assert.deepEqual(parseSizeInput('16:9'), { ratio: '16:9' })
})

test('parseSizeInput rejects auto, decimals, and garbage', () => {
  for (const bad of ['auto', '16.5:9', '9:19.5', 'wide', '16x', 'x16', '848x', '1,024x768', '']) {
    assert.throws(
      () => parseSizeInput(bad),
      (err) => err.message === '--size must be in the form WxH (e.g. 848x1272) or W:H (e.g. 16:9).',
      `expected ${JSON.stringify(bad)} to be rejected`
    )
  }
})
