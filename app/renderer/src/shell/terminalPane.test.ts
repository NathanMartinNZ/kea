import { L, type PtyInfo } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { terminalName } from '../features/terminal/screenReader.ts'
import { closeQuestion, opensFirstShell, tabTip, tabTitle } from './terminalPane.ts'

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

describe('the tab strip: a terminal tab’s title and tooltip', () => {
  it('U-TERM-41 · a shell tab’s tooltip is the title its program set, else the name of the process in its foreground, else the shell’s name; both are shown as data; Agent, Setup and Server tabs have none', () => {
    // nothing known yet (not asked, or the session was hidden): the shell's own name
    expect(tabTip(tab())).toBe('zsh')
    expect(tabTip(tab({ foreground: null }))).toBe('zsh')
    expect(tabTip(tab({ argv: [] }))).toBe('shell')
    // a command started in it, and the shell again when it ends
    expect(tabTip(tab({ foreground: 'cat' }))).toBe('cat')
    expect(tabTip(tab({ foreground: 'zsh' }))).toBe('zsh')
    // a title the program sets itself wins
    expect(tabTip(tab({ foreground: 'vim', title: 'notes.md - VIM' }))).toBe('notes.md - VIM')
    expect(tabTip(tab({ foreground: 'vim', title: '' }))).toBe('vim')
    // a process may name itself anything: control and bidi characters go, and the length is capped
    expect(tabTip(tab({ foreground: 'ev\x1b[31mil\u202e\nname' }))).toBe('ev [31mil name')
    expect([...(tabTip(tab({ foreground: 'x'.repeat(L.oscTextMaxChars + 50) })) ?? '')]).toHaveLength(L.oscTextMaxChars)
    // the other kinds are named by Kea, whatever runs in them, and have no tooltip of the program's
    expect(tabTip(tab({ kind: 'agent', foreground: 'cat', title: 'x' }))).toBeNull()
    expect(tabTip(tab({ kind: 'script', foreground: 'cat', title: 'x' }))).toBeNull()
    expect(tabTip(tab({ kind: 'server', foreground: 'cat', title: 'x' }))).toBeNull()
  })

  it('U-TERM-56 · a shell tab reads `Terminal n` with core’s number, whatever runs in it or titles it; Agent, Setup and Server keep their names; the terminal’s accessible name says “terminal” once, after the session’s title', () => {
    // a shell: its number, never the program's words (those are its tooltip)
    const long = 'user@host: ~/.kea/worktrees/atlas-web/fix-auth'
    expect(tabTitle(tab({ number: 1 }))).toBe('Terminal 1')
    expect(tabTitle(tab({ number: 2, foreground: 'vim', title: long }))).toBe('Terminal 2')
    expect(tabTip(tab({ number: 2, foreground: 'vim', title: long }))).toBe(long)
    expect(tabTitle(tab({ number: 12, state: 'lost' })), 'an ended shell keeps its number').toBe('Terminal 12')
    // a shell core gave no number: still a terminal, never the program's words
    expect(tabTitle(tab({ foreground: 'cat' }))).toBe('Terminal')
    // the other kinds are named by Kea, and carry no number
    expect(tabTitle(tab({ kind: 'agent', foreground: 'cat', title: 'x' }))).toBe('Agent')
    expect(tabTitle(tab({ kind: 'script', foreground: 'cat', title: 'x' }))).toBe('Setup')
    expect(tabTitle(tab({ kind: 'server', foreground: 'cat', title: 'x' }))).toBe('Server')
    // the terminal's accessible name: session, then tab; a shell's tab names a terminal already
    const named = (session: string | null, t: PtyInfo) => terminalName(session, tabTitle(t))
    expect(named('Fix auth redirect', tab({ kind: 'agent' }))).toBe('Fix auth redirect, Agent terminal')
    expect(named('Fix auth redirect', tab({ kind: 'server' }))).toBe('Fix auth redirect, Server terminal')
    expect(named('Fix auth redirect', tab({ kind: 'script' }))).toBe('Fix auth redirect, Setup terminal')
    expect(named('Fix auth redirect', tab({ number: 2, foreground: 'vim' }))).toBe('Fix auth redirect, Terminal 2')
    expect(named(null, tab({ sessionId: 'shells', number: 1 })), 'a plain shell has no session').toBe('Terminal 1')
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
