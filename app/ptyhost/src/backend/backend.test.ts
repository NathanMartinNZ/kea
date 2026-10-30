// How holders are started: detached, the non-detached fallback when detaching is refused, no terminals with
// a diagnostic banner when the helper cannot run, and one launch failing in place when it hits a resource
// limit. The launchers are stubbed here; the real helper runs in I-PTY-11 (tests/integration).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { constants } from 'node:os'
import path from 'node:path'
import { createMemoryLogger, HeldLimitError, POOL_LIMITS, PoolFullError, queuedCount, runDir, runProcess, SpawnError } from '@kea/kit'
import { channelPair, L, type PtyhostNote, type StreamToRenderer } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_HELPER_DIR, helperSpawnError, HolderLaunchError, installCurrentHelper, parseLaunchOutput, type LaunchRequest } from '../holder/launch.ts'
import { PtyManager } from '../manager.ts'
import { FakeHolder, tempHome } from '../test-support.ts'
import { HolderBackend, holderDetach, SESSION_MODE_BANNER } from './backend.ts'
import type { HeldHolder } from './held.ts'

/** The helper prints its system's own errno: EAGAIN is 35 on macOS, 11 on Linux (the others these tests use are the same on both). */
const EAGAIN = constants.errno.EAGAIN

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function home(): string {
  const h = tempHome()
  cleanups.push(() => fs.rmSync(h, { recursive: true, force: true }))
  return h
}

/** A helper "binary" the backend can install (its content is never run here). */
function helperFile(dir: string): string {
  const f = path.join(dir, 'kea-helper-src')
  fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return f
}

function request(h: string, ptyId = 'abcdefghij'): Omit<LaunchRequest, 'helper' | 'noDetach'> {
  return {
    ptyId,
    sessionId: 's1',
    kind: 'shell',
    stateDir: path.join(h, 'sessions', 's1'),
    sock: path.join(runDir(h), `${ptyId}.sock`),
    cols: 80,
    rows: 24,
    client: { option: '--client-req', value: 'test' },
    ringBytes: 1,
    keaVersion: 'test',
    spec: { file: '/bin/sh', args: [], env: {}, cwd: '/' },
  }
}

/** A non-detached holder stand-in: whether release() closed its stdin is observable (idempotent, as the real one). */
function heldStub(pid: number): HeldHolder & { released: number; exit(): void } {
  let exit!: () => void
  const exited = new Promise<never>((r) => (exit = () => r(undefined as never)))
  const h = {
    pid,
    childPid: pid + 1,
    released: 0,
    release() {
      h.released = 1
    },
    exited,
    exit,
  }
  return h
}

const detachRefused = () => new HolderLaunchError('posix_spawn /x/kea-helper: Operation not permitted', 'detach')

