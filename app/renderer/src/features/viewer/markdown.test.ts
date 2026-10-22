import { describe, expect, it } from 'vitest'
import { fenceLanguage, imageUrl, linkTarget, renderMarkdown, worktreeTarget } from './markdown.ts'

const ctx = { cwd: '/Users/me/work tree', path: 'docs/guide/README.md', version: 7 }

describe('the Markdown preview is inert', () => {
  it('U-FV-9 · raw HTML is text, only web and mail links are links, remote images are never requested, and an image comes only from inside the worktree', () => {
    const html = renderMarkdown(
      [
        '# Title',
        '',
        '<script>window.pwned = 1</script>',
        '<img src="https://evil.example/x.png" onerror="alert(1)">',
        '<iframe src="https://evil.example"></iframe>',
        'inline <b onclick="alert(1)">bold</b> and <style>body{display:none}</style>',
        '',
        '[site](https://example.com/a?b=1&c=2 "a title") [mail](mailto:a@example.com) <https://auto.example/x>',
        // os-ok: test data
        '[js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [data](data:text/html,<script>1</script>) [file](file:///etc/passwd) [vb](vbscript:x) [app](vscode://x) [proto](//evil.example/x)',
        '[rel](../other.md) [deep](./img/../notes.md#section) [root](/CLAUDE.md) [out](../../../etc/passwd) [anchor](#top)',
        '',
        '![remote](https://evil.example/track.png) ![proto](//evil.example/t.gif) ![data](data:image/png;base64,AAAA) ![file](file:///etc/x.png)', // os-ok: test data
        '![local](img/logo.png "the logo") ![up](../shared/a%20b.svg) ![root](/assets/x.webp?raw=1) ![climb](../../../secret.png) ![notimage](../notes.txt) ![](img/empty-alt.gif)',
        '',
        '```ts title="x"',
        'const a = "<script>alert(1)</script>"',
        '```',
        '',
        '```',
        '<b>plain fence</b>',
        '```',
        '',
        '    indented <i>code</i>',
      ].join('\n'),
      ctx,
    )
    // raw HTML never becomes markup: every tag of the source arrives escaped
    for (const tag of ['<script', '<iframe', '<style', '<b ', '<b>', '<i>', 'onerror="', 'onclick="']) expect(html.includes(tag), tag).toBe(false)
    expect(html).toContain('&lt;script&gt;window.pwned = 1&lt;/script&gt;')
    expect(html).toContain('&lt;iframe')
    // the only tags in the output are the ones the renderer makes
    const tags = new Set([...html.matchAll(/<\/?([a-zA-Z0-9]+)/g)].map((m) => m[1]))
    expect([...tags].sort()).toEqual(['a', 'code', 'h1', 'img', 'p', 'pre', 'span'])

    // links: web and mail keep their target; a refused scheme gets none (its text is shown, its URL is gone)
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" title="a title">site</a>')
    expect(html).toContain('<a href="mailto:a@example.com">mail</a>')
    expect(html).toContain('<a href="https://auto.example/x">https://auto.example/x</a>')
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
    // (a bare web address in the text is a link too, also inside what was raw HTML: text that opens the browser when clicked)
    expect(hrefs).toEqual(['https://evil.example/x.png', 'https://evil.example', 'https://example.com/a?b=1&amp;c=2', 'mailto:a@example.com', 'https://auto.example/x'])
    for (const h of hrefs) expect(/^(https?:\/\/|mailto:)/.test(h!), h).toBe(true)
    for (const scheme of ['javascript:', 'data:', 'file:', 'vbscript:', 'vscode:']) expect(hrefs.some((h) => h!.toLowerCase().startsWith(scheme)), scheme).toBe(false)
    for (const dead of ['js', 'JS', 'data', 'file', 'vb', 'app', 'proto']) expect(html).toContain(`<a>${dead}</a>`)
    expect(html.toLowerCase().includes('javascript:')).toBe(false)
    // relative links name files of the worktree (opened in the viewer); one that climbs out, and an anchor, lead nowhere
    expect([...html.matchAll(/<a data-path="([^"]*)"/g)].map((m) => m[1])).toEqual(['docs/other.md', 'docs/guide/notes.md', 'CLAUDE.md'])
    expect(html).toContain('<a>out</a>')
    expect(html).toContain('<a>anchor</a>')

    // images: only kea-file:// URLs, only inside the worktree, only image types; the rest is their alt text
    const srcs = [...html.matchAll(/<img src="([^"]*)"/g)].map((m) => m[1])
    expect(srcs).toEqual([
      'kea-file://f/Users/me/work%20tree/docs/guide/img/logo.png?v=7',
      'kea-file://f/Users/me/work%20tree/docs/shared/a%20b.svg?v=7',
      'kea-file://f/Users/me/work%20tree/assets/x.webp?v=7',
      'kea-file://f/Users/me/work%20tree/docs/guide/img/empty-alt.gif?v=7',
    ])
    expect(html).toContain('<img src="kea-file://f/Users/me/work%20tree/docs/guide/img/logo.png?v=7" alt="local" title="the logo">')
    for (const alt of ['remote', 'proto', 'data', 'file', 'climb', 'notimage']) expect(html).toContain(`<span class="md-no-image">${alt}</span>`)
    expect(html.includes('evil.example/track')).toBe(false)
    expect(html.includes('base64')).toBe(false)

    // fences: escaped text, the language as data for the worker; never markup
    expect(html).toContain('<pre><code data-lang="typescript">const a = &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;\n</code></pre>')
    expect(html).toContain('<pre><code>&lt;b&gt;plain fence&lt;/b&gt;\n</code></pre>')

    // ── the pieces ──
    expect(worktreeTarget(ctx, 'a.png')).toBe('docs/guide/a.png')
    expect(worktreeTarget(ctx, './a/./b/../c.png')).toBe('docs/guide/a/c.png')
    expect(worktreeTarget(ctx, '../../top.png')).toBe('top.png')
    expect(worktreeTarget(ctx, '/top.png')).toBe('top.png')
    expect(worktreeTarget({ path: 'README.md' }, 'img/a.png')).toBe('img/a.png')
    for (const out of ['../../../x.png', '/../x.png', '../..', '../../..', '', '#a', '?q', 'https://x/y.png', 'HTTP://x', '//x/y.png', 'file:///x.png', 'a\\b.png', '%zz.png', 'a%00.png', '%2e%2e/%2e%2e/%2e%2e/x.png']) expect(worktreeTarget(ctx, out), out).toBeNull()
    // an encoded climb is still a climb, and still held inside
    expect(worktreeTarget(ctx, '%2e%2e/x.png')).toBe('docs/x.png')
    expect(imageUrl(ctx, 'a.txt')).toBeNull()
    expect(imageUrl(ctx, 'a.PNG')).toBe('kea-file://f/Users/me/work%20tree/docs/guide/a.PNG?v=7')
    expect(imageUrl({ cwd: '/w/', path: 'r.md' }, 'a.png')).toBe('kea-file://f/w/a.png')
    expect(linkTarget(ctx, 'https://example.com')).toEqual({ kind: 'external', url: 'https://example.com' })
    expect(linkTarget(ctx, 'x.md')).toEqual({ kind: 'file', path: 'docs/guide/x.md' })
    // os-ok: test data
    for (const no of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'kea://app/index.html', 'kea-file://f/etc/passwd', '#x', '../../../x']) expect(linkTarget(ctx, no), no).toBeNull()

    expect(fenceLanguage('ts')).toBe('typescript')
    expect(fenceLanguage('typescript {1,3}')).toBe('typescript')
    expect(fenceLanguage('Python title="a"')).toBe('python')
    expect(fenceLanguage('sh')).toBe('shellscript')
    expect(fenceLanguage('shell')).toBe('shellscript')
    expect(fenceLanguage('c++')).toBe('cpp')
    expect(fenceLanguage('json')).toBe('json')
    for (const none of ['', 'text', 'plaintext', 'no-such-lang', '"><script>', '__proto__', 'constructor']) expect(fenceLanguage(none), none).toBeNull()
  })
})
