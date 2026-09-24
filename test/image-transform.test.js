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
  assert.equal(out.mime, 'image/jpeg')
  const meta = await sharp(out.buffer).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.equal(meta.width, ATTACHMENT_MAX_EDGE)
  assert.equal(meta.height, 1536)
})

test('leaves a small image at its dimensions', async (t) => {
  if (!(await isImageTransformAvailable())) return t.skip('sharp unavailable')
  const sharp = await realSharp()
  const input = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#22aa66' } }).png().toBuffer()
  const out = await transformImageAttachment(input, { mime: 'image/png' })
  assert.ok(out)
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

function pngChunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)])
}

test('returns null for an animated PNG before the codec sees it', async () => {
  const apng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('acTL', Buffer.alloc(8)),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x00])),
    pngChunk('IEND'),
  ])
  assert.equal(await transformImageAttachment(apng, { mime: 'image/png' }), null)
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

test('converts an alpha-less avif to jpeg', async (t) => {
  if (!(await isImageTransformAvailable())) return t.skip('sharp unavailable')
  const sharp = await realSharp()
  const input = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3366aa' } }).avif().toBuffer()
  const out = await transformImageAttachment(input, { mime: 'image/avif' })
  assert.ok(out, 'a decodable AVIF must be converted')
  assert.equal(out.mime, 'image/jpeg')
  assert.equal((await sharp(out.buffer).metadata()).format, 'jpeg')
})

test('converts an avif with alpha to png', async (t) => {
  if (!(await isImageTransformAvailable())) return t.skip('sharp unavailable')
  const sharp = await realSharp()
  const input = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 51, g: 102, b: 170, alpha: 0.5 } } }).avif().toBuffer()
  const out = await transformImageAttachment(input, { mime: 'image/avif' })
  assert.ok(out)
  assert.equal(out.mime, 'image/png')
  assert.equal((await sharp(out.buffer).metadata()).format, 'png')
})

test('converts a tiff to jpeg', async (t) => {
  if (!(await isImageTransformAvailable())) return t.skip('sharp unavailable')
  const sharp = await realSharp()
  const input = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3366aa' } }).tiff().toBuffer()
  const out = await transformImageAttachment(input, { mime: 'image/tiff' })
  assert.ok(out)
  assert.equal(out.mime, 'image/jpeg')
  assert.equal((await sharp(out.buffer).metadata()).format, 'jpeg')
})

test('targets png for a must-convert image with alpha', async () => {
  const fakeSharp = (buffer) => {
    assert.equal(buffer.toString(), 'TIFFDATA')
    return {
      metadata: async () => ({ width: 10, height: 10, hasAlpha: true }),
      rotate() { return this },
      resize() { return this },
      png() { return this },
      toBuffer: async () => Buffer.from('CONVERTED'),
    }
  }
  const out = await transformImageAttachment(Buffer.from('TIFFDATA'), { mime: 'image/tiff', loadSharp: async () => fakeSharp })
  assert.deepEqual(out, { buffer: Buffer.from('CONVERTED'), mime: 'image/png' })
})

test('converts heic through the injected converter and targets jpeg', async () => {
  const decoded = []
  const fakeSharp = (buffer) => {
    decoded.push(buffer.toString())
    return {
      metadata: async () => ({ width: 100, height: 80, hasAlpha: false }),
      rotate() { return this },
      resize() { return this },
      jpeg() { return this },
      toBuffer: async () => Buffer.from('CONVERTED'),
    }
  }
  const out = await transformImageAttachment(Buffer.from('HEICDATA'), {
    mime: 'image/heic',
    heic: async () => Buffer.from('DECODED'),
    loadSharp: async () => fakeSharp,
  })
  assert.deepEqual(decoded, ['DECODED'])
  assert.equal(out.buffer.toString(), 'CONVERTED')
  assert.equal(out.mime, 'image/jpeg')
})

test('returns null when the heic converter fails', async () => {
  let converted = 0
  const out = await transformImageAttachment(Buffer.from('HEICDATA'), {
    mime: 'image/heif',
    heic: async () => { converted += 1; return null },
    loadSharp: async () => () => { throw new Error('must not decode') },
  })
  assert.equal(out, null)
  assert.equal(converted, 1)
})

test('returns null for a must-convert mime when the codec is unavailable', async () => {
  assert.equal(await transformImageAttachment(Buffer.from('AVIFDATA'), { mime: 'image/avif', loadSharp: async () => null }), null)
  assert.equal(await transformImageAttachment(Buffer.from('HEICDATA'), { mime: 'image/heic', loadSharp: async () => null }), null)
})