describe('holder backend: the non-detached fallback', () => {
  it('U-PTY-24 · a holder that cannot detach runs non-detached with the same request; later holders skip the detached try; one banner', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const detached = vi.fn(async (_r: LaunchRequest): Promise<{ pid: number; childPid: number }> => {
      throw detachRefused()
    })
    const held: LaunchRequest[] = []
    const b = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: true, detach: true },
      { log: createMemoryLogger(), notify: (n) => notes.push(n), launchDetached: detached, launchHeld: async (r) => (held.push(r), heldStub(100 + held.length)) },
    )
    expect(b.detaching).toBe(true)
    expect(await b.launch(request(h, 'aaaaaaaaaa'))).toEqual({ pid: 101, childPid: 102, detached: false })
    expect(detached).toHaveBeenCalledTimes(1)
    // the same request, the same installed helper: only the way it runs differs
    const { helper, ...asked } = detached.mock.calls[0]![0]
    expect(held[0]).toEqual({ ...asked, helper })
    expect(b.detaching).toBe(false)
    expect(await b.launch(request(h, 'bbbbbbbbbb'))).toMatchObject({ detached: false })
    expect(detached).toHaveBeenCalledTimes(1)
    expect(notes).toEqual([{ m: 'pty.banner', a: { kind: 'notDetached', message: expect.stringMatching(/^Sessions won't survive a crash or an update of Kea — .*Operation not permitted/) } }])
    expect(b.heldCount).toBe(2)
  })

  it('U-PTY-24 · with detaching off, every holder starts non-detached and says so at once', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const detached = vi.fn(async () => ({ pid: 1, childPid: 2 }))
    const b = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: true, detach: false },
      { log: createMemoryLogger(), notify: (n) => notes.push(n), launchDetached: detached, launchHeld: async () => heldStub(7) },
    )
    expect(notes.map((n) => n.m === 'pty.banner' && n.a.kind)).toEqual(['notDetached'])
    expect(await b.launch(request(h))).toEqual({ pid: 7, childPid: 8, detached: false })
    expect(detached).not.toHaveBeenCalled()
    expect(notes).toHaveLength(1)
  })

  it('U-PTY-24 · a launch refused for any other reason is not a detach problem: no fallback, no banner, the error stands', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const heldLaunch = vi.fn(async () => heldStub(1))
    const b = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: true, detach: true },
      {
        log: createMemoryLogger(),
        notify: (n) => notes.push(n),
        launchDetached: async () => {
          throw new HolderLaunchError('socket directory /x is a symlink; refusing to use it', 'refused')
        },
        launchHeld: heldLaunch,
      },
    )
    await expect(b.launch(request(h))).rejects.toThrow('refusing to use it')
    expect(heldLaunch).not.toHaveBeenCalled()
    expect(notes).toEqual([])
    expect(b.detaching).toBe(true)
  })

  it('U-PTY-24 · if the non-detached holder fails too, detaching is not blamed: the error is reported and the next launch tries detached again', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    let detachedTries = 0
    const b = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: true, detach: true },
      {
        log: createMemoryLogger(),
        notify: (n) => notes.push(n),
        launchDetached: async () => {
          detachedTries++
          throw new HolderLaunchError('the holder exited before it was ready', 'detach')
        },
        launchHeld: async () => {
          throw new HolderLaunchError('--client-req does not compile', 'refused')
        },
      },
    )
    await expect(b.launch(request(h))).rejects.toThrow('--client-req')
    expect(b.detaching).toBe(true)
    await expect(b.launch(request(h))).rejects.toThrow('--client-req')
    expect(detachedTries).toBe(2)
    expect(notes).toEqual([])
  })

  it('U-PTY-24 · through the manager: the PTY reports detached: false; removing it or disposing ptyhost closes its holder\'s stdin', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const stubs: (ReturnType<typeof heldStub> & { fake: FakeHolder })[] = []
    const m = new PtyManager(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: true, client: { option: '--client-req', value: 'test' } },
      {
        log: createMemoryLogger(),
        notify: (n) => notes.push(n),
        launchDetached: async () => {
          throw detachRefused()
        },
        // the "holder" is a fake speaking the protocol at the requested socket
        launchHeld: async (r) => {
          const fake = await FakeHolder.start({ dir: r.stateDir, sockDir: path.dirname(r.sock), ptyId: r.ptyId })
          cleanups.push(() => fake.close())
          const s = Object.assign(heldStub(500 + stubs.length), { fake })
          stubs.push(s)
          return s
        },
      },
    )
    cleanups.push(() => m.dispose())
    const spawn = (ptyId: string) =>
      m.spawn({ ptyId, sessionId: 's1', kind: 'shell', spec: { file: '/bin/sh', args: [], env: {}, cwd: '/' }, cols: 80, rows: 24, ringBytes: 1, keaVersion: 'test' })
    expect(await spawn('aaaaaaaaaa')).toEqual({ holderPid: 500, childPid: 501, detached: false })
    await spawn('bbbbbbbbbb')
    expect(m.list().map((p) => [p.ptyId, p.detached])).toEqual([
      ['aaaaaaaaaa', false],
      ['bbbbbbbbbb', false],
    ])
    // the terminal works as any other: a renderer attaches and gets output
    const [mine, theirs] = channelPair()
    const got: StreamToRenderer[] = []
    theirs.onMessage((x) => got.push(x as StreamToRenderer))
    m.attachStream('aaaaaaaaaa', mine)
    stubs[0]!.fake.emit('hello\r\n')
    await vi.waitFor(() => expect(got.some((x) => x.k === 'data' || (x.k === 'snapshot' && x.data.includes('hello')))).toBe(true))
    // the holder's connection goes (it exited and was released): ptyhost no longer owns it, so its stdin closes
    stubs[0]!.fake.exit(0)
    stubs[0]!.fake.dropClient()
    await vi.waitFor(() => expect(m.get('aaaaaaaaaa')).toBeUndefined())
    expect(stubs.map((s) => s.released)).toEqual([1, 0])
    m.dispose()
    expect(stubs.map((s) => s.released)).toEqual([1, 1])
    expect(notes.filter((n) => n.m === 'pty.banner')).toHaveLength(1)
  })
})

