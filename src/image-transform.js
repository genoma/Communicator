export const ATTACHMENT_MAX_EDGE = 2048
export const ATTACHMENT_MAX_PIXELS = 50_000_000

const REENCODE = {
  'image/jpeg': (pipeline) => pipeline.jpeg({ quality: 90 }),
  'image/png': (pipeline) => pipeline.png({ compressionLevel: 9 }),
  'image/webp': (pipeline) => pipeline.webp({ quality: 90 }),
}

export const MUST_CONVERT_MIMES = new Set(['image/avif', 'image/tiff', 'image/heic', 'image/heif'])

export const HEIC_MIMES = new Set(['image/heic', 'image/heif'])

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let sharpPromise

function defaultLoadSharp() {
  sharpPromise ??= import('sharp').then((mod) => mod.default, () => null)
  return sharpPromise
}

let heicPromise

function loadHeicDecoder() {
  heicPromise ??= import('./heic-decode.js').then((mod) => mod.decodeHeic, () => null)
  return heicPromise
}

async function defaultDecodeHeic(buffer) {
  const decode = await loadHeicDecoder()
  return decode ? decode(buffer) : null
}

export async function isImageTransformAvailable() {
  return (await defaultLoadSharp()) !== null
}

// libvips reads an animated PNG as a single frame (metadata.pages is undefined),
// so the pages guard below cannot see it and the re-encode would drop frames.
function isAnimatedPng(buffer) {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false
  let offset = PNG_SIGNATURE.length
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    offset += 12 + length
  }
  return false
}

export async function transformImageAttachment(buffer, { mime, loadSharp = defaultLoadSharp, heic = defaultDecodeHeic } = {}) {
  try {
    if (mime === 'image/gif') return null
    if (mime === 'image/png' && isAnimatedPng(buffer)) return null
    const mustConvert = MUST_CONVERT_MIMES.has(mime)
    const reencode = REENCODE[mime]
    if (!mustConvert && !reencode) return null
    const sharp = await loadSharp()
    if (!sharp) return null
    const source = HEIC_MIMES.has(mime) ? await heic(buffer) : buffer
    if (!source) return null
    const image = sharp(source, { limitInputPixels: ATTACHMENT_MAX_PIXELS })
    const meta = await image.metadata()
    if (!meta.width || !meta.height || meta.pages > 1) return null
    const pipeline = image
      .rotate()
      .resize({ width: ATTACHMENT_MAX_EDGE, height: ATTACHMENT_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    if (mustConvert) {
      const targetMime = meta.hasAlpha ? 'image/png' : 'image/jpeg'
      return { buffer: await REENCODE[targetMime](pipeline).toBuffer(), mime: targetMime }
    }
    return { buffer: await reencode(pipeline).toBuffer(), mime }
  } catch {
    return null
  }
}
