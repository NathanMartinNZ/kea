// A session's shell tabs come and go without leaving anything on disk: core assembled as main.ts assembles it on a temp
// KEA_HOME, a real ptyhost and real holders in this process (tests/integration/core-sessions-support.ts), a repo from
// tools/repo-factory. The session's agent is the `shell` pseudo-agent; its tabs are login shells, opened as `⌘T` opens
// them (`sessions.openShell`) and closed as the window closes them (`terminal.close`): by the person while the shell
// runs, or by the pane once the shell has exited. Counts are upper bounds: the method's warm-ups and checkpoints.

import fs from 'node:fs'
import path from 'node:path'
import { resources } from '@kea/kit'
import type { SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { holderState, until } from '../support/holders.ts'
import { createArgs, repo, startSessions, type SessionsUnderTest } from '../integration/core-sessions-support.ts'
import { METHOD, settle } from './ptyhost-leak.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

/** The method's run: its warm-ups, then one cycle per checkpoint. */
const CYCLES = METHOD.warmups + METHOD.checkpoints

const pidRuns = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** What must come back to where it was: core's terminal rows and ptyhost's per-PTY rows. */
function counts(s: SessionsUnderTest) {
  const r = resources.report()
  return {
    terminals: s.c.core.terminals.resourceCounts,
    ptys: r['ptyhost.ptys'],
    holderSockets: r['ptyhost.holderSockets'],
    ptyTimers: r['ptyhost.ptyTimers'],
    ptyQueues: r['ptyhost.ptyQueues'],
    checkpoints: r['ptyhost.checkpoints'],
  }
}

describe('shell tabs opened and closed in one session', () => {
  // a closed shell tab's ring, checkpoint and state file go with the tab, not with the session: otherwise a long-lived
  // session's disk would grow with every tab ever opened in it
  it(`L-MEM-22 · ${CYCLES} shell tabs opened and closed in one session, every other one after its shell exited by itself: after each close the session’s state directory holds the files it held before the tab, its holder is gone and no record or store entry is left; core’s and ptyhost’s counts end where they were; the Agent terminal, ended while its tab stays, keeps its ring and state file and still shows its last screen`, async () => {
    const s = await startSessions()
    cleanup.push(() => s.dispose())
    const r = repo('demo')
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const created = await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'shell tabs come and go'))
    const v: SessionView = await s.until(created.sessionId, 'the session is live', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
    expect(v.lifecycle).toBe('live')
    const t = s.c.core.terminals
    const dir = path.join(s.h.home, 'sessions', v.id)
    const agent = t.sessionRecords(v.id).find((x) => x.kind === 'agent')!.ptyId
    const stateFiles = () => fs.readdirSync(dir).filter((f) => /\.(ring|json|ckpt)$/.test(f)).sort()
    /** The state files of every terminal but the Agent's (whose checkpoint comes and is rewritten in its own time). */
    const others = () => stateFiles().filter((f) => !f.startsWith(`${agent}.`))
    const before = others()
    expect(before, 'a session with its Agent terminal alone').toEqual([])
    expect(stateFiles()).toEqual(expect.arrayContaining([`${agent}.json`, `${agent}.ring`]))

    await settle()
    /** With the Agent terminal alone: what ptyhost holds per PTY returns to this after every closed tab. */
    const alone = counts(s)
    const perPty = (c: ReturnType<typeof counts>) => JSON.stringify([c.ptys, c.holderSockets])
    let baseline: ReturnType<typeof counts> | null = null
    for (let i = 0; i < CYCLES; i++) {
      const { ptyId } = await s.call<{ ptyId: string }>('sessions.openShell', { id: v.id, grid: { cols: 80, rows: 24 } })
      await until(`tab ${i}: its holder’s ring and state file`, () => [`${ptyId}.json`, `${ptyId}.ring`].every((f) => fs.existsSync(path.join(dir, f))))
      const holder = holderState(s.h.home, ptyId)?.pid
      expect(holder, `tab ${i}: its holder’s pid`).toBeGreaterThan(0)
      if (i % 2 === 1) {
        // the shell exits by itself (`exit`, typed as a person would): the pane then closes the ended tab
        expect(await t.sendText(v.id, 'exit', { ptyId, submit: true })).toBe(true)
        await until(`tab ${i}: its shell exited`, () => t.record(ptyId)?.state !== 'running')
      }
      expect(await s.call('terminal.close', { ptyId })).toEqual({ ok: true })
      expect(others(), `tab ${i} closed: the state directory holds what it held before`).toEqual(before)
      expect([t.record(ptyId), t.store.has(ptyId)], `tab ${i}: no record, no store entry`).toEqual([undefined, false])
      await until(`tab ${i}: its holder gone`, () => !pidRuns(holder!))
      // ptyhost drops its entry when the holder's socket closes, a moment after it answered the release
      await until(`tab ${i}: ptyhost holds the Agent terminal alone again`, () => perPty(counts(s)) === perPty(alone))
      if (i === METHOD.warmups - 1) {
        await settle()
        baseline = counts(s)
      }
    }
    await settle()
    expect(counts(s), 'core’s terminal rows and ptyhost’s per-PTY rows after the last tab').toEqual(baseline)
    expect(t.sessionRecords(v.id).map((x) => x.kind), 'the session’s records: its Agent terminal').toEqual(['agent'])

    // the Agent terminal ends and its tab stays: its files stay with it, and its last screen comes from them
    await s.call('sessions.stop', { id: v.id })
    await s.until(v.id, 'detached after Stop', (x) => x.lifecycle === 'detached')
    expect(t.record(agent)?.state).not.toBe('running')
    expect(stateFiles(), 'the ended Agent terminal’s ring and state file').toEqual(expect.arrayContaining([`${agent}.json`, `${agent}.ring`]))
    expect(others()).toEqual(before)
    // (asked once its holder is released: until then its stream has the screen and core answers null)
    await until('the ended Agent terminal’s last screen, from its checkpoint and ring', async () => ((await s.call<{ data: string } | null>('terminal.lastScreen', { ptyId: agent, cols: 80, rows: 24 }))?.data.length ?? 0) > 0)
  })
})