describe('holder backend: no helper, no terminals', () => {
  it('U-PTY-25 · a missing helper fails every launch with a banner naming the path and the fix, once per episode; it works again once the helper is back', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const source = path.join(h, 'kea-helper-src')
    const detached = vi.fn(async () => ({ pid: 1, childPid: 2 }))
    const b = new HolderBackend({ home: h, helperSource: source, keaVersion: 'test', dev: true, detach: true }, { log: createMemoryLogger(), notify: (n) => notes.push(n), launchDetached: detached })
    await expect(b.launch(request(h))).rejects.toMatchObject({ name: 'HolderLaunchError', kind: 'helper' })
    await expect(b.launch(request(h))).rejects.toMatchObject({ kind: 'helper' })
    expect(detached).not.toHaveBeenCalled()
    expect(notes).toEqual([{ m: 'pty.banner', a: { kind: 'helperMissing', message: `Terminals are unavailable: kea-helper not found at ${source}. Build it with \`pnpm helper:build\`, then open the terminal again.` } }])
    expect(b.unavailable).toContain('not found')
    helperFile(h)
    expect(await b.launch(request(h))).toEqual({ pid: 1, childPid: 2, detached: true })
    expect(b.unavailable).toBeNull()
    // broken again: a new episode, a new banner
    detached.mockRejectedValueOnce(new HolderLaunchError('kea-helper at /x not executable', 'helper'))
    await expect(b.launch(request(h))).rejects.toMatchObject({ kind: 'helper' })
    expect(notes).toHaveLength(2)
    expect(notes[1]).toMatchObject({ a: { kind: 'helperMissing', message: expect.stringContaining('not executable') } })
  })

  it('U-PTY-25 · an installed build names the fix as reinstalling Kea; a helper that cannot run non-detached either is reported the same way', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const b = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: false, detach: false },
      {
        log: createMemoryLogger(),
        notify: (n) => notes.push(n),
        launchHeld: async () => {
          throw new HolderLaunchError('kea-helper was killed by SIGKILL without a result: printed nothing', 'helper')
        },
      },
    )
    await expect(b.launch(request(h))).rejects.toMatchObject({ kind: 'helper' })
    expect(notes.map((n) => n.m === 'pty.banner' && n.a.kind)).toEqual(['notDetached', 'helperMissing'])
    expect(notes[1]).toMatchObject({ a: { message: expect.stringMatching(/SIGKILL.*Reinstall Kea/) } })
  })

  it('U-PTY-25 · through the manager: spawn rejects, nothing is added, and ptyhost keeps serving', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const m = new PtyManager({ home: h, helperSource: path.join(h, 'missing'), keaVersion: 'test', dev: true, client: { option: '--client-req', value: 'test' } }, { log: createMemoryLogger(), notify: (n) => notes.push(n) })
    cleanups.push(() => m.dispose())
    const spawn = m.handlers()['pty.spawn'] as (a: unknown, ctx: never) => Promise<unknown>
    await expect(spawn({ ptyId: 'abcdefghij', sessionId: 's1', kind: 'shell', spec: { file: '/bin/sh', args: [], env: {}, cwd: '/' }, cols: 80, rows: 24, ringBytes: 1, keaVersion: 'test' }, {} as never)).rejects.toThrow('not found')
    expect(m.size).toBe(0)
    expect(notes.map((n) => n.m === 'pty.banner' && n.a.kind)).toEqual(['helperMissing'])
    expect(await (m.handlers()['pty.list'] as (a: object, ctx: never) => Promise<unknown[]>)({}, {} as never)).toEqual([])
  })
})

