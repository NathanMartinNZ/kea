// An image's pixel size from its header (an image over L.imageMaxPixels is not decoded, so the size must be known
// before the window is given the file). Only the first L.imageHeaderBytes bytes are looked at; a size that cannot be
// told from them is null, and the caller then treats a raster image as not decodable (the limit could not be upheld).
// File contents are untrusted: every read is bounds-checked and nothing is decoded.

import type { ImageExtension } from '@kea/protocol'

export interface PixelSize {
  width: number
  height: number
}

const ascii = (b: Buffer, at: number, s: string) => b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s

function png(b: Buffer): PixelSize | null {
  // signature (8), IHDR length (4), "IHDR", width, height
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || !ascii(b, 12, 'IHDR')) return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function gif(b: Buffer): PixelSize | null {
  if (b.length < 10 || !(ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return null
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
}

function webp(b: Buffer): PixelSize | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null
  if (ascii(b, 12, 'VP8X')) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  if (ascii(b, 12, 'VP8 ')) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    const v = b.readUInt32LE(21)
    return { width: 1 + (v & 0x3fff), height: 1 + ((v >>> 14) & 0x3fff) }
  }
  return null
}

function jpeg(b: Buffer): PixelSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1] as number
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2 // markers with no segment
      continue
    }
    const len = b.readUInt16BE(i + 2)
    if (len < 2) return null
    // start-of-frame markers carry the size; C4, C8 and CC are not frames
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
    }
    if (marker === 0xda) return null // image data begins: no frame header came before it
    i += 2 + len
  }
  return null
}

function ico(b: Buffer): PixelSize | null {
  if (b.length < 6 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null
  const n = b.readUInt16LE(4)
  let best: PixelSize | null = null
  for (let k = 0; k < n && 6 + (k + 1) * 16 <= b.length; k++) {
    // a 0 in the one-byte size fields means 256
    const width = (b[6 + k * 16] as number) || 256
    const height = (b[7 + k * 16] as number) || 256
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}

function avif(b: Buffer): PixelSize | null {
  if (b.length < 12 || !ascii(b, 4, 'ftyp')) return null
  // the image's spatial extents: an `ispe` property (4 bytes of version and flags, then width and height); the
  // largest one is the image itself (others describe thumbnails or tiles)
  let best: PixelSize | null = null
  for (let i = b.indexOf('ispe', 0, 'latin1'); i >= 0 && i + 16 <= b.length; i = b.indexOf('ispe', i + 4, 'latin1')) {
    const width = b.readUInt32BE(i + 8)
    const height = b.readUInt32BE(i + 12)
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}

/** The pixel size the header of a file of type `ext` states, or null. SVG has none (it is drawn at the view's size). */
export function imagePixelSize(header: Uint8Array, ext: ImageExtension): PixelSize | null {
  const b = Buffer.isBuffer(header) ? header : Buffer.from(header.buffer, header.byteOffset, header.byteLength)
  try {
    switch (ext) {
      case 'png':
        return png(b)
      case 'gif':
        return gif(b)
      case 'webp':
        return webp(b)
      case 'jpg':
      case 'jpeg':
        return jpeg(b)
      case 'ico':
        return ico(b)
      case 'avif':
        return avif(b)
      case 'svg':
        return null
    }
  } catch {
    return null // a read past the end of a malformed header
  }
}
