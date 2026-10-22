import type { PtyInfo } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import type { HolderEntry, HolderJson, HolderScan } from './holders.ts'
import { planReconcile, SHELLS_SESSION, type ReconcileInput } from './reconcile.ts'
import type { TerminalRecord } from './records.ts'

const NOW = 1_000_000
const US = 1_000

const holder = (ptyId: string, over: Partial<PtyInfo> = {}): PtyInfo => ({
  ptyId,
  sessionId: 'S1',
  kind: 'agent',
  state: 'running',
  holderPid: 500,
  holderStartedAt: 7,
  childPid: 501,
  cwd: '/w',
  argv: ['claude'],
  cols: 100,
  rows: 30,
  exitCode: null,
  exitSignal: null,
  detached: true,
  title: 'working',
  ...over,
})

const record = (ptyId: string, over: Partial<TerminalRecord> = {}): TerminalRecord => ({
  ptyId,
  sessionId: 'S1',
  kind: 'agent',
  argv: ['claude'],
  cwd: '/w',
  title: null,
  holderPid: 500,
  holderStartedAt: 7,
  childPid: 501,
  cols: 80,
  rows: 24,
  state: 'running',
  exitCode: null,
  exitSignal: null,
  tabOrder: 0,
  createdAt: 1,
  endedAt: null,
  ...over,
})

const json = (ptyId: string, over: Partial<HolderJson> = {}): HolderJson => ({
  ptyId,
  sessionId: 'S1',
  kind: 'agent',
  cwd: '/w',
  argv: ['claude'],
  pid: 500,
  pidStartTime: 7_000 * US,
  pidStartTicks: null,
  childPid: 501,
  exited: false,
  exitCode: null,
  exitSignal: null,
  socket: `/run/${ptyId}.sock`,
  ...over,
})

/** A trusted state file in its session's directory, with or without a socket, alive or not. */
const onDisk = (ptyId: string, o: { alive: boolean | null; socket?: boolean; json?: Partial<HolderJson>; files?: string[] }): HolderEntry => {
  const j = json(ptyId, o.json)
  return { ptyId, dirs: [{ sessionId: j.sessionId, files: o.files ?? [`${ptyId}.json`, `${ptyId}.ring`] }], identity: 'trusted', why: null, json: j, socket: o.socket ?? false, alive: o.alive }
}

const scan = (...entries: HolderEntry[]): HolderScan => ({ entries: new Map(entries.map((e) => [e.ptyId, e])), socketsKnown: true, probeFailed: false })

const plan = (i: Partial<ReconcileInput>) => planReconcile({ records: [], holders: [], scan: scan(), spawning: new Set(), rebuild: false, now: NOW, ...i })

