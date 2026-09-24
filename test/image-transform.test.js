import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ATTACHMENT_MAX_EDGE, ATTACHMENT_MAX_PIXELS, isImageTransformAvailable, transformImageAttachment } from '../src/image-transform.js'

async function realSharp() {
  const { default: sharp } = await import('sharp')
  return sharp
}

test('downsizes a 4000x3000 JPEG to the long-edge cap', async (t) => {
  if (!(await isImageTransformAvailable())) return t.skip('sharp unavailable')
  const sharp = await realSharp()
  const input = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#3366aa' } }).jpeg().toBuffer()
  const out = await transformImageAttachment(input, { mime: 'image/jpeg' })
  assert.ok(out, 'a decodable JPEG must be transformed')
  assert.equal(out.resized, true)
  assert.equal(out.mime, 'image/jpeg')
  const meta = await sharp(out.buffer).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.equal(meta.width, ATTACHMENT_MAX_EDGE)
  assert.equal(meta.height, 1536)
})

test('leaves a small image at its dimensions with resized=false', async (t) => {
  if (!(await isImageTransformAvailable())) return t.skip('sharp unavailable')
  const sharp = await realSharp()
  const input = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#22aa66' } }).png().toBuffer()
  const out = await transformImageAttachment(input, { mime: 'image/png' })
  assert.ok(out)
  assert.equal(out.resized, false)
  assert.equal(out.mime, 'image/png')
  const meta = await sharp(out.buffer).metadata()
  assert.equal(meta.format, 'png')
  assert.equal(meta.width, 120)
  assert.equal(meta.height, 80)
})

test('bakes EXIF orientation and drops EXIF', async (t) => {
  if (!(await isImageTransformAvailable())) return t.skip('sharp unavailable')
  const sharp = await realSharp()
  const input = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#ff0000' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  assert.equal((await sharp(input).metadata()).orientation, 6)
  const out = await transformImageAttachment(input, { mime: 'image/jpeg' })
  assert.ok(out)
  assert.equal(out.resized, false)
  const meta = await sharp(out.buffer).metadata()
  assert.equal(meta.width, 20)
  assert.equal(meta.height, 40)
  assert.equal(meta.orientation, undefined)
  assert.equal(meta.exif, undefined)
})

test('returns null for an animated WebP', async (t) => {
  if (!(await isImageTransformAvailable())) return t.skip('sharp unavailable')
  const sharp = await realSharp()
  const frames = await Promise.all(['#ff0000', '#00ff00'].map((background) =>
    sharp({ create: { width: 16, height: 16, channels: 3, background } }).webp().toBuffer(),
  ))
  const animated = await sharp(frames, { join: { animated: true } }).webp().toBuffer()
  assert.equal((await sharp(animated).metadata()).pages, 2)
  assert.equal(await transformImageAttachment(animated, { mime: 'image/webp' }), null)
})

test('returns null for image/gif', async () => {
  assert.equal(await transformImageAttachment(Buffer.from('GIF89a'), { mime: 'image/gif' }), null)
})

test('returns null for an undecodable buffer', async (t) => {
  if (!(await isImageTransformAvailable())) return t.skip('sharp unavailable')
  assert.equal(await transformImageAttachment(Buffer.from('PNGDATA'), { mime: 'image/png' }), null)
})

test('decodes with the attachment pixel cap', async () => {
  const seen = []
  const fakeSharp = (buffer, options) => {
    seen.push(options)
    return {
      metadata: async () => ({ width: 10, height: 10 }),
      rotate() { return this },
      resize() { return this },
      jpeg() { return this },
      toBuffer: async () => Buffer.from('REENC0DED'),
    }
  }
  const out = await transformImageAttachment(Buffer.from('PNGDATA'), { mime: 'image/jpeg', loadSharp: async () => fakeSharp })
  assert.deepEqual(seen, [{ limitInputPixels: ATTACHMENT_MAX_PIXELS }])
  assert.equal(out.buffer.toString(), 'REENC0DED')
  assert.equal(out.mime, 'image/jpeg')
  assert.equal(out.resized, false)
})

test('returns null when the codec is unavailable', async () => {
  assert.equal(await transformImageAttachment(Buffer.from('PNGDATA'), { mime: 'image/png', loadSharp: async () => null }), null)
})

test('returns null when the codec import fails without throwing', async () => {
  const out = await transformImageAttachment(Buffer.from('PNGDATA'), {
    mime: 'image/png',
    loadSharp: async () => { throw new Error('sharp is not installed') },
  })
  assert.equal(out, null)
})
