import { describe, expect, it } from 'vitest'
import { KEA_HOME_MARK, outsidePaths, PATH_MARK, reportLines, resourcesSection, scrubPaths, scrubWork } from './diagnostics.ts'
import { L } from './generated/limits.ts'

const HOME = '/private/var/folders/ab/T/kea-home'
const o = { home: [HOME, '/var/folders/ab/T/kea-home'], roots: ['/Users/someone', '/Volumes/Work Disk/my project'] }

describe('Copy diagnostics: paths', () => {
  it('U-DIAG-1 · scrubPaths: the home becomes <KEA_HOME>, every other path <path>; URLs, words and numbers stay', () => {
    // (what a path with spaces, a relative path and a branch name become: U-DIAG-8)
    const cases: [string, string][] = [
      [`log ${HOME}/logs/core.log rotated`, `log ${KEA_HOME_MARK}/logs/core.log rotated`],
      // the home by its other name (a symlinked temp folder)
      ['at /var/folders/ab/T/kea-home/run', `at ${KEA_HOME_MARK}/run`],
      // a folder beside the home is not the home
      [`${HOME}-2/kea.db`, PATH_MARK],
      ['cwd=/Users/someone/dev/app', `cwd=${PATH_MARK}`],
      ['spawn /opt/homebrew/bin/git ENOENT', `spawn ${PATH_MARK} ENOENT`],
      // a path under a home folder runs to the end of its line: its names may hold spaces
      ['(see /etc/hosts), then ./a.sh or ../b/c; ~/notes.md and more', `(see ${PATH_MARK}), then ${PATH_MARK} or ${PATH_MARK}; ${PATH_MARK}`], // os-ok: test data
      // a known root with a space in it goes whole, and what follows it
      ['fatal: not a git repository: /Volumes/Work Disk/my project/.git', `fatal: not a git repository: ${PATH_MARK}`],
      // between quotes a path may hold spaces
      [`ENOENT: no such file or directory, open '/srv/build output/a b.txt'`, `ENOENT: no such file or directory, open '${PATH_MARK}'`],
      ['{"path":"/srv/x y/z","n":3}', `{"path":"${PATH_MARK}","n":3}`],
      // file: URLs, in the home and out of it
      ['open file:///Users/someone/a%20b.html now', `open ${PATH_MARK}`],
      ['open file:///opt/docs/a%20b.html now', `open ${PATH_MARK} now`],
      [`open file://${HOME}/reports/r.json`, `open ${KEA_HOME_MARK}/reports/r.json`],
      // a known root inside another URL's path
      ['vscode://file/Users/someone/dev/app/a.ts:3', `vscode://file${PATH_MARK}`],
      // not paths
      ['GET https://example.com/a/b?c=1 took 3/4 of 10 ms on 2026/10/13, 1.5/2.5 done', 'GET https://example.com/a/b?c=1 took 3/4 of 10 ms on 2026/10/13, 1.5/2.5 done'],
      ['a / b, x </tag>, core.files.evictions 12, $HOME is set, ~ 5 ms', 'a / b, x </tag>, core.files.evictions 12, $HOME is set, ~ 5 ms'],
      // a word with a slash that is no URL and no number is read as a relative path, whatever it is; one that follows goes with it
      ['wanted text/plain, and/or more', `wanted ${PATH_MARK} more`],
    ]
    for (const [text, want] of cases) {
      const got = scrubPaths(text, o)
      expect(got, text).toBe(want)
      expect(outsidePaths(got), text).toEqual([])
      // applying it again changes nothing
      expect(scrubPaths(got, o), text).toBe(got)
    }
    // a text with no home given: every path goes
    expect(scrubPaths(`${HOME}/logs`, { home: [] })).toBe(PATH_MARK)
    // and the checker finds what an unscrubbed text names
    expect(outsidePaths('at "/a b/c" file:///x cwd=/Users/someone/dev and on')).toEqual(['/a b/c', 'file:///x', '/Users/someone/dev and on'])
  })

  it('U-DIAG-8 · no word of a path is left behind: a path with spaces goes whole (between quotes to the closing quote, in a JSON string, cut short, under a home or a volume to the end of its line), and so do ~user, $HOME, URL-encoded and relative paths, file-share URLs and branch names; outsidePaths names what a text still holds', () => {
    const v = { home: ['/Users/u/.kea'], roots: ['/Users/u', '/private/var/folders/xx/T', '/Users/u/Code/My Project', '/Users/u/.kea-worktrees'], names: ['topic-acme-launch'] }
    // [what it is, the text, what it becomes, words of the path that must be gone]
    const cases: [string, string, string, string[]][] = [
      ['a quoted path with spaces under the home folder', `ENOENT: no such file or directory, open '/Users/u/Documents/Client Acme/contracts/q3 plan.md'`, `ENOENT: no such file or directory, open '${PATH_MARK}'`, ['Acme', 'contracts', 'q3', 'plan.md']],
      ['the same between double quotes', `could not read "/Users/u/Documents/Client Acme/contracts/q3 plan.md"`, `could not read "${PATH_MARK}"`, ['Acme', 'q3', 'plan.md']],
      ['an apostrophe in a quoted path', `open '/Users/u/Documents/Dad's Stuff/will.txt' failed`, `open '${PATH_MARK}' failed`, ['Dad', 'Stuff', 'will']],
      ['unquoted under the home folder: to the end of the line', 'not a git repository: /Users/u/Documents/Client Acme/site', `not a git repository: ${PATH_MARK}`, ['Acme', 'site']],
      ['a name with a space as the last one', 'cannot read /Users/u/Documents/My Notes', `cannot read ${PATH_MARK}`, ['Notes']],
      // os-ok: test data
      ['Application Support', `open '/Users/u/Library/Application Support/Code/User/settings.json'`, `open '${PATH_MARK}'`, ['Support', 'settings.json']],
      ['a volume, unquoted', 'cannot open /Volumes/Client Disk/Acme Corp/secret plan.txt now', `cannot open ${PATH_MARK}`, ['Disk', 'Acme', 'Corp', 'secret', 'plan.txt']],
      ['a volume, quoted', `cannot open '/Volumes/Client Disk/Acme Corp/secret plan.txt' now`, `cannot open '${PATH_MARK}' now`, ['Disk', 'Acme', 'secret']],
      // os-ok: test data
      ['a system path with spaces: through the last word that has a slash', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code: bad interpreter', `${PATH_MARK} bad interpreter`, ['Studio', 'Code.app', 'Resources']],
      ['a system path without: what follows it stays', 'spawn /opt/homebrew/bin/git ENOENT', `spawn ${PATH_MARK} ENOENT`, ['homebrew']],
      ['a file URL, spaces encoded', 'loading file:///Users/u/Documents/Client%20Acme/a.html failed', `loading ${PATH_MARK}`, ['Acme', 'a.html']],
      ['a file URL with a raw space', 'loading file:///Users/u/Documents/Client Acme/a.html failed', `loading ${PATH_MARK}`, ['Acme', 'a.html']],
      ['a share', 'mount smb://server/share/Client Acme/x', `mount ${PATH_MARK}`, ['server', 'Acme']],
      ['a tilde path', 'reading ~/Documents/Client Acme/x.txt', `reading ${PATH_MARK}`, ['Client', 'Acme', 'x.txt']],
      ['another user’s', 'reading ~u/Documents/x.txt', `reading ${PATH_MARK}`, ['Documents']],
      ['$HOME', 'reading $HOME/Documents/acme/x.txt and ${HOME}/b c', `reading ${PATH_MARK}`, ['Documents', 'acme']],
      ['a relative path in a message', 'file src/clients/acme/plan.md is too large to show', `file ${PATH_MARK} is too large to show`, ['clients', 'acme', 'plan.md']],
      ['one with ./', 'cannot stat ./clients/acme/plan.md', `cannot stat ${PATH_MARK}`, ['acme']],
      ['git: a branch of Kea’s and its worktree', `fatal: 'kea/acme-secret-launch' is already checked out at '/Users/u/.kea-worktrees/site/acme-secret-launch'`, `fatal: '${PATH_MARK}' is already checked out at '${PATH_MARK}'`, ['acme', 'kea/']],
      ['a branch, a remote and a slug, bare', 'branch kea/acme-billing tracks origin/acme-billing of git@example.invalid:acme-corp/site.git', `branch ${PATH_MARK}`, ['acme']],
      ['a pathspec with a space', `error: pathspec 'clients/acme corp/plan.md' did not match any file(s) known to git`, `error: pathspec '${PATH_MARK}' did not match any file(s) known to git`, ['clients', 'acme', 'corp', 'plan.md']],
      ['a known root inside another URL', 'open vscode://file/Users/u/Code/acme/x.ts and more', `open vscode://file${PATH_MARK}`, ['acme']],
      ['a URL-encoded path', 'open x-callback://open?path=%2FUsers%2Fu%2FCode%2Facme%2Fx.ts&line=3 and path=%2Fsrv%2Facme', `open x-callback://open?path=${PATH_MARK}&line=3 and path=${PATH_MARK}`, ['acme', 'Users']],
      // os-ok: test data
      ['paths in JSON', 'payload {"cwd":"/Users/u/Code/acme site/app","file":"/etc/hosts","rel":"clients/acme corp","n":3}', `payload {"cwd":"${PATH_MARK}","file":"${PATH_MARK}","rel":"${PATH_MARK}","n":3}`, ['acme', 'site', 'hosts', 'corp']],
      ['JSON inside a JSON string', 'body="{\\"cwd\\":\\"/Users/u/Code/acme site/app\\",\\"ok\\":true}"', 'body="{\\"cwd\\":\\"<path>\\",\\"ok\\":true}"', ['acme', 'site']],
      ['a path cut at the cap (no closing quote)', 'payload {"cwd":"/Users/u/Code/acme site/app/very/long', `payload {"cwd":"${PATH_MARK}`, ['acme', 'site', 'long']],
      ['a stack in a JSON string: each line of it by itself', 'stack="Error: no\\n    at open (/Users/u/Code/acme site/a.ts:1:2)\\n    at run (node:internal/x:3:4)\\n    at last"', `stack="Error: no\\n    at open (${PATH_MARK}\\n    at run (node:${PATH_MARK})\\n    at last"`, ['acme', 'site']],
      ['backslash-escaped spaces', 'cd /Users/u/Code/acme\\ site/app', `cd ${PATH_MARK}`, ['acme', 'site']],
      ['the home, a folder beside it, a name that starts like it', '/Users/u/.kea/logs/core.log and /Users/u/.kea-dev/x and /Users/u/.keachain', `${KEA_HOME_MARK}/logs/core.log and ${PATH_MARK}`, ['kea-dev', 'keachain']],
      ['out of the home by ..', 'read /Users/u/.kea/../Documents/acme.txt', `read ${PATH_MARK}`, ['Documents', 'acme']],
      ['a list (PATH)', 'PATH=/Users/u/.local/bin:/opt/homebrew/bin:/Users/u/Code/acme tools/bin', `PATH=${PATH_MARK}`, ['local', 'homebrew', 'acme', 'tools']],
      ['a list that starts outside the home folder', 'PATH=/opt/homebrew/bin:/Users/u/Code/acme tools/bin', `PATH=${PATH_MARK}`, ['homebrew', 'acme', 'tools']],
      ['key=value, in a text of its own (a log line’s fields are each scrubbed by themselves: U-DIAG-3)', 'cwd=/Users/u/Code/acme/site title=x', `cwd=${PATH_MARK}`, ['acme']],
      ['parenthesised', '(at /Users/u/Code/acme/site/a.ts:12:3)', `(at ${PATH_MARK}`, ['acme']],
      ['a no-break space', 'open /Users/u/Documents/Client\u00a0Acme/x.txt', `open ${PATH_MARK}`, ['Acme', 'x.txt']],
      ['the temp folder by both names', '/var/folders/xx/T/kea-fixture-1/demo and /private/var/folders/xx/T/kea-fixture-1/demo', `${PATH_MARK} and ${PATH_MARK}`, ['fixture']],
      ['between angle brackets', '</Users/u/Code/acme/site>', `<${PATH_MARK}`, ['acme']],
      ['after a dash or a letter', '--cwd=/Users/u/Code/acme/site -C/Users/u/Code/acme/site x-/Users/u/q', `--cwd=${PATH_MARK}`, ['acme']],
      ['after a letter', 'a/Users/u/Code/acme and b', `a${PATH_MARK}`, ['acme']],
      ['a text an earlier scrub left a tail in', `open '${PATH_MARK} Acme/contracts/q3 plan.md' and ${PATH_MARK} Disk/Acme Corp/secret`, `open '${PATH_MARK}' and ${PATH_MARK}`, ['Acme', 'q3', 'Disk', 'Corp']],
      // not paths: these stay
      ['a URL of the app, a web URL, numbers and dates', 'at kea://app/assets/index-1a2b.js:10:2, GET http://localhost:3000/acme/list took 3/4 of 10 ms on 2026/10/13', 'at kea://app/assets/index-1a2b.js:10:2, GET http://localhost:3000/acme/list took 3/4 of 10 ms on 2026/10/13', []],
    ]
    for (const [what, text, want, gone] of cases) {
      const got = scrubPaths(text, v)
      expect(got, what).toBe(want)
      for (const word of gone) expect(got, `${what}: ${word}`).not.toContain(word)
      expect(outsidePaths(got), what).toEqual([])
      expect(scrubPaths(got, v), what).toBe(got)
      // the checker alone, with no folder named to it, finds every one of these texts wanting
      if (gone.length) expect(outsidePaths(text), what).not.toEqual([])
    }
    // a branch with no slash in it is known by its name, and only between quotes; the checker, which is told no name, cannot know it
    const named = `fatal: a branch named 'topic-acme-launch' already exists, "topic-acme-launch" too; topic is a word`
    expect(scrubPaths(named, v)).toBe(`fatal: a branch named '${PATH_MARK}' already exists, "${PATH_MARK}" too; topic is a word`)
    expect(outsidePaths(named)).toEqual([])
    // what it reports is what the scrub would take out
    expect(outsidePaths(`open '${PATH_MARK} Acme/contracts/q3 plan.md'`)).toEqual([`${PATH_MARK} Acme/contracts/q3 plan.md`])
    expect(outsidePaths('see /etc/hosts and "a b/c"')).toEqual(['/etc/hosts', 'b/c']) // os-ok: test data
    // every line by itself: a path does not run over a line break (one with a line break in a name is not known as one)
    expect(scrubPaths('cd /Users/u/a b\nnext line stays\n"/Users/u/c\nd e"', v)).toBe(`cd ${PATH_MARK}\nnext line stays\n"${PATH_MARK}\nd e"`)
    // a known limit, as the module's header says: outside a home, a volume and quotes, the words after the last space of a path's last name stay
    expect(scrubPaths('wrote /srv/build output', v)).toBe(`wrote ${PATH_MARK} output`)
  })

  it('U-DIAG-9 · whatever a text is made of, a name that stands only inside a path under a home folder, a volume or quotes never survives the scrub, the scrub applied again changes nothing, and the checker finds nothing left', () => {
    // a small generator with a fixed seed: the same texts on every run
    let seed = 0x5eed
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return (seed >>> 8) % n
    }
    const pick = <T,>(xs: readonly T[]): T => xs[rnd(xs.length)] as T
    const NAME = 'Zq7name'
    const starts = ['/Users/u/', '/Users/someone else/', '/Volumes/Disk One/', '~/', '~u/', '$HOME/', '${HOME}/', 'file:///Users/u/', '/Users/u/Code/My Project/', '/home/u/']
    const mids = ['', 'Documents/', 'a b/', 'x/y z/', "it's/", 'q=1/', 'a:b/', 'c,d/', '(e)/', '[f]/']
    const ends = ['', '/', '/file.txt', ' two/x.md', ' tail', '.app/Contents/x', ':12:3']
    const before = ['', 'open ', 'cwd=', 'error: ', '(at ', 'a, b; ', 'see https://example.invalid/x and ', 'PATH=/opt/bin:', '-C', 'spawn /usr/bin/env ENOENT ', '3/4 of ', 'text/plain ']
    const after = ['', ' failed', ' and/or more', ' n=3', ')', ', then /etc/hosts', ' "quoted"', " it's over"] // os-ok: test data
    const quotes: [string, string][] = [['', ''], ["'", "'"], ['"', '"'], ['`', '`'], ['\\"', '\\"'], ['"', '']]
    const wrap = ['%s', 'msg %s k=v', 'error="git: %s"', '{"a":"%s","b":2}', 'first line\n%s\nlast line']
    const v = { home: ['/Users/u/.kea'], roots: ['/Users/u', '/Users/u/Code/My Project'] }
    for (let n = 0; n < 4000; n++) {
      const [open, close] = pick(quotes)
      const inside = `${pick(starts)}${pick(mids)}${NAME}${pick(ends)}`
      // an unquoted path is followed by nothing a quote of the text around it could be taken for
      const text = pick(wrap).replace('%s', `${pick(before)}${open}${inside}${close}${pick(after)}`)
      const got = scrubPaths(text, v)
      expect(got, text).not.toContain(NAME)
      expect(scrubPaths(got, v), text).toBe(got)
      expect(outsidePaths(got), text).toEqual([])
    }
  })

  it('U-DIAG-11 · the scrub’s work grows with the length of a text, never with its square: lines of quotes that close nowhere, of quotes inside quotes, of escaped quotes each one deeper than the last, of backslashes that no quote ends, as long as a whole log tail, cost at most L.diagnosticsScrubReadingsMax × (L.diagnosticsScrubQuoteDepthMax + 2) steps a character, and twice the text never more than twice the work and a little; what is quoted deeper than the cap keeps no word; the answers are the scrub’s own, and reading them again changes nothing', () => {
    const v = { home: ['/Users/u/.kea'], roots: ['/Users/u'], names: [] }
    const tower = (n: number): string => {
      let s = ''
      for (let d = 0; s.length < n; d++) s += `${'\\'.repeat(d)}" x `
      return s
    }
    // [what the line is made of, the line at about n characters]
    const shapes: [string, (n: number) => string][] = [
      ["apostrophes before words ('a 'a 'a): each closes nowhere", (n) => "'a ".repeat(n / 3)],
      ["apostrophes inside words (a'a'a)", (n) => "a'".repeat(n / 2)],
      ['a quote, then escaped quotes (" \\" \\" \\")', (n) => `"${'\\" '.repeat(n / 3)}`],
      ['a quote cut short, then words', (n) => `"${'word '.repeat(n / 5)}`],
      ['backticks before relative paths (`a/b `a/b)', (n) => '`a/b '.repeat(n / 5)],
      ['the three quotes in turn (\'a "b `c)', (n) => '\'a "b `c '.repeat(n / 9)],
      ['the three quotes with nothing between', (n) => '\'"`'.repeat(n / 3)],
      ['escaped quotes, each one deeper than the last', tower],
      ['pairs that close ("a" "a")', (n) => '"a" '.repeat(n / 4)],
      ["paths, each with a quote after it (/opt/x ' /opt/x ')", (n) => "/opt/x ' ".repeat(n / 9)],
      ['a quote cut short before a home, again and again ("/Users/x "/Users/x)', (n) => '"/Users/x '.repeat(n / 10)],
      ['words with a slash between apostrophes (it\'s a/b \'c)', (n) => "it's a/b 'c ".repeat(n / 12)],
      // a run of backslashes that no quote ends is read once, not again from each of its backslashes (that way 30 000
      // of them would take 0.7 s, a whole log tail 52 s); the steps count what the quote pattern reads too
      ['backslashes, no quote after them', (n) => '\\'.repeat(n)],
      ['runs of backslashes, each ended by a space', (n) => `${'\\'.repeat(255)} `.repeat(n / 256)],
      ['one run of backslashes, then a quote', (n) => `${'\\'.repeat(n - 1)}"`],
      ['pairs of backslashes, each before a quote (\\\\" \\\\")', (n) => '\\\\"'.repeat(n / 3)],
      ['a JSON-escaped log (line\\nline\\n)', (n) => 'line\\n'.repeat(n / 6)],
    ]
    const perCharacter = L.diagnosticsScrubReadingsMax * (L.diagnosticsScrubQuoteDepthMax + 2)
    for (const [what, line] of shapes) {
      let before = 0
      // the last is as long as all that Copy diagnostics reads of a log, in one line
      for (const n of [2_048, 4_096, 32_768, L.diagnosticsLogTailBytes]) {
        const text = line(n)
        const { text: got, steps } = scrubWork(text, v)
        expect(steps, `${what}: ${text.length} characters`).toBeLessThanOrEqual(perCharacter * text.length)
        if (n === 4_096) expect(steps, `${what}: twice the text`).toBeLessThanOrEqual(2.25 * before)
        before = steps
        if (n > 4_096) continue
        expect(got, what).toBe(scrubPaths(text, v))
        expect(scrubPaths(got, v), what).toBe(got)
        expect(outsidePaths(got), what).toEqual([])
      }
    }
    // the same texts on many lines cost the same as on one: a line is read by itself
    const lines = Array.from({ length: 64 }, () => "'a ".repeat(100)).join('\n')
    expect(scrubWork(lines, v).steps).toBeLessThanOrEqual(perCharacter * lines.length)

    // quotes inside quotes are read L.diagnosticsScrubQuoteDepthMax deep: at that depth a name between them still goes
    // by the rules (a word stays, a path goes); one deeper, the quoted text goes whole, and no word of it is kept
    const nest = (depth: number, inner: string): string => {
      let s = inner
      for (let d = depth - 1; d >= 0; d--) s = `${'\\'.repeat(d)}" ${s}`
      return s
    }
    const deepest = scrubPaths(nest(L.diagnosticsScrubQuoteDepthMax, 'Zq7word'), v)
    expect(deepest).toContain('Zq7word')
    const deeper = scrubPaths(nest(L.diagnosticsScrubQuoteDepthMax + 1, 'Zq7word'), v)
    expect(deeper).not.toContain('Zq7word')
    expect(deeper).toContain(PATH_MARK)
    expect(scrubPaths(deeper, v)).toBe(deeper)
    expect(outsidePaths(deeper)).toEqual([])
  })

  it('U-DIAG-2 · the Resources section: each process’s footprint and rows as names and numbers, a failed gauge as unreadable, a silent process named', () => {
    expect(reportLines({ 'core.b': 2, 'core.a': { x: 1, y: Number.NaN }, 'core.c': Number.NaN })).toEqual(['  core.a  x=1 y=unreadable', '  core.b  2', '  core.c  unreadable'])
    const text = resourcesSection({
      reports: { main: { 'main.windows': 1 }, core: { 'core.connections': 1, 'kit.children': { 'git.active': 0 } } },
      missing: { ptyhost: 'no answer' },
      footprint: { t: '2026-10-13T10:00:00.000Z', bytes: { main: 104_857_600, core: 52_428_800 }, errors: { ptyhost: 'not running' } },
    })
    expect(text).toEqual([
      '## Resources',
      'footprint at 2026-10-13T10:00:00.000Z: main 100 MiB · core 50 MiB',
      'footprint of ptyhost not read: not running',
      'ptyhost: no report (no answer)',
      'main:',
      '  main.windows  1',
      'core:',
      '  core.connections  1',
      '  kit.children  git.active=0',
    ])
    expect(resourcesSection({ reports: {}, missing: {}, footprint: null })).toEqual(['## Resources', 'footprint: not sampled yet'])
    expect(resourcesSection(null)[1]).toMatch(/main did not answer/)
    expect(outsidePaths(text.join('\n'))).toEqual([])
  })
})
