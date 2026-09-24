export const ATTACHMENT_MAX_EDGE = 2048
export const ATTACHMENT_MAX_PIXELS = 50_000_000

const REENCODE = {
  'image/jpeg': (pipeline) => pipeline.jpeg({ quality: 90 }),
  'image/png': (pipeline) => pipeline.png({ compressionLevel: 9 }),
  'image/webp': (pipeline) => pipeline.webp({ quality: 90 }),
}

let sharpPromise

function defaultLoadSharp() {
  sharpPromise ??= import('sharp').then((mod) => mod.default, () => null)
  return sharpPromise
}

export async function isImageTransformAvailable() {
  return (await defaultLoadSharp()) !== null
}

export async function transformImageAttachment(buffer, { mime, loadSharp = defaultLoadSharp } = {}) {
  try {
    if (mime === 'image/gif') return null
    const reencode = REENCODE[mime]
    if (!reencode) return null
    const sharp = await loadSharp()
    if (!sharp) return null
    const image = sharp(buffer, { limitInputPixels: ATTACHMENT_MAX_PIXELS })
    const meta = await image.metadata()
    if (!meta.width || !meta.height || meta.pages > 1) return null
    const pipeline = image
      .rotate()
      .resize({ width: ATTACHMENT_MAX_EDGE, height: ATTACHMENT_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    const transformed = await reencode(pipeline).toBuffer()
    // rotate() bakes the EXIF orientation as a transpose, which keeps the long
    // edge the same, so the pre-rotation metadata decides the resized verdict.
    return { buffer: transformed, mime, resized: Math.max(meta.width, meta.height) > ATTACHMENT_MAX_EDGE }
  } catch {
    return null
  }
}