describe('holder backend: a launch that hits a resource limit', () => {
  /** What ptyhost's own spawn of the launcher rejects with at a limit (kit's `SpawnError`, errno in `code`). */
  const spawnFailed = (helper: string, code: string) => helperSpawnError(helper, new SpawnError(Object.assign(new Error(`spawn ${code}`), { code }), helper, [], undefined))

  it('U-PTY-58 · EMFILE from ptyhost\'s spawn of the launcher, or EAGAIN from the launcher\'s posix_spawn, fails that one launch in place: no banner, terminals stay available, detaching stays on', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const heldLaunch = vi.fn(async () => heldStub(1))
    const detached = vi.fn(async (r: LaunchRequest): Promise<{ pid: number; childPid: number }> => {
      throw spawnFailed(r.helper, 'EMFILE')
    })
    const b = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: true, detach: true },
      { log: createMemoryLogger(), notify: (n) => notes.push(n), launchDetached: detached, launchHeld: heldLaunch },
    )
    // (a) ptyhost's spawn: the limit and what frees it, the errno kept, no build or reinstall advice
    const a = await b.launch(request(h)).catch((e: unknown) => e)
    expect(a).toMatchObject({ name: 'HolderLaunchError', kind: 'resource' })
    expect((a as Error).message).toMatch(/too many open files \(EMFILE\)\. Close some sessions or terminals/)
    expect((a as Error).message).not.toMatch(/helper:build|Reinstall/)
    expect(notes).toEqual([])
    expect(b.unavailable).toBeNull()
    expect(b.detaching).toBe(true)
    expect(heldLaunch).not.toHaveBeenCalled()
    // (b) the launcher's own posix_spawn of the daemon hits the process limit: not a detach problem
    detached.mockImplementationOnce(async () => parseLaunchOutput(`{"error":"posix_spawn /x/kea-helper: Resource temporarily unavailable (os error ${EAGAIN})"}\n`))
    const c = await b.launch(request(h)).catch((e: unknown) => e)
    expect(c).toMatchObject({ name: 'HolderLaunchError', kind: 'resource' })
    expect((c as Error).message).toMatch(/too many processes \(EAGAIN\)/)
    expect(heldLaunch).not.toHaveBeenCalled()
    expect(notes).toEqual([])
    expect(b.detaching).toBe(true)
    // the next launch still tries detached, and works
    detached.mockImplementationOnce(async () => ({ pid: 5, childPid: 6 }))
    expect(await b.launch(request(h))).toEqual({ pid: 5, childPid: 6, detached: true })
    expect(detached).toHaveBeenCalledTimes(3)
    expect(notes).toEqual([])
  })

  it('U-PTY-58 · the non-detached path classes a limit the same way (ENOMEM, ENFILE from ptyhost\'s spawn of the holder): no terminals-unavailable banner', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const codes = ['ENOMEM', 'ENFILE']
    const b = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: false, detach: false },
      {
        log: createMemoryLogger(),
        notify: (x) => notes.push(x),
        launchHeld: async (r) => {
          throw spawnFailed(r.helper, codes.shift()!)
        },
      },
    )
    await expect(b.launch(request(h))).rejects.toMatchObject({ kind: 'resource', message: expect.stringMatching(/not enough memory \(ENOMEM\)/) })
    await expect(b.launch(request(h))).rejects.toMatchObject({ kind: 'resource', message: expect.stringMatching(/\(ENFILE\)/) })
    expect(notes.map((x) => x.m === 'pty.banner' && x.a.kind)).toEqual(['notDetached']) // the not-detached banner only
    expect(b.unavailable).toBeNull()
  })

  it('U-PTY-70 · a limit met before the launcher\'s posix_spawn or inside the holder as it starts (open files, terminal devices, processes, memory: the helper\'s result line names the call and carries the errno) reads as the limit and what frees it, never as the helper\'s raw line: no banner, no non-detached retry; an errno that is no limit there stays what it was', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const heldLaunch = vi.fn(async () => heldStub(1))
    const lines: string[] = []
    const detached = vi.fn(async () => parseLaunchOutput(`${JSON.stringify({ error: lines.shift()! })}\n`))
    const b = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: true, detach: true },
      { log: createMemoryLogger(), notify: (n) => notes.push(n), launchDetached: detached, launchHeld: heldLaunch },
    )
    const said = async (line: string) => {
      lines.push(line)
      const e = (await b.launch(request(h)).catch((x: unknown) => x)) as HolderLaunchError
      expect(e, line).toMatchObject({ name: 'HolderLaunchError' })
      return { kind: e.kind, message: e.message }
    }
    const files = 'Close some sessions or terminals, then try again.'
    const mac = 'Close some sessions, terminals or other apps, then try again.'
    // the lines are kea-helper's own (launch.rs, holder.rs, holder/child.rs, admission.rs), with Rust's `(os error N)`
    const limits: [string, string][] = [
      // before the launcher's posix_spawn
      ['pipe: Too many open files (os error 24)', `Couldn't start the terminal: too many open files (EMFILE). ${files}`],
      // inside the holder as it starts
      ['cannot create /h/sessions/s1/abcdefghij.ring: Too many open files in system (os error 23)', `Couldn't start the terminal: too many open files on this Mac (ENFILE). ${mac}`],
      ['cannot start the child: openpty: Too many open files (os error 24)', `Couldn't start the terminal: too many open files (EMFILE). ${files}`],
      ['cannot start the child: openpty: Device not configured (os error 6)', "Couldn't start the terminal: this Mac has no terminal devices left (ENXIO). Close some terminals, here or in other apps, then try again."],
      // Linux's `kernel.pty.max` used up; the errno is 28 on both systems
      ['cannot start the child: openpty: No space left on device (os error 28)', "Couldn't start the terminal: no terminal devices are left (ENOSPC). Close some terminals, here or in other apps, then try again."],
      [`cannot start the child: fork: Resource temporarily unavailable (os error ${EAGAIN})`, `Couldn't start the terminal: too many processes (EAGAIN). ${mac}`],
      ['cannot start the child: fork: Cannot allocate memory (os error 12)', `Couldn't start the terminal: not enough memory (ENOMEM). ${mac}`],
      [`--client-req cannot be checked: fork: Resource temporarily unavailable (os error ${EAGAIN})`, `Couldn't start the terminal: too many processes (EAGAIN). ${mac}`],
      ['cannot write the state json in /h/sessions/s1: Too many open files (os error 24)', `Couldn't start the terminal: too many open files (EMFILE). ${files}`],
    ]
    for (const [line, message] of limits) expect(await said(line), line).toEqual({ kind: 'resource', message })
    expect(notes, 'no banner: the helper is fine').toEqual([])
    expect(heldLaunch, 'a limit is not a detach problem').not.toHaveBeenCalled()
    expect(b.unavailable).toBeNull()
    expect(b.detaching).toBe(true)
    // not limits: the same errno from another call (a socket that would block, a device that is not there), a full
    // disk, a refusal: each keeps the helper's line and its kind
    const others = [
      `cannot configure /h/run/abcdefghij.sock: Resource temporarily unavailable (os error ${EAGAIN})`,
      'cannot listen on /h/run/abcdefghij.sock: Device not configured (os error 6)',
      'cannot create /h/sessions/s1/abcdefghij.ring: No space left on device (os error 28)',
      'cannot start the child: openpty: Unknown error: -6 (os error -6)',
      '--cols must be at least 1',
    ]
    for (const line of others) expect(await said(line), line).toEqual({ kind: 'refused', message: line })
    expect(notes).toEqual([])
    expect(heldLaunch).not.toHaveBeenCalled()
    // and a posix_spawn that is refused for another reason is still "could not detach": the fallback runs
    lines.push('posix_spawn /x/kea-helper: Operation not permitted (os error 1)')
    expect(await b.launch(request(h))).toMatchObject({ detached: false })
    expect(heldLaunch).toHaveBeenCalledTimes(1)
  })
})

