import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveImageFormat, resolveVariants, resolveAspectRatio, resolveResolution, resolveQuality, resolveSeed, resolveWidth, resolveHeight, resolveSize, MAX_IMAGE_DIMENSION } from '../src/flags.js'

const throws = (fn, message) => assert.throws(fn, (err) => err.message === message)

test('resolveImageFormat accepts png, jpeg and webp', () => {
  assert.equal(resolveImageFormat('png'), 'png')
  assert.equal(resolveImageFormat('jpeg'), 'jpeg')
  assert.equal(resolveImageFormat('webp'), 'webp')
})

test('resolveImageFormat rejects unknown formats and absent values', () => {
  throws(() => resolveImageFormat('gif'), '--image-format must be one of: png, jpeg, webp.')
  throws(() => resolveImageFormat('JPG'), '--image-format must be one of: png, jpeg, webp.')
  assert.equal(resolveImageFormat(undefined), undefined)
  assert.equal(resolveImageFormat(''), undefined)
})

test('resolveVariants accepts integers in 1-4', () => {
  assert.equal(resolveVariants('1'), 1)
  assert.equal(resolveVariants('4'), 4)
  assert.equal(resolveVariants(2), 2)
})

test('resolveVariants rejects out-of-range and non-integer values', () => {
  throws(() => resolveVariants('0'), '--variants must be an integer between 1 and 4.')
  throws(() => resolveVariants('5'), '--variants must be an integer between 1 and 4.')
  throws(() => resolveVariants('2.5'), '--variants must be an integer between 1 and 4.')
  throws(() => resolveVariants('abc'), '--variants must be an integer between 1 and 4.')
  assert.equal(resolveVariants(undefined), undefined)
})

test('resolveAspectRatio accepts W:H shapes', () => {
  assert.equal(resolveAspectRatio('16:9'), '16:9')
  assert.equal(resolveAspectRatio('1:1'), '1:1')
  assert.equal(resolveAspectRatio('1024:768'), '1024:768')
})

test('resolveAspectRatio accepts auto and decimal ratios', () => {
  assert.equal(resolveAspectRatio('auto'), 'auto')
  assert.equal(resolveAspectRatio('9:19.5'), '9:19.5')
  assert.equal(resolveAspectRatio('19.5:9'), '19.5:9')
})

test('resolveAspectRatio rejects malformed shapes', () => {
  throws(() => resolveAspectRatio('16x9'), '--aspect-ratio must be in the form W:H (e.g. 16:9) or "auto".')
  throws(() => resolveAspectRatio('16:'), '--aspect-ratio must be in the form W:H (e.g. 16:9) or "auto".')
  throws(() => resolveAspectRatio('wide'), '--aspect-ratio must be in the form W:H (e.g. 16:9) or "auto".')
  throws(() => resolveAspectRatio(':9'), '--aspect-ratio must be in the form W:H (e.g. 16:9) or "auto".')
  assert.equal(resolveAspectRatio(undefined), undefined)
})

test('resolveResolution accepts the tier list', () => {
  assert.equal(resolveResolution('1K'), '1K')
  assert.equal(resolveResolution('2K'), '2K')
  assert.equal(resolveResolution('4K'), '4K')
})

test('resolveResolution rejects unknown tiers', () => {
  throws(() => resolveResolution('1080p'), '--resolution must be one of: 1K, 2K, 4K.')
  throws(() => resolveResolution('8K'), '--resolution must be one of: 1K, 2K, 4K.')
  assert.equal(resolveResolution(undefined), undefined)
})

test('resolveQuality accepts the level list', () => {
  assert.equal(resolveQuality('low'), 'low')
  assert.equal(resolveQuality('medium'), 'medium')
  assert.equal(resolveQuality('high'), 'high')
})

test('resolveQuality rejects unknown levels', () => {
  throws(() => resolveQuality('ultra'), '--quality must be one of: low, medium, high.')
  assert.equal(resolveQuality(undefined), undefined)
})

test('resolveSeed accepts integers in range', () => {
  assert.equal(resolveSeed('42'), 42)
  assert.equal(resolveSeed('-1'), -1)
  assert.equal(resolveSeed('999999999'), 999999999)
})

test('resolveSeed rejects out-of-range and non-integer values', () => {
  throws(() => resolveSeed('1000000000'), '--seed must be an integer between -999999999 and 999999999.')
  throws(() => resolveSeed('1.5'), '--seed must be an integer between -999999999 and 999999999.')
  throws(() => resolveSeed('abc'), '--seed must be an integer between -999999999 and 999999999.')
  assert.equal(resolveSeed(undefined), undefined)
})

test('resolveWidth and resolveHeight accept integers in 1-1280', () => {
  assert.equal(resolveWidth('1'), 1)
  assert.equal(resolveWidth('1280'), 1280)
  assert.equal(resolveHeight('768'), 768)
})

test('resolveWidth and resolveHeight reject out-of-range and non-integer values', () => {
  throws(() => resolveWidth('0'), '--width must be an integer between 1 and 1280.')
  throws(() => resolveWidth('1281'), '--width must be an integer between 1 and 1280.')
  throws(() => resolveWidth('10.5'), '--width must be an integer between 1 and 1280.')
  throws(() => resolveHeight('0'), '--height must be an integer between 1 and 1280.')
  throws(() => resolveHeight('abc'), '--height must be an integer between 1 and 1280.')
  assert.equal(resolveWidth(undefined), undefined)
  assert.equal(resolveHeight(undefined), undefined)
})

test('resolveSize accepts WxH and W:H shapes', () => {
  assert.deepEqual(resolveSize('848x1272'), { width: 848, height: 1272 })
  assert.deepEqual(resolveSize('16:9'), { ratio: '16:9' })
  assert.equal(MAX_IMAGE_DIMENSION, 1280)
})

test('resolveSize rejects auto, decimals and malformed shapes', () => {
  for (const bad of ['auto', '16.5:9', 'wide', '16x', 'x16']) {
    throws(() => resolveSize(bad), '--size must be in the form WxH (e.g. 848x1272) or W:H (e.g. 16:9).')
  }
  assert.equal(resolveSize(''), undefined)
})

test('resolveSize rejects out-of-range dimensions', () => {
  throws(() => resolveSize('0x1280'), '--size dimensions must be integers between 1 and 1280.')
  throws(() => resolveSize('1281x1280'), '--size dimensions must be integers between 1 and 1280.')
  throws(() => resolveSize('848x0'), '--size dimensions must be integers between 1 and 1280.')
  assert.equal(resolveSize(undefined), undefined)
  assert.equal(resolveSize(null), undefined)
})
