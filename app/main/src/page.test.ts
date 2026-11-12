// Open in Browser's check in main: which paths a window may have opened in the default browser.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPage } from '@kea/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PAGE_REFUSALS, resolvePage } from './page.ts'

let tmp: string
let work: string
let other: string

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-page-')))
  work = path.join(tmp, 'work tree')
  other = path.join(tmp, 'other')
  fs.mkdirSync(path.join(work, 'site'), { recursive: true })
  fs.mkdirSync(path.join(work, 'folder.html'))
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(work, 'site/index.html'), '<!doctype html><title>x</title>')
  fs.writeFileSync(path.join(work, 'site/Old Page #1.HTM'), '<p>old</p>')
  fs.writeFileSync(path.join(work, 'site/doc.xhtml'), '<html xmlns="http://www.w3.org/1999/xhtml"/>')
  fs.writeFileSync(path.join(work, 'site/app.js'), 'run()')
  fs.writeFileSync(path.join(work, 'run.html'), '<p>x</p>', { mode: 0o755 })
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=1\n')
  fs.writeFileSync(path.join(other, 'page.html'), '<p>elsewhere</p>')
  fs.symlinkSync(path.join(other, 'page.html'), path.join(work, 'site/escape.html'))
  fs.symlinkSync(path.join(work, '.env'), path.join(work, 'site/env.html'))
  fs.symlinkSync('index.html', path.join(work, 'site/alias.html'))
  execFileSync('mkfifo', [path.join(work, 'pipe.html')])
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Open in Browser', () => {
  it('U-FV-33 · main opens only a web page inside a working directory the asking window shows: other types, links that lead out or to another type, paths not as written, executable and special files are refused, each with words for the window', async () => {
    // a web page by its extension, whatever its case
    for (const p of ['index.html', 'a/Index.HTML', 'b.htm', 'c.xhtml', '/abs/d e.html']) expect(isPage(p), p).toBe(true)
    for (const p of ['index.html.txt', 'page.svg', 'notes.md', '.html', 'html', 'site/', 'a.html/b']) expect(isPage(p), p).toBe(false)

    const dirs = [work]
    // opened: its real path
    expect(await resolvePage(path.join(work, 'site/index.html'), dirs)).toEqual({ ok: true, real: path.join(work, 'site/index.html') })
    expect(await resolvePage(path.join(work, 'site/Old Page #1.HTM'), dirs)).toEqual({ ok: true, real: path.join(work, 'site/Old Page #1.HTM') })
    expect(await resolvePage(path.join(work, 'site/doc.xhtml'), dirs)).toEqual({ ok: true, real: path.join(work, 'site/doc.xhtml') })
    // a link that stays inside opens the file it names
    expect(await resolvePage(path.join(work, 'site/alias.html'), dirs)).toEqual({ ok: true, real: path.join(work, 'site/index.html') })

    const refused: [string, unknown, readonly string[], string][] = [
      ['another type', path.join(work, 'site/app.js'), dirs, 'type'],
      ['a link with a page’s name to a file of another type', path.join(work, 'site/env.html'), dirs, 'type'],
      ['a link that leads out', path.join(work, 'site/escape.html'), dirs, 'outside'],
      ['a page outside', path.join(other, 'page.html'), dirs, 'outside'],
      ['a page of a folder another window shows', path.join(work, 'site/index.html'), [other], 'outside'],
      ['a window that shows no folder', path.join(work, 'site/index.html'), [], 'outside'],
      ['traversal as written', `${work}/site/../site/index.html`, dirs, 'url'],
      ['a dot segment', `${work}/./site/index.html`, dirs, 'url'],
      ['a doubled slash', `${work}//site/index.html`, dirs, 'url'],
      ['a relative path', 'site/index.html', dirs, 'url'],
      ['a NUL byte', `${work}/site/index.html\0.html`, dirs, 'url'],
      ['not a string', 42, dirs, 'url'],
      ['a file that is not there', path.join(work, 'site/gone.html'), dirs, 'missing'],
      ['an executable page', path.join(work, 'run.html'), dirs, 'executable'],
      ['a folder with a page’s name', path.join(work, 'folder.html'), dirs, 'special'],
      ['a FIFO with a page’s name, without waiting on it', path.join(work, 'pipe.html'), dirs, 'special'],
    ]
    for (const [what, asked, ds, why] of refused) expect(await resolvePage(asked, ds), what).toEqual({ ok: false, why })

    // every refusal has words for the window
    for (const words of Object.values(PAGE_REFUSALS)) expect(words).toMatch(/^[A-Z].+[^.]$/)
  })
})
