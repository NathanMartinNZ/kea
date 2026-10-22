// Sessions and worktrees under load, races and lost resources, at core level: core assembled as main.ts assembles it
// (core.ts) on a temp KEA_HOME, real ptyhost and holders (tests/support/holders.ts), real git on repos from
// tools/repo-factory. The universal post-conditions that apply here: consistency (database invariants,
// `git worktree list` equals the records) and cleanliness (no leaked worktrees, branches, trash, ports, state dirs).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkInvariants } from '@kea/core/src/platform/db/invariants.ts'
import { WORKTREE_TRASH as KEA_TRASH } from '@kea/core/src/worktrees/ops.ts'
import { SETTINGS, type SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { holderAlive, until } from '../support/holders.ts'
import { branches, createArgs, gitIn, repo, startSessions, worktreePaths, type SessionsUnderTest } from '../integration/core-sessions-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function sessions(o: Parameters<typeof startSessions>[0] = {}): Promise<SessionsUnderTest> {
  const s = await startSessions(o)
  cleanup.push(() => s.dispose())
  return s
}

function fixture(name = 'demo') {
  const r = repo(name)
  cleanup.push(() => r.dispose())
  return r
}

async function live(s: SessionsUnderTest, id: string): Promise<SessionView> {
  const v = await s.until(id, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

/** A git that logs when each worktree mutation starts and ends (per repository), then runs the real one. */
function loggingGit(dir: string): { binary: string; intervals(): Map<string, [number, number][]> } {
  const real = gitIn(process.cwd(), '--exec-path').trim().replace(/\/libexec\/git-core$/, '/bin/git')
  const realGit = fs.existsSync(real) ? real : '/usr/bin/git' // os-ok: in /usr/bin on both systems
  const log = path.join(dir, 'git.log')
  const bin = path.join(dir, 'git')
  const now = `/usr/bin/perl -MTime::HiRes=time -e 'printf "%d", time*1e9'` // os-ok: in /usr/bin on both systems
  fs.writeFileSync(
    bin,
    `#!/bin/sh\ncase "$1 $2" in\n  "worktree add"|"worktree remove"|"worktree prune") m=1 ;;\n  *) m= ;;\nesac\n` +
      `[ -n "$m" ] && echo "start $$ $(pwd -P) $(${now})" >> "${log}"\n` +
      `"${realGit}" "$@"; rc=$?\n` +
      `[ -n "$m" ] && echo "end $$ $(pwd -P) $(${now})" >> "${log}"\nexit $rc\n`,
    { mode: 0o755 },
  )
  return {
    binary: bin,
    intervals() {
      const open = new Map<string, number>()
      const out = new Map<string, [number, number][]>()
      for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
        const [kind, pid, cwd, t] = line.split(' ')
        if (kind === 'start') open.set(pid!, Number(t))
        else {
          const list = out.get(cwd!) ?? []
          list.push([open.get(pid!)!, Number(t)])
          out.set(cwd!, list)
        }
      }
      return out
    },
  }
}

describe('races', () => {
  it('C-RACE-1 · ten sessions created at once across two repositories: all succeed, and no two worktree mutations of one repository overlap', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-gitlog-')))
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const g = loggingGit(dir)
    const s = await sessions({ opts: { gitBinary: g.binary } })
    const a = fixture('alpha')
    const b = fixture('beta')
    const pa = await s.project(a.root)
    const pb = await s.project(b.root)
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.call<{ sessionId: string }>('sessions.create', createArgs(i % 2 ? pb.id : pa.id, `race ${i}`)).then((r) => r.sessionId)),
    )
    const views = await Promise.all(ids.map((id) => live(s, id)))
    for (const [r, p] of [[a, pa], [b, pb]] as const) {
      const mine = views.filter((v) => v.projectId === p.id)
      expect(mine).toHaveLength(5)
      expect(worktreePaths(r.root).filter((w) => w !== r.root).sort()).toEqual(mine.map((v) => v.cwd).sort())
      expect(gitIn(r.root, 'worktree', 'list', '--porcelain')).not.toMatch(/^locked/m)
    }
    // the per-repository mutex: within one repository the mutations never overlap (each add is logged)
    const logged = g.intervals()
    expect([...logged.values()].flat().length).toBeGreaterThanOrEqual(10)
    for (const [cwd, list] of logged) {
      const sorted = [...list].sort((x, y) => x[0] - y[0])
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]![0], `overlap in ${cwd}`).toBeGreaterThanOrEqual(sorted[i - 1]![1])
    }
    expect(checkInvariants(s.c.core.db)).toEqual([])
  })

  /** How much the agent prints before the delete starts, and how much of it is read back. */
  const FLOOD_BYTES = 256 * 1024
  const TAIL_BYTES = 1024

  it('C-RACE-2 · delete a session while its agent floods output and git status runs on its worktree in a loop: a clean removal, no error surfaces', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await live(s, (await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'busy delete'))).sessionId)
    const agent = s.c.core.terminals.sessionRecords(v.id).find((x) => x.kind === 'agent')!.ptyId
    const input = s.h.manager.handlers()['pty.input'] as (a: { ptyId: string; data: string }) => Promise<unknown>
    const pty = s.h.manager.get(agent)!
    await input({ ptyId: agent, data: 'while :; do echo flood $RANDOM; done\n' })
    let statusRuns = 0
    let stop = false
    const statusLoop = (async () => {
      const { git } = await import('@kea/kit')
      while (!stop) {
        await git(['status', '--porcelain'], { cwd: v.cwd, readOnly: true, env: s.env, collect: true }).catch(() => undefined)
        statusRuns++
        // once the worktree is gone the spawn fails without I/O; yield so the loop cannot starve the event loop
        await new Promise((res) => setImmediate(res))
      }
    })()
    await until('status refreshes running', () => statusRuns >= 3)
    // the flood is on right up to the delete: the agent's output grew by FLOOD_BYTES since status began, and it is the loop's
    const since = pty.flushedSeq()
    await until('the agent floods', () => pty.flushedSeq() - since >= FLOOD_BYTES)
    const tail = new TextDecoder().decode(pty.readRing(pty.flushedSeq() - TAIL_BYTES, pty.flushedSeq(), TAIL_BYTES) ?? new Uint8Array())
    expect(tail, 'the agent’s latest output is the flood').toMatch(/flood \d+\r\nflood \d+/)
    const errorsBefore = s.c.log.entries.filter((e) => e.level === 'error').length
    const d = await s.call<{ deleted: boolean }>('sessions.delete', { id: v.id, deleteBranch: true })
    stop = true
    await statusLoop
    expect(d.deleted).toBe(true)
    expect(fs.existsSync(v.cwd)).toBe(false)
    expect(worktreePaths(r.root)).toEqual([r.root])
    expect(branches(r.root)).not.toContain(v.branch)
    expect(holderAlive(s.h.home, agent)).toBe(false)
    expect(s.c.log.entries.filter((e) => e.level === 'error').length).toBe(errorsBefore)
  })
})

