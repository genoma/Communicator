import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePixelSize, sizePresets } from '../src/image-sizing.js'

test('computePixelSize rejects zero and non-numeric ratios with the exact message', { timeout: 5000 }, () => {
  assert.throws(() => computePixelSize('0:1', 8), (err) => err.message === 'invalid aspect ratio 0:1.')
  assert.throws(() => computePixelSize('1:0', 8), (err) => err.message === 'invalid aspect ratio 1:0.')
  assert.throws(() => computePixelSize('0:0', 8), (err) => err.message === 'invalid aspect ratio 0:0.')
  assert.throws(() => computePixelSize('abc:1', 8), (err) => err.message === 'invalid aspect ratio abc:1.')
})

test('sizePresets keeps the surviving presets when the divisor floors others to zero', { timeout: 5000 }, () => {
  const presets = sizePresets({ constraints: { aspectRatios: null, widthHeightDivisor: 640 } })

  assert.deepEqual(presets.map((p) => p.ratio), ['1:1', '3:2', '16:9', '9:16', '2:3', '3:4', '4:5'])
  assert.ok(presets.every((p) => p.width > 0 && p.height > 0))
})
