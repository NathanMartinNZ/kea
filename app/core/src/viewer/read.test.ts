import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { L } from '@kea/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imagePixelSize } from './image.ts'
import { readFile, resolveInside } from './read.ts'

let tmp: string
let cwd: string
let outside: string

/** A PNG header (signature + IHDR) saying `w` × `h`; no pixel data follows. */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-viewer-read-')))
  cwd = path.join(tmp, 'work')
  outside = path.join(tmp, 'elsewhere')
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'const a = 1\r\n')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not for the viewer\n')
  fs.mkdirSync(path.join(outside, 'dir'))
  fs.writeFileSync(path.join(outside, 'dir/deep.txt'), 'nor this\n')
  fs.symlinkSync('src/a.ts', path.join(cwd, 'inside-link'))
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'escape'))
  fs.symlinkSync('../elsewhere/secret.txt', path.join(cwd, 'relative-escape'))
  fs.symlinkSync(path.join(outside, 'dir'), path.join(cwd, 'linked-dir'))
  fs.symlinkSync(path.join(outside, 'nothing-here'), path.join(cwd, 'dangling-out'))
  fs.symlinkSync('src/nothing-here', path.join(cwd, 'dangling-in'))
  fs.symlinkSync('inside-link', path.join(cwd, 'link-to-link'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('reading a file for the viewer', () => {
  it('U-FV-12 · a path is read only where it really lies inside the working directory: links inside open their target, links that lead out are named and never read, special files are never opened to wait', async () => {
    const text = await readFile(cwd, 'src/a.ts')
    expect(text.kind).toBe('text')
    expect(text.link).toBeNull()
    expect(Buffer.from(text.text!.bytes).toString()).toBe('const a = 1\r\n')
    expect(text.text).toMatchObject({ encoding: 'utf8', invalid: false, eol: 'crlf' })
    expect(text).toMatchObject({ size: 13, openable: true })

    // a symlink inside the directory (and a link to it): the target's contents, and where it leads
    for (const link of ['inside-link', 'link-to-link']) {
      const r = await readFile(cwd, link)
      expect(r).toMatchObject({ kind: 'text', link: 'src/a.ts' })
      expect(Buffer.from(r.text!.bytes).toString()).toBe('const a = 1\r\n')
    }

    // out of the directory, by an absolute link, a relative one, or through a linked directory: the target, no contents
    expect(await readFile(cwd, 'escape')).toEqual({ kind: 'outside', size: 0, mtimeMs: 0, link: path.join(outside, 'secret.txt'), text: null, image: null, openable: false })
    expect(await readFile(cwd, 'relative-escape')).toMatchObject({ kind: 'outside', link: path.join(outside, 'secret.txt'), text: null })
    expect(await readFile(cwd, 'linked-dir/deep.txt')).toMatchObject({ kind: 'outside', link: path.join(outside, 'dir/deep.txt'), text: null })
    expect(await readFile(cwd, 'dangling-out')).toMatchObject({ kind: 'outside', link: path.join(outside, 'nothing-here'), text: null })
    expect(await resolveInside(cwd, 'escape')).toMatchObject({ state: 'outside', real: '' })

    // nothing there; a link to nothing inside; a directory; a working directory that is gone
    expect(await readFile(cwd, 'src/none.ts')).toMatchObject({ kind: 'missing', text: null })
    expect(await readFile(cwd, 'dangling-in')).toMatchObject({ kind: 'missing', text: null })
    expect(await readFile(cwd, 'src')).toMatchObject({ kind: 'directory', text: null })
    expect(await readFile(path.join(tmp, 'no-such-folder'), 'a.ts')).toMatchObject({ kind: 'missing' })

    // a FIFO where a file should be: not a regular file, so never read, and the open does not wait for a writer
    execFileSync('/usr/bin/mkfifo', [path.join(cwd, 'pipe.txt')]) // os-ok: in /usr/bin on both systems
    expect(await readFile(cwd, 'pipe.txt')).toMatchObject({ kind: 'missing', text: null })

    // the same working directory reached through a link resolves the same (macOS's /tmp, a linked worktree root)
    fs.symlinkSync(cwd, path.join(tmp, 'work-link'))
    expect(await readFile(path.join(tmp, 'work-link'), 'src/a.ts')).toMatchObject({ kind: 'text', link: null })
    expect(await readFile(path.join(tmp, 'work-link'), 'escape')).toMatchObject({ kind: 'outside' })

    // Over the load limit nothing is read (a sparse file: no bytes written); a NUL makes it binary
    const big = path.join(cwd, 'big.log')
    fs.closeSync(fs.openSync(big, 'w'))
    fs.truncateSync(big, L.viewerMaxBytes + 1)
    expect(await readFile(cwd, 'big.log')).toMatchObject({ kind: 'large', size: L.viewerMaxBytes + 1, text: null })
    fs.writeFileSync(path.join(cwd, 'blob.bin'), Buffer.from([1, 2, 0, 3]))
    expect(await readFile(cwd, 'blob.bin')).toMatchObject({ kind: 'binary', size: 4, text: null })
    // an executable is never offered to the default app
    fs.writeFileSync(path.join(cwd, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    expect(await readFile(cwd, 'run.sh')).toMatchObject({ kind: 'text', openable: false })

    // images: described from the header, not read; over the pixel limit, or with no size to be found, not decodable
    fs.writeFileSync(path.join(cwd, 'ok.png'), pngHeader(640, 480))
    expect(await readFile(cwd, 'ok.png')).toMatchObject({ kind: 'image', text: null, image: { width: 640, height: 480, decodable: true } })
    fs.writeFileSync(path.join(cwd, 'huge.PNG'), pngHeader(10_000, 5_001))
    expect(10_000 * 5_001).toBeGreaterThan(L.imageMaxPixels)
    expect(await readFile(cwd, 'huge.PNG')).toMatchObject({ kind: 'image', image: { width: 10_000, height: 5_001, decodable: false } })
    fs.writeFileSync(path.join(cwd, 'broken.jpg'), 'not a jpeg at all')
    expect(await readFile(cwd, 'broken.jpg')).toMatchObject({ kind: 'image', image: { width: null, height: null, decodable: false } })
    fs.writeFileSync(path.join(cwd, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect(await readFile(cwd, 'pic.svg')).toMatchObject({ kind: 'image', image: { width: null, height: null, decodable: true } })
    // the SVG Source toggle reads it as text
    expect(await readFile(cwd, 'pic.svg', { source: true })).toMatchObject({ kind: 'text', image: null })
    const heavy = path.join(cwd, 'heavy.png')
    fs.writeFileSync(heavy, pngHeader(10, 10))
    fs.truncateSync(heavy, L.imageMaxBytes + 1)
    expect(await readFile(cwd, 'heavy.png')).toMatchObject({ kind: 'image', image: { width: 10, height: 10, decodable: false } })

    // the other headers
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x20, 0x03, 0x58, 0x02])])
    expect(imagePixelSize(gif, 'gif')).toEqual({ width: 800, height: 600 })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03])
    expect(imagePixelSize(jpeg, 'jpg')).toEqual({ width: 512, height: 256 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'latin1')
    webp.write('WEBPVP8X', 8, 'latin1')
    webp.writeUIntLE(1919, 24, 3)
    webp.writeUIntLE(1079, 27, 3)
    expect(imagePixelSize(webp, 'webp')).toEqual({ width: 1920, height: 1080 })
    const ico = Buffer.alloc(6 + 32)
    ico.writeUInt16LE(1, 2)
    ico.writeUInt16LE(2, 4)
    ico[6] = 16
    ico[7] = 16
    ico[22] = 0
    ico[23] = 0
    expect(imagePixelSize(ico, 'ico')).toEqual({ width: 256, height: 256 })
    const avif = Buffer.alloc(64)
    avif.write('ftypavif', 4, 'latin1')
    avif.write('ispe', 30, 'latin1')
    avif.writeUInt32BE(4000, 38)
    avif.writeUInt32BE(3000, 42)
    expect(imagePixelSize(avif, 'avif')).toEqual({ width: 4000, height: 3000 })
    // cut-off and foreign headers are no size, never an error
    for (const ext of ['png', 'gif', 'webp', 'jpg', 'jpeg', 'ico', 'avif', 'svg'] as const) {
      expect(imagePixelSize(Buffer.alloc(0), ext)).toBeNull()
      expect(imagePixelSize(Buffer.from([0xff, 0xd8, 0xff]), ext)).toBeNull()
      expect(imagePixelSize(pngHeader(1, 1).subarray(0, 20), ext)).toBeNull()
    }
  })
})