describe('holder backend: Kea’s own launch limits', () => {
  it('U-PTY-69 · a full launch queue (past L.poolQueueMax waiting, the real launcher call) and one non-detached holder too many (L.heldChildrenMax) fail that one launch as a limit, saying what was hit and what to do: no helper-missing banner, no reinstall advice, terminals stay available, detaching stays on', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const b = new HolderBackend({ home: h, helperSource: helperFile(h), keaVersion: 'test', dev: false, detach: true }, { log: createMemoryLogger(), notify: (n) => notes.push(n) })
    // every slot of the launcher's pool taken and its queue full, as when launches pile up behind slow ones
    const ctrl = new AbortController()
    const blockers = Array.from({ length: POOL_LIMITS.other }, () => runProcess('/bin/sleep', ['30'], { pool: 'other', signal: ctrl.signal }))
    const waiting = Array.from({ length: L.poolQueueMax }, () => runProcess('/bin/echo', [], { pool: 'other', signal: ctrl.signal }))
    try {
      await vi.waitFor(() => expect(queuedCount('other')).toBe(L.poolQueueMax))
      const full = await b.launch(request(h)).catch((e: unknown) => e)
      expect(full).toMatchObject({ name: 'HolderLaunchError', kind: 'resource' })
      expect((full as Error).message).toBe(`Couldn't start the terminal: too many terminals are starting at once (${L.poolQueueMax} waiting). Wait for them to start, then try again.`)
      expect(notes, 'no banner: the helper is fine').toEqual([])
      expect(b.unavailable).toBeNull()
      expect(b.detaching).toBe(true)
    } finally {
      ctrl.abort()
      await Promise.all([...blockers, ...waiting])
    }

    // non-detached holders are Kea's own children, at most L.heldChildrenMax of them: one more is a limit too
    const held: PtyhostNote[] = []
    const n = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: false, detach: false },
      {
        log: createMemoryLogger(),
        notify: (x) => held.push(x),
        launchHeld: async (r) => {
          throw helperSpawnError(r.helper, new HeldLimitError())
        },
      },
    )
    const over = await n.launch(request(h)).catch((e: unknown) => e)
    expect(over).toMatchObject({ name: 'HolderLaunchError', kind: 'resource' })
    expect((over as Error).message).toBe(`Couldn't start the terminal: too many terminals are open (${L.heldChildrenMax}). Close some sessions or terminals, then try again.`)
    expect(held.map((x) => x.m === 'pty.banner' && x.a.kind), 'the not-detached banner, nothing more').toEqual(['notDetached'])
    expect(n.unavailable).toBeNull()
    // an error that is neither a limit nor a spawn failure is still the helper's
    expect(helperSpawnError('/x/kea-helper', new Error('boom'))).toMatchObject({ kind: 'helper' })
  })
})