describe('launch reconciliation planner', () => {
  it('U-PTY-43 · record + holder of the same session → attached, the record refreshed from the holder; no other effect', () => {
    const p = plan({ records: [record('aaaaaaaaaa')], holders: [holder('aaaaaaaaaa')], scan: scan(onDisk('aaaaaaaaaa', { alive: true, socket: true })) })
    expect(p.attached).toEqual(['aaaaaaaaaa'])
    expect(p.put, 'start time from the state file, ms').toEqual([record('aaaaaaaaaa', { cols: 100, rows: 30, title: 'working', holderStartedAt: 7_000 })])
    expect([p.orphans, p.ended, p.staleSockets, p.deadFiles, p.ignored, p.detachedSessions]).toEqual([[], [], [], [], [], []])
  })

  it('U-PTY-43 · a child that exited while Kea was away: attached, the record ends with its exit status (the session detaches)', () => {
    const p = plan({ records: [record('aaaaaaaaaa')], holders: [holder('aaaaaaaaaa', { state: 'exited', exitCode: 3 })] })
    expect(p.attached).toEqual(['aaaaaaaaaa'])
    expect(p.ended).toMatchObject([{ ptyId: 'aaaaaaaaaa', state: 'exited', exitCode: 3, endedAt: NOW }])
    expect(p.detachedSessions).toEqual(['S1'])
  })

  it('U-PTY-43 · holders without a running record of their session are orphans; only one no record names can be adopted', () => {
    const p = plan({
      records: [record('bbbbbbbbbb', { state: 'exited', endedAt: 2 }), record('cccccccccc', { sessionId: 'S2' })],
      holders: [holder('aaaaaaaaaa'), holder('bbbbbbbbbb'), holder('cccccccccc')],
    })
    expect(p.attached).toEqual([])
    expect(p.orphans.map((o) => [o.ptyId, o.reason, o.reachable, o.canAdopt])).toEqual([
      ['aaaaaaaaaa', 'noRecord', true, true],
      ['bbbbbbbbbb', 'recordEnded', true, false],
      ['cccccccccc', 'sessionMismatch', true, false],
    ])
    expect(p.ended, 'the mismatched record has no holder of its own: lost').toMatchObject([{ ptyId: 'cccccccccc', sessionId: 'S2', state: 'lost' }])
    expect(p.detachedSessions).toEqual(['S2'])
  })

  it('U-PTY-43 · after a lost records store, listed holders get records instead (rebuild); a foreign state file still never does', () => {
    const foreign: HolderEntry = { ...onDisk('bbbbbbbbbb', { alive: true }), identity: 'foreign', why: 'socket of another KEA_HOME', json: null }
    const p = plan({ rebuild: true, holders: [holder('aaaaaaaaaa'), holder('bbbbbbbbbb')], scan: scan(onDisk('aaaaaaaaaa', { alive: true }), foreign) })
    expect(p.attached).toEqual(['aaaaaaaaaa'])
    expect(p.put).toMatchObject([{ ptyId: 'aaaaaaaaaa', sessionId: 'S1', kind: 'agent', state: 'running', holderStartedAt: 7_000, createdAt: NOW }])
    expect(p.orphans).toEqual([])
    expect(p.ignored).toEqual([{ ptyId: 'bbbbbbbbbb', why: 'socket of another KEA_HOME' }])
  })

  it('U-PTY-43 · a listed holder whose state file is foreign is never attached, and its running record ends', () => {
    const foreign: HolderEntry = { ...onDisk('aaaaaaaaaa', { alive: true }), identity: 'foreign', why: 'names session S9 but lives in S1', json: null }
    const p = plan({ records: [record('aaaaaaaaaa')], holders: [holder('aaaaaaaaaa')], scan: scan(foreign) })
    expect(p.attached).toEqual([])
    expect(p.orphans).toEqual([])
    expect(p.ended).toMatchObject([{ ptyId: 'aaaaaaaaaa', state: 'lost' }])
  })

  it('U-PTY-43 · records without a holder: exited (with the status the state file kept) or lost; their stale sockets go', () => {
    const p = plan({
      records: [record('aaaaaaaaaa'), record('bbbbbbbbbb', { kind: 'shell', sessionId: SHELLS_SESSION }), record('cccccccccc')],
      scan: scan(onDisk('aaaaaaaaaa', { alive: false, socket: true, json: { exited: true, exitCode: 0 } }), onDisk('bbbbbbbbbb', { alive: false, socket: true, json: { sessionId: SHELLS_SESSION } })),
    })
    expect(p.ended.map((r) => [r.ptyId, r.state, r.exitCode])).toEqual([
      ['aaaaaaaaaa', 'exited', 0],
      ['bbbbbbbbbb', 'lost', null],
      ['cccccccccc', 'lost', null],
    ])
    expect(p.detachedSessions, 'only an agent PTY detaches its session').toEqual(['S1'])
    expect(p.staleSockets).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
    expect(p.deadFiles, 'a record still names them: kept until the tab is closed').toEqual([])
  })

  it('U-PTY-43 · a holder alive but not listed (ptyhost could not reach it) keeps its record running; unknown liveness decides nothing', () => {
    const p = plan({
      records: [record('aaaaaaaaaa'), record('bbbbbbbbbb')],
      scan: scan(onDisk('aaaaaaaaaa', { alive: true, socket: true }), onDisk('bbbbbbbbbb', { alive: null, socket: true })),
    })
    expect(p.unreachable).toEqual(['aaaaaaaaaa'])
    expect([p.put, p.ended, p.staleSockets, p.orphans]).toEqual([[], [], [], []])
  })

  it('U-PTY-43 · a live holder nobody lists and no record names is an unreachable orphan (Terminate only)', () => {
    const p = plan({ scan: scan(onDisk('aaaaaaaaaa', { alive: true, socket: true }), onDisk('bbbbbbbbbb', { alive: true, json: { sessionId: 'S2' } })), records: [record('bbbbbbbbbb')] })
    expect(p.orphans.map((o) => [o.ptyId, o.reason, o.reachable, o.canAdopt, o.holderStartedAt])).toEqual([
      ['aaaaaaaaaa', 'noRecord', false, false, 7_000],
      ['bbbbbbbbbb', 'sessionMismatch', false, false, 7_000],
    ])
    expect(p.ended.map((r) => r.ptyId)).toEqual(['bbbbbbbbbb'])
  })

  it('U-PTY-43 · dead files of the shells pseudo-session go when no record names them; other sessions keep theirs; sockets without a state file are left', () => {
    const shellDead = onDisk('aaaaaaaaaa', { alive: false, json: { sessionId: SHELLS_SESSION }, files: ['aaaaaaaaaa.ckpt', 'aaaaaaaaaa.json', 'aaaaaaaaaa.ring'] })
    const ckptOnly: HolderEntry = { ptyId: 'bbbbbbbbbb', dirs: [{ sessionId: SHELLS_SESSION, files: ['bbbbbbbbbb.ckpt'] }], identity: 'missing', why: null, json: null, socket: false, alive: null }
    const sockOnly: HolderEntry = { ptyId: 'cccccccccc', dirs: [{ sessionId: SHELLS_SESSION, files: ['cccccccccc.ring'] }], identity: 'missing', why: null, json: null, socket: true, alive: null }
    const otherSession = onDisk('dddddddddd', { alive: false })
    const p = plan({ scan: scan(shellDead, ckptOnly, sockOnly, otherSession) })
    expect(p.deadFiles).toEqual([
      { sessionId: SHELLS_SESSION, ptyId: 'aaaaaaaaaa', files: ['aaaaaaaaaa.ckpt', 'aaaaaaaaaa.json', 'aaaaaaaaaa.ring'] },
      { sessionId: SHELLS_SESSION, ptyId: 'bbbbbbbbbb', files: ['bbbbbbbbbb.ckpt'] },
    ])
    expect(p.staleSockets).toEqual([])
    expect(p.ignored).toEqual([{ ptyId: 'cccccccccc', why: 'socket without a state file' }])
    expect([p.orphans, p.put]).toEqual([[], []])
  })

  it('U-PTY-43 · PTYs being spawned are left alone, and nothing is concluded about sockets when the run directory was refused', () => {
    const p = plan({ records: [record('aaaaaaaaaa')], spawning: new Set(['aaaaaaaaaa']) })
    expect([p.put, p.ended, p.attached]).toEqual([[], [], []])
    const refused = plan({ records: [record('bbbbbbbbbb')], scan: { ...scan(onDisk('bbbbbbbbbb', { alive: false, socket: true })), socketsKnown: false } })
    expect(refused.ended.map((r) => r.ptyId)).toEqual(['bbbbbbbbbb'])
    expect(refused.staleSockets).toEqual([])
  })
})

describe('an ended PTY whose holder lingers', () => {
  it('U-PTY-60 · a record its exit note already ended (ptyhost adopted the holder before the reconciliation) and the same session’s holder, child exited: attached and released, not an orphan; a running holder of an ended record is still one', () => {
    const p = plan({
      records: [record('aaaaaaaaaa', { state: 'exited', exitCode: 0, endedAt: 2 }), record('bbbbbbbbbb', { state: 'exited', endedAt: 2 })],
      holders: [holder('aaaaaaaaaa', { state: 'exited', exitCode: 0 }), holder('bbbbbbbbbb')],
    })
    expect(p.attached).toEqual(['aaaaaaaaaa'])
    expect(p.release).toEqual(['aaaaaaaaaa'])
    expect(p.orphans.map((o) => [o.ptyId, o.reason])).toEqual([['bbbbbbbbbb', 'recordEnded']])
    expect(p.put, 'the record already says how it ended').toEqual([])
    expect(p.ended).toEqual([])
  })
})