describe('resources', () => {
  it('C-RES-5 · a live session’s worktree deleted outside Kea: flagged "Worktree missing" (no automatic action), the agent PTY untouched, nothing throws; Recreate from branch brings it back', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await live(s, (await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'vanishing tree'))).sessionId)
    const agent = s.c.core.terminals.sessionRecords(v.id).find((x) => x.kind === 'agent')!.ptyId
    const errorsBefore = s.c.log.entries.filter((e) => e.level === 'error').length
    fs.rmSync(v.cwd, { recursive: true, force: true })
    // selecting the session (its panel state is read) looks at the worktree
    await s.call('sessions.getUi', { id: v.id })
    const flagged = await s.until(v.id, 'worktree missing', (x) => x.worktreeMissing)
    expect(flagged.lifecycle).toBe('live')
    expect(holderAlive(s.h.home, agent)).toBe(true)
    expect(s.c.core.terminals.record(agent)?.state).toBe('running')
    // what core asks git about the session answers, without throwing
    expect(await s.call('sessions.deletePreview', { id: v.id })).toMatchObject({ worktreeMissing: true })
    expect(fs.existsSync(v.cwd)).toBe(false) // nothing done on its own
    await s.call('sessions.recreateWorktree', { id: v.id })
    expect(fs.existsSync(path.join(v.cwd, '.git'))).toBe(true)
    expect(gitIn(v.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(v.branch)
    expect((await s.until(v.id, 'flag cleared', (x) => !x.worktreeMissing)).lifecycle).toBe('live')
    expect(holderAlive(s.h.home, agent)).toBe(true)
    expect(s.c.log.entries.filter((e) => e.level === 'error').length).toBe(errorsBefore)
    expect(checkInvariants(s.c.core.db)).toEqual([])
  })
})