describe('holder backend: where the helper runs from', () => {
  it('U-HLD-13 · every holder, detached or not, is started from the newest helper at <home>/bin/current, never from the path Kea ships the helper at; a copy that has gone is installed again; the next build renames its own over it while a holder keeps the file it started from', async () => {
    const h = home()
    // the shipped helper, as it sits in an app bundle: an install replaces this file while holders run
    const bundle = path.join(h, 'Kea.app', 'Contents', 'Resources')
    fs.mkdirSync(bundle, { recursive: true })
    const shipped = path.join(bundle, 'kea-helper')
    fs.writeFileSync(shipped, 'build N', { mode: 0o755 })
    const helpers: string[] = []
    const deps = {
      log: createMemoryLogger(),
      notify: () => undefined,
      launchDetached: async (r: LaunchRequest) => (helpers.push(r.helper), { pid: 1, childPid: 2 }),
      launchHeld: async (r: LaunchRequest) => (helpers.push(r.helper), heldStub(3)),
    }
    const detached = new HolderBackend({ home: h, helperSource: shipped, keaVersion: '0.1.0', dev: false, detach: true }, deps)
    await detached.launch(request(h, 'aaaaaaaaaa'))
    const current = path.join(h, 'bin', CURRENT_HELPER_DIR, 'kea-helper')
    expect(helpers).toEqual([current])
    expect(fs.readFileSync(current, 'utf8')).toBe('build N')
    // the non-detached way runs the same file
    const held = new HolderBackend({ home: h, helperSource: shipped, keaVersion: '0.1.0', dev: false, detach: false }, deps)
    cleanups.push(() => held.dispose())
    await held.launch(request(h, 'bbbbbbbbbb'))
    expect(helpers).toEqual([current, current])
    // the copy went meanwhile (a mistaken removal must not end terminals): installed again
    fs.rmSync(path.dirname(current), { recursive: true })
    await detached.launch(request(h, 'cccccccccc'))
    expect(helpers[2]).toBe(current)
    expect(fs.readFileSync(current, 'utf8')).toBe('build N')
    // a holder runs the file it started from: here, one held open
    const running = fs.openSync(current, 'r')
    cleanups.push(() => fs.closeSync(running))
    // an install replaced the shipped helper: the next build's ptyhost puts its own at the same path, by rename
    fs.writeFileSync(shipped, 'build N+1', { mode: 0o755 })
    const next = new HolderBackend({ home: h, helperSource: shipped, keaVersion: '0.1.1', dev: false, detach: true }, deps)
    await next.launch(request(h, 'dddddddddd'))
    expect(helpers[3]).toBe(current)
    expect(fs.readFileSync(current, 'utf8')).toBe('build N+1')
    expect(fs.readFileSync(running, 'utf8'), 'the running holder’s file is untouched').toBe('build N')
    for (const used of helpers) expect(used.startsWith(path.join(h, 'bin') + path.sep), used).toBe(true)
  })

  it('U-HLD-17 · the newest helper is left alone when it already holds the shipped bytes, and otherwise renamed into place: a different file, a link (not followed) or a leftover temp file never survives, and nothing is written into the file a holder runs', () => {
    const h = home()
    const shipped = path.join(h, 'shipped-kea-helper')
    fs.writeFileSync(shipped, 'helper v1', { mode: 0o755 })
    const current = installCurrentHelper(shipped, h)
    expect(current).toBe(path.join(h, 'bin', CURRENT_HELPER_DIR, 'kea-helper'))
    expect(fs.statSync(current).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.dirname(current)).mode & 0o777).toBe(0o700)
    const first = fs.statSync(current).ino
    // the same bytes: not copied again
    expect(installCurrentHelper(shipped, h)).toBe(current)
    expect(fs.statSync(current).ino).toBe(first)
    // other bytes of the same size: a new file, by rename
    fs.writeFileSync(shipped, 'helper v2', { mode: 0o755 })
    installCurrentHelper(shipped, h)
    expect(fs.readFileSync(current, 'utf8')).toBe('helper v2')
    expect(fs.statSync(current).ino).not.toBe(first)
    // a link where the helper should be is replaced, and what it pointed at is untouched
    const elsewhere = path.join(h, 'elsewhere')
    fs.writeFileSync(elsewhere, 'helper v2')
    fs.rmSync(current)
    fs.symlinkSync(elsewhere, current)
    installCurrentHelper(shipped, h)
    expect(fs.lstatSync(current).isFile()).toBe(true)
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('helper v2')
    // a temp file a killed ptyhost left behind is overwritten, and none is left
    fs.writeFileSync(`${current}.${process.pid}.tmp`, 'half a copy')
    fs.writeFileSync(shipped, 'helper v3', { mode: 0o755 })
    installCurrentHelper(shipped, h)
    expect(fs.readFileSync(current, 'utf8')).toBe('helper v3')
    expect(fs.readdirSync(path.dirname(current))).toEqual(['kea-helper'])
  })
})

