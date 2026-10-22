import { L, type PtyInfo } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { closeQuestion, opensFirstShell, tabTitle } from './terminalPane.ts'

const tab = (over: Partial<PtyInfo> = {}): PtyInfo => ({
  ptyId: 'aaaaaaaaaa',
  sessionId: 's1',
  kind: 'shell',
  state: 'running',
  holderPid: 10,
  holderStartedAt: 1,
  childPid: 11,
  cwd: '/tmp',
  argv: ['/bin/zsh', '-l'],
  cols: 80,
  rows: 24,
  exitCode: null,
  exitSignal: null,
  detached: false,
  title: null,
  ...over,
})

describe('the tab strip: a terminal tab’s title', () => {
  it('U-TERM-41 · a shell tab shows the title its program set, else the name of the process in its foreground, else the shell’s name; both are shown as data; Agent, Setup and Server tabs keep their own names', () => {
    // nothing known yet (not asked, or the session was hidden): the shell's own name
    expect(tabTitle(tab())).toBe('zsh')
    expect(tabTitle(tab({ foreground: null }))).toBe('zsh')
    expect(tabTitle(tab({ argv: [] }))).toBe('shell')
    // a command started in it, and the shell again when it ends
    expect(tabTitle(tab({ foreground: 'cat' }))).toBe('cat')
    expect(tabTitle(tab({ foreground: 'zsh' }))).toBe('zsh')
    // a title the program sets itself wins
    expect(tabTitle(tab({ foreground: 'vim', title: 'notes.md - VIM' }))).toBe('notes.md - VIM')
    expect(tabTitle(tab({ foreground: 'vim', title: '' }))).toBe('vim')
    // a process may name itself anything: control and bidi characters go, and the length is capped
    expect(tabTitle(tab({ foreground: 'ev\x1b[31mil\u202e\nname' }))).toBe('ev [31mil name')
    expect([...tabTitle(tab({ foreground: 'x'.repeat(L.oscTextMaxChars + 50) }))]).toHaveLength(L.oscTextMaxChars)
    // the other kinds are named by Kea, whatever runs in them
    expect(tabTitle(tab({ kind: 'agent', foreground: 'cat', title: 'x' }))).toBe('Agent')
    expect(tabTitle(tab({ kind: 'script', foreground: 'cat', title: 'x' }))).toBe('Setup')
    expect(tabTitle(tab({ kind: 'server', foreground: 'cat', title: 'x' }))).toBe('Server')
  })
})

describe('the shells pane: its first shell', () => {
  it('U-PTY-68 · the first shell opens only when nothing came back from the last run: no shell survived, core’s first `sessions` snapshot lists no session, and no session has a terminal once core has reconciled (a session the database lost comes back after that first snapshot)', () => {
    // a first launch, or a relaunch with nothing left
    expect(opensFirstShell({ shells: 0, sessions: 0 }, false)).toBe(true)
    // a shell survived
    expect(opensFirstShell({ shells: 1, sessions: 0 }, false)).toBe(false)
    // a session is listed (it comes back in the pane instead), with or without a terminal
    expect(opensFirstShell({ shells: 0, sessions: 0 }, true)).toBe(false)
    expect(opensFirstShell({ shells: 0, sessions: 1 }, true)).toBe(false)
    // the database was lost, so the first snapshot listed nothing; the holders gave the session back
    expect(opensFirstShell({ shells: 0, sessions: 1 }, false)).toBe(false)
  })
  it('U-TERM-48 · closing a shell tab asks first whenever a program is running in it or that could not be learned: core did not answer, or answered that it does not know; only a shell known to be idle closes at once; the sheet names the program when it has a name', () => {
    expect(closeQuestion({ busy: false, name: '', known: true })).toBeNull()
    expect(closeQuestion({ busy: true, name: 'cat', known: true })).toEqual({ name: 'cat', text: 'cat is still running in this tab. Closing the tab ends it.' })
    expect(closeQuestion({ busy: true, name: '', known: true })).toEqual({ name: '', text: 'A program is still running in this tab. Closing the tab ends it.' })
    // not known: asked all the same, and said as it is
    const unknown = { name: '', text: 'Kea could not tell whether a program is still running in this tab. Closing the tab ends whatever is.' }
    expect(closeQuestion({ busy: true, name: '', known: false })).toEqual(unknown)
    expect(closeQuestion(null), 'the call failed').toEqual(unknown)
    // an answer that says "not busy" without knowing is not taken for an idle shell
    expect(closeQuestion({ busy: false, name: '', known: false })).toEqual(unknown)
    // a process may name itself anything: shown as data
    expect(closeQuestion({ busy: true, name: 'ev\x1b[31mil\nname', known: true })?.text).toBe('ev [31mil name is still running in this tab. Closing the tab ends it.')
  })

})