describe('soak', () => {
  it('C-SOAK-3 · 200 create → archive → delete cycles with a teardown script, then past the retention: nothing leaks — worktrees, branches, trash, port blocks, state dirs, refs, deleted rows, core’s per-session state', async () => {
    let clock = Date.now()
    const marks = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-soak-')))
    cleanup.push(() => fs.rmSync(marks, { recursive: true, force: true }))
    const s = await sessions({ opts: { now: () => clock } })
    const r = fixture()
    const p = await s.project(r.root)
    await s.call('projects.updateSettings', { id: p.id, set: { teardownCommand: `echo "$KEA_TEARDOWN_REASON" >> ${marks}/teardown.log` } })
    const baseline = s.c.core.sessions.resourceCounts
    const cycles = 200
    for (let i = 0; i < cycles; i++) {
      const v = await live(s, (await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, `soak ${i}`))).sessionId)
      fs.writeFileSync(path.join(v.cwd, 'work.txt'), `${i}\n`)
      expect(await s.call('sessions.archive', { id: v.id, confirmed: true })).toMatchObject({ archived: true, teardownFailed: false })
      expect(await s.call('sessions.delete', { id: v.id, deleteBranch: true, forceBranch: true })).toMatchObject({ deleted: true, teardownFailed: false })
    }
    await s.idle()
    expect(fs.readFileSync(path.join(marks, 'teardown.log'), 'utf8').split('\n').filter(Boolean)).toHaveLength(cycles * 2)
    const root = path.join(s.h.home, 'worktrees')
    expect(worktreePaths(r.root)).toEqual([r.root])
    expect(branches(r.root)).toEqual(['main'])
    expect(fs.readdirSync(path.join(root, KEA_TRASH))).toEqual([])
    expect(fs.readdirSync(path.join(root, 'demo'))).toEqual([])
    expect(s.c.core.db.get<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE port_base IS NOT NULL')!.n).toBe(0)
    const dirs = fs.existsSync(path.join(s.h.home, 'sessions')) ? fs.readdirSync(path.join(s.h.home, 'sessions')) : []
    expect(dirs).toEqual([])
    expect(s.c.core.sessions.resourceCounts).toEqual(baseline)
    expect(checkInvariants(s.c.core.db)).toEqual([])
    // past the retention: the refs and the rows go at launch
    const retentionDays = SETTINGS.find((k) => k.key === 'general.deletedRetentionDays')!.default as number
    expect(gitIn(r.root, 'for-each-ref', 'refs/kea/deleted/').split('\n').filter(Boolean)).toHaveLength(cycles)
    clock += (retentionDays + 1) * 86_400_000
    await s.relaunch()
    expect(gitIn(r.root, 'for-each-ref', 'refs/kea/deleted/')).toBe('')
    expect(s.c.core.db.get<{ n: number }>(`SELECT count(*) AS n FROM sessions WHERE lifecycle = 'deleted'`)!.n).toBe(0)
    expect(s.c.core.db.get<{ n: number }>('SELECT count(*) AS n FROM ptys')!.n).toBe(0)
  }, 1_200_000)
})
