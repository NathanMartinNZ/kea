// Shell tab titles with the real pieces: core assembled as main.ts assembles it, on a temp KEA_HOME, wired to a real
// ptyhost and real holders. What a tab's title is made from is the `foreground` field of its entry in core's
// `terminals` store: the name of the process in the terminal's foreground, which core asks the holder for (`STAT`) when
// something happens in a shell tab of a session on screen. The rate limit, the bookkeeping and the tab strip's use of
// the field have unit and e2e tests of their own.

import { afterEach, describe, expect, it } from 'vitest'
import type { SessionView } from '@kea/protocol'
import { until } from '../support/holders.ts'
import { createArgs, repo, startSessions, type SessionsUnderTest } from './core-sessions-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function sessions(): Promise<SessionsUnderTest> {
  const s = await startSessions()
  cleanup.push(() => s.dispose())
  return s
}

async function create(s: SessionsUnderTest, projectId: string, prompt: string): Promise<SessionView> {
  const r = await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt))
  const v = await s.until(r.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

describe('shell tabs titled with their foreground process', () => {
  it('I-TERM-1 · a shell tab of the session on screen, and one of the shells pane: a command started in it later names the tab, and the shell’s name is back when the command ends; a hidden session’s tab is asked nothing and carries no name until its session is shown again', async () => {
    const s = await sessions()
    const r = repo()
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const a = await create(s, p.id, 'tab titles')
    const core = s.c.core
    const t = core.terminals
    const name = (ptyId: string) => t.store.get(ptyId)?.foreground ?? null
    const type = (ptyId: string, keys: string) => s.h.manager.get(ptyId)!.input(keys)
    const asked = (ptyId: string) => s.c.calls.filter((c) => c.m === 'pty.stat' && c.a.ptyId === ptyId).length
    const named = (ptyId: string, what: string) => until(`${ptyId} named ${what} (it reads ${name(ptyId)})`, () => name(ptyId) === what)
    const agent = t.sessionRecords(a.id).find((x) => x.kind === 'agent')!.ptyId

    // a shell tab of a session nobody shows: nothing is asked, whatever runs in it
    const tab = (await s.call<{ ptyId: string }>('sessions.openShell', { id: a.id })).ptyId
    type(tab, 'cat\r')
    await until('cat echoes', async () => {
      type(tab, 'x\r')
      return (await t.foreground(tab)).name === 'cat'
    })
    const direct = asked(tab) // the test's own `terminal.foreground` calls
    expect(name(tab), 'hidden: no name').toBeNull()
    expect(t.resourceCounts).toMatchObject({ titles: 0, titleTimers: 0 })

    // the window shows the session: its shell tab is asked at once, and only that tab (the Agent tab is named by Kea)
    const window = {}
    core.visible.set(window, a.id)
    cleanup.push(() => core.visible.drop(window))
    await named(tab, 'cat')
    expect(asked(tab)).toBeGreaterThan(direct)
    expect(asked(agent)).toBe(0)
    expect(name(agent)).toBeNull()
    // `cat` waits, on screen: once what the keys set off has been asked, nothing is due and nothing is out (a quiet tab
    // holds no timer, U-TERM-42)
    await until('the quiet tab holds no timer', () => t.resourceCounts.titleTimers === 0 && t.resourceCounts.titleAsks === 0)
    expect(t.resourceCounts.titles).toBe(1)
    // the command ends (end of input): the shell has the terminal again, and the tab the shell's name, as the system
    // knows the process (macOS's /bin/sh runs as `bash`)
    type(tab, '\x04')
    await until('the shell named again', () => name(tab) !== null && name(tab) !== 'cat')
    const sh = name(tab) as string
    expect(sh).toMatch(/^(ba|z|da)?sh$/)
    // a command started later renames it again
    type(tab, 'cat\r')
    await named(tab, 'cat')

    // hidden again: the name goes with what was kept, and nothing more is asked
    core.visible.set(window, null)
    expect(name(tab)).toBeNull()
    expect(t.resourceCounts).toMatchObject({ titles: 0, titleTimers: 0 })
    await until('no ask is still out', () => t.resourceCounts.titleAsks === 0)
    const quiet = asked(tab)
    type(tab, 'still hidden\r')
    await until('cat wrote it back', () => s.h.notes.filter((n) => n.m === 'pty.activity' && n.a.ptyId === tab && !n.a.active).length > 0)
    expect(asked(tab)).toBe(quiet)

    // the shells pane (no session): on screen while the window shows one of its terminals
    const shell = (await s.call<{ ptyId: string }>('terminal.openShell', { cols: 80, rows: 24 })).ptyId
    await s.call('terminal.setVisible', { ptyIds: [shell] })
    await named(shell, sh)
    type(shell, 'cat\r')
    await named(shell, 'cat')
    type(shell, '\x04')
    await named(shell, sh)
    // the window goes: nothing is on screen
    t.windowGone()
    expect(name(shell)).toBeNull()
    expect(t.resourceCounts).toMatchObject({ titles: 0, titleTimers: 0 })
    await s.call('terminal.close', { ptyId: shell })
  })
})