describe('holder backend: session mode on Linux', () => {
  // A holder that detached into a session of its own, not a systemd scope, says so in its state json (`detach`); the
  // first such launch raises one banner, later ones none; a scope, or no `detach` at all (macOS), none. The launch
  // itself is a normal detached one either way.
  it('U-PLT-14 · a launch whose state json says detach "session" raises the session-mode banner once; "scope" and macOS\'s none raise nothing', async () => {
    const h = home()
    const notes: PtyhostNote[] = []
    const modes: Record<string, string | undefined> = { scopescope: 'scope', nonenonenn: undefined, sessionone: 'session', sessiontwo: 'session' }
    const detached = vi.fn(async (r: LaunchRequest) => {
      fs.mkdirSync(r.stateDir, { recursive: true })
      const mode = modes[r.ptyId]
      fs.writeFileSync(path.join(r.stateDir, `${r.ptyId}.json`), JSON.stringify({ ptyId: r.ptyId, pid: 1, ...(mode ? { detach: mode } : {}) }))
      return { pid: 1, childPid: 2 }
    })
    const b = new HolderBackend(
      { home: h, helperSource: helperFile(h), keaVersion: 'test', dev: true, detach: true },
      { log: createMemoryLogger(), notify: (n) => notes.push(n), launchDetached: detached },
    )
    for (const id of ['scopescope', 'nonenonenn']) expect(await b.launch(request(h, id))).toEqual({ pid: 1, childPid: 2, detached: true })
    expect(notes).toEqual([])
    for (const id of ['sessionone', 'sessiontwo']) expect(await b.launch(request(h, id))).toEqual({ pid: 1, childPid: 2, detached: true })
    expect(notes).toEqual([{ m: 'pty.banner', a: { kind: 'sessionMode', message: SESSION_MODE_BANNER } }])
    expect(SESSION_MODE_BANNER).toMatch(/^Sessions may end if your desktop stops Kea — /)
    expect(b.detaching, 'still detached: session mode is not the non-detached fallback').toBe(true)
    expect(holderDetach(path.join(h, 'sessions', 's1'), 'missingone'), 'no state json').toBeNull()
    // the session folder is the agent's to write: a link in the state json's place is not followed, and a FIFO there is
    // not waited on (ptyhost's thread serves every terminal)
    const dir = path.join(h, 'sessions', 's1')
    fs.writeFileSync(path.join(dir, 'elsewhere.json'), JSON.stringify({ detach: 'session' }))
    fs.symlinkSync(path.join(dir, 'elsewhere.json'), path.join(dir, 'linkedone.json'))
    expect(holderDetach(dir, 'linkedone'), 'a link').toBeNull()
    execFileSync('/usr/bin/mkfifo', [path.join(dir, 'fifofifofi.json')]) // os-ok: in /usr/bin on both systems
    expect(holderDetach(dir, 'fifofifofi'), 'a FIFO').toBeNull()
  })
})

