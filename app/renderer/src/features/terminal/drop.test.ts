import { isTypedText, protocolOs } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { dropText, MENTION_REFUSED, OTHER_SESSION } from './drop.ts'

describe('a dragged row on a terminal', () => {
  it('U-TERM-62 · a row of the file tree or the Changes view dropped on its session’s agent terminal is the agent’s mention of the file or folder, and with ⌥ its shell-escaped path; on any other terminal the path, ⌥ or not; a row of another session types nothing and says why; files from other apps stay their absolute paths', () => {
    const s = 's1'
    const on = (path: string, o: { alt?: boolean; agent?: boolean; sessionId?: string | null; rowSession?: string } = {}) =>
      dropText({ row: { sessionId: o.rowSession ?? s, path }, files: [], alt: o.alt ?? false, agent: o.agent ?? true, sessionId: o.sessionId === undefined ? s : o.sessionId })

    // the agent's terminal: the mention by default, a file or a folder alike (a folder bare, never with a trailing `/`)
    for (const path of ['src/app.ts', 'my file.ts', 'src/components', 'README.md']) expect(on(path), path).toEqual({ mention: path })
    // ⌥ there: the shell's form, the path relative to the working directory, followed by a space
    expect(on('my file.ts', { alt: true })).toEqual({ text: 'my\\ file.ts ', refused: null })
    expect(on('src/components', { alt: true })).toEqual({ text: 'src/components ', refused: null })
    // any other terminal of the session (a shell tab, the Server tab): the shell's form, ⌥ or not
    for (const alt of [false, true]) expect(on('my file.ts', { agent: false, alt }), `alt ${alt}`).toEqual({ text: 'my\\ file.ts ', refused: null })

    // a row of another session than the terminal's: its path is relative to another folder, so nothing is typed
    for (const agent of [true, false])
      for (const alt of [false, true]) expect(on('src/app.ts', { rowSession: 's2', agent, alt }), `agent ${agent} alt ${alt}`).toEqual({ text: '', refused: OTHER_SESSION })
    // and on the plain shells, which belong to no session
    expect(on('src/app.ts', { agent: false, sessionId: null })).toEqual({ text: '', refused: OTHER_SESSION })
    expect(OTHER_SESSION).toBe('That file belongs to another session.')

    // a name no mention reads back (a control character): refused on the agent's terminal, with the way to its path
    expect(on('a\rb.md')).toEqual({ text: '', refused: MENTION_REFUSED })
    expect(MENTION_REFUSED).toContain(`Drop it with ${protocolOs.keys.altName} held for its path.`)
    const quoted = on('a\rb.md', { alt: true })
    if ('mention' in quoted) throw new Error('a mention, not a text')
    expect(quoted).toEqual({ text: "$'a\\rb.md' ", refused: null })
    expect(isTypedText(quoted.text)).toBe(true)

    // files from other apps: their absolute paths, shell-escaped, on every terminal and with or without ⌥
    const files = ['/Users/x/a b.png', '', '/tmp/c.txt']
    for (const agent of [true, false])
      for (const alt of [false, true])
        expect(dropText({ row: null, files, alt, agent, sessionId: s }), `agent ${agent} alt ${alt}`).toEqual({ text: '/Users/x/a\\ b.png /tmp/c.txt ', refused: null })
    expect(dropText({ row: null, files: ['/tmp/c.txt'], alt: false, agent: false, sessionId: null })).toEqual({ text: '/tmp/c.txt ', refused: null })
  })
})
