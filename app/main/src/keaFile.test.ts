import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { keaFilePath, keaFileUrl, L } from '@kea/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveKeaFile, serveKeaFile, VisibleDirs } from './keaFile.ts'

let tmp: string
let work: string
let other: string

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-file-')))
  work = path.join(tmp, 'work tree')
  other = path.join(tmp, 'other')
  fs.mkdirSync(path.join(work, 'img'), { recursive: true })
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(work, 'img/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(work, 'img/drawing #1 ü.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
  fs.writeFileSync(path.join(work, 'notes.txt'), 'text\n')
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=1\n')
  fs.writeFileSync(path.join(work, 'empty.gif'), '')
  fs.writeFileSync(path.join(other, 'private.png'), 'elsewhere')
  fs.writeFileSync(path.join(other, 'id_rsa'), 'key')
  fs.symlinkSync(path.join(other, 'private.png'), path.join(work, 'img/escape.png'))
  fs.symlinkSync(path.join(other, 'id_rsa'), path.join(work, 'img/key.png'))
  fs.symlinkSync(path.join(work, '.env'), path.join(work, 'img/env.png'))
  fs.symlinkSync('logo.png', path.join(work, 'img/alias.png'))
  fs.symlinkSync(other, path.join(work, 'linked'))
  fs.symlinkSync(work, path.join(tmp, 'work-link'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function status(url: string, dirs: string[]): Promise<number> {
  const r = await serveKeaFile({ url, method: 'GET' }, dirs)
  await r.body?.cancel()
  return r.status
}

describe('kea-file://', () => {
  it('U-FV-9 · main serves an image only from inside a working directory a window shows: traversal, links that lead out, other types, special and oversized files resolve to nothing', async () => {
    const dirs = [work]
    // the URL form: every segment encoded, nothing resolved
    expect(keaFileUrl('/a b/c#d/é.png', 12.9)).toBe('kea-file://f/a%20b/c%23d/%C3%A9.png?v=12')
    expect(keaFilePath(keaFileUrl('/a b/c#d/é.png', 3))).toBe('/a b/c#d/é.png')
    for (const bad of [
      'kea-file://f/',
      'kea-file://f',
      'kea-file://other/a.png',
      'kea-file://user@f/a.png',
      'kea-file://f:80/a.png',
      'kea://f/a.png',
      'file:///a.png',
      'kea-file://f/a/../b.png',
      'kea-file://f/a/./b.png',
      'kea-file://f/a//b.png',
      'kea-file://f/a/%2e%2e/b.png',
      'kea-file://f/a%2fb.png',
      'kea-file://f/a%00.png',
      'kea-file://f/%zz.png',
    ])
      expect(keaFilePath(bad), bad).toBeNull()

    // served: an image inside, with its type and the headers that keep it inert
    const ok = await serveKeaFile({ url: keaFileUrl(path.join(work, 'img/logo.png'), 1), method: 'GET' }, dirs)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(ok.headers.get('content-length')).toBe('4')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('content-security-policy')).toContain('sandbox')
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47])
    const svg = await serveKeaFile({ url: keaFileUrl(path.join(work, 'img/drawing #1 ü.svg')), method: 'GET' }, dirs)
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(await svg.text()).toContain('<svg')
    // a link that stays inside, the directory reached through a link, an empty file
    expect(await status(keaFileUrl(path.join(work, 'img/alias.png')), dirs)).toBe(200)
    expect(await status(keaFileUrl(path.join(work, 'img/logo.png')), [path.join(tmp, 'work-link')])).toBe(200)
    expect(await status(keaFileUrl(path.join(tmp, 'work-link/img/logo.png')), dirs)).toBe(200)
    expect(await status(keaFileUrl(path.join(work, 'empty.gif')), dirs)).toBe(200)

    // refused
    const refused: [string, string, number][] = [
      ['a file outside', keaFileUrl(path.join(other, 'private.png')), 403],
      ['a link that leads out', keaFileUrl(path.join(work, 'img/escape.png')), 403],
      ['a link to a file that is no image', keaFileUrl(path.join(work, 'img/key.png')), 403],
      ['a link, inside, to a file that is no image', keaFileUrl(path.join(work, 'img/env.png')), 403],
      ['through a linked directory', keaFileUrl(path.join(work, 'linked/private.png')), 403],
      ['traversal, as written', `kea-file://f${work.split('/').map(encodeURIComponent).join('/')}/img/../../other/private.png`, 400],
      ['traversal, encoded', `kea-file://f${work.split('/').map(encodeURIComponent).join('/')}/img/%2e%2e/%2e%2e/other/private.png`, 400],
      ['a text file', keaFileUrl(path.join(work, 'notes.txt')), 403],
      ['a dotfile', keaFileUrl(path.join(work, '.env')), 403],
      ['the directory itself', keaFileUrl(work), 403],
      ['nothing there', keaFileUrl(path.join(work, 'img/none.png')), 404],
      ['a sibling whose name starts the same', keaFileUrl(`${work}-2/a.png`), 404],
      ['another host', `kea-file://app/${path.join(work, 'img/logo.png')}`, 400],
    ]
    for (const [name, url, want] of refused) expect(await status(url, dirs), name).toBe(want)
    // a sibling directory whose name only starts like the working directory is not inside it
    fs.mkdirSync(`${work}-2`)
    fs.writeFileSync(`${work}-2/a.png`, 'x')
    expect(await status(keaFileUrl(`${work}-2/a.png`), dirs)).toBe(403)
    // no window shows a session: nothing at all resolves
    expect(await status(keaFileUrl(path.join(work, 'img/logo.png')), [])).toBe(403)
    // only GET
    expect((await serveKeaFile({ url: keaFileUrl(path.join(work, 'img/logo.png')), method: 'POST' }, dirs)).status).toBe(405)
    // a FIFO named like an image: not opened to wait, not served
    execFileSync('/usr/bin/mkfifo', [path.join(work, 'img/pipe.png')]) // os-ok: in /usr/bin on both systems
    expect(await resolveKeaFile(keaFileUrl(path.join(work, 'img/pipe.png')), dirs)).toEqual({ ok: false, status: 403, why: 'special' })
    // over L.imageMaxBytes
    const big = path.join(work, 'img/big.png')
    fs.closeSync(fs.openSync(big, 'w'))
    fs.truncateSync(big, L.imageMaxBytes + 1)
    expect(await resolveKeaFile(keaFileUrl(big), dirs)).toEqual({ ok: false, status: 413, why: 'large' })
    // the reason reaches the log hook, never the path
    const seen: unknown[] = []
    await serveKeaFile({ url: keaFileUrl(path.join(other, 'private.png')), method: 'GET' }, dirs, (why, code) => seen.push([why, code]))
    expect(seen).toEqual([['outside', 403]])

    // the directories follow core's messages: per window, dropped with the window and with core
    const v = new VisibleDirs()
    v.set(1, [work])
    v.set(2, [work, other])
    v.set(3, ['relative/never'])
    expect(v.all().sort()).toEqual([other, work].sort())
    expect(v.size).toBe(2)
    v.set(2, [])
    expect(v.all()).toEqual([work])
    v.drop(1)
    expect(v.all()).toEqual([])
    v.set(4, [other])
    v.clear()
    expect(v.size).toBe(0)
  })
})
