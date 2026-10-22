import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { noopLogger, type Clock } from '@kea/kit'
import { L, RpcError, type CallContext, type FollowResult } from '@kea/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StubGitFacts } from '../files/facts.ts'
import { VisibleSet } from '../platform/visible.ts'
import { StubWatchService } from '../platform/watch/stub.ts'
import { ViewerService } from './service.ts'

/** A clock the test moves: timers run when time reaches them. */
class ManualClock implements Clock {
  private t = 0
  private seq = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()
  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => {
    this.timers.set(++this.seq, { at: this.t + ms, fn })
    return this.seq
  }
  clearTimeout = (h: unknown) => void this.timers.delete(h as number)
  setInterval = () => {
    throw new Error('not used')
  }
  clearInterval = () => undefined
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      const due = [...this.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.t = due[1].at
      due[1].fn()
    }
    this.t = end
  }
  get pending(): number {
    return this.timers.size
  }
}

let tmp: string
let cwdA: string
let cwdB: string
const INTERVAL = 1000 / L.viewerReloadPerS

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-viewer-service-')))
  cwdA = path.join(tmp, 'a')
  cwdB = path.join(tmp, 'b')
  for (const d of [cwdA, cwdB]) fs.mkdirSync(d)
  fs.writeFileSync(path.join(cwdA, 'a.ts'), 'in a\n')
  fs.writeFileSync(path.join(cwdB, 'b.ts'), 'in b\n')
  fs.writeFileSync(path.join(cwdA, 'doc.pdf'), '%PDF-1.7\n')
  fs.writeFileSync(path.join(cwdA, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
  fs.symlinkSync(path.join(cwdB, 'b.ts'), path.join(cwdA, 'escape.ts'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function setup() {
  const visible = new VisibleSet()
  const watch = new StubWatchService()
  const git = new StubGitFacts()
  const clock = new ManualClock()
  const opened: string[] = []
  const service = new ViewerService({
    log: noopLogger,
    cwd: (id) => (id === 'A' ? cwdA : id === 'B' ? cwdB : null),
    visible,
    watch,
    git,
    gitEnv: () => Promise.resolve({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
    openTool: null,
    openDefault: (file) => {
      opened.push(file)
      return Promise.resolve({ ok: true, message: null })
    },
    clock,
  })
  const h = service.handlers()
  const windowOne = {}
  const windowTwo = {}
  const ctx = (peer: object, signal: AbortSignal = new AbortController().signal) => ({ peer, signal }) as unknown as CallContext
  return { visible, watch, git, clock, opened, service, h, windowOne, windowTwo, ctx }
}

/** The state of a promise right now: its value once it has settled, else 'pending'. */
async function settled<T>(p: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((r) => setImmediate(() => r('pending')))])
}

describe('the viewer service', () => {
  it('U-FV-13 · calls are served only for the session the asking window shows; a window follows one file, answered at a throttled rate, until it shows another session or goes', async () => {
    const { visible, watch, git, clock, opened, service, h, windowOne, windowTwo, ctx } = setup()
    const read = h['viewer.read']!
    const follow = h['viewer.follow']!

    // nothing shown: refused, whatever is asked
    await expect(read({ sessionId: 'A', path: 'a.ts' }, ctx(windowOne))).rejects.toMatchObject({ code: 'not_visible' })
    visible.set(windowOne, 'A')
    const a = await read({ sessionId: 'A', path: 'a.ts' }, ctx(windowOne))
    expect(Buffer.from((a as { text: { bytes: Uint8Array } }).text.bytes).toString()).toBe('in a\n')
    // the window shows A, so B's files are not its to read, and another window is not this one
    await expect(read({ sessionId: 'B', path: 'b.ts' }, ctx(windowOne))).rejects.toBeInstanceOf(RpcError)
    await expect(read({ sessionId: 'A', path: 'a.ts' }, ctx(windowTwo))).rejects.toMatchObject({ code: 'not_visible' })
    for (const m of ['viewer.diff', 'viewer.changes', 'viewer.openDefault'] as const) await expect(Promise.resolve().then(() => h[m]!({ sessionId: 'B', path: 'b.ts' }, ctx(windowOne)))).rejects.toMatchObject({ code: 'not_visible' })
    expect(() => follow({ sessionId: 'B', path: 'b.ts', seen: 0 }, ctx(windowOne))).toThrow(RpcError)
    // a session with no folder
    visible.set(windowTwo, 'ghost')
    await expect(read({ sessionId: 'ghost', path: 'a.ts' }, ctx(windowTwo))).rejects.toMatchObject({ code: 'no_folder' })
    visible.set(windowTwo, null)
    // a link out of A is not read through A
    expect(await read({ sessionId: 'A', path: 'escape.ts' }, ctx(windowOne))).toMatchObject({ kind: 'outside', text: null })
    expect(service.resourceCounts).toEqual({ follows: 0, waiters: 0, timers: 0, reads: 0 })

    // ── following ──
    const first = follow({ sessionId: 'A', path: 'a.ts', seen: 0 }, ctx(windowOne)) as Promise<FollowResult>
    expect(watch.watched()).toEqual([{ kind: 'file', path: path.join(cwdA, 'a.ts') }])
    expect(await settled(first)).toBe('pending')
    expect(service.resourceCounts).toMatchObject({ follows: 1, waiters: 1, timers: 0 })
    // the first change is answered at once
    watch.fire(path.join(cwdA, 'a.ts'))
    expect(await first).toEqual({ rev: 1, file: true, git: false, ended: false })

    // changes while nobody waits are kept for the next call; that call waits out the rest of the interval
    watch.fire(path.join(cwdA, 'a.ts'))
    watch.fire(path.join(cwdA, 'a.ts'))
    git.set('A', { scope: 'uncommitted' })
    const second = follow({ sessionId: 'A', path: 'a.ts', seen: 1 }, ctx(windowOne)) as Promise<FollowResult>
    expect(await settled(second)).toBe('pending')
    expect(service.resourceCounts).toMatchObject({ follows: 1, waiters: 1, timers: 1 })
    clock.advance(INTERVAL - 1)
    expect(await settled(second)).toBe('pending')
    clock.advance(1)
    expect(await second).toEqual({ rev: 4, file: true, git: true, ended: false })
    expect(watch.size).toBe(1)

    // a burst (an agent writing): the follow rate, each answer carrying everything since the one before
    let seen = 4
    let answers = 0
    for (let tick = 0; tick < 10; tick++) {
      const wait = follow({ sessionId: 'A', path: 'a.ts', seen }, ctx(windowOne)) as Promise<FollowResult>
      for (let i = 0; i < 20; i++) watch.fire(path.join(cwdA, 'a.ts'))
      clock.advance(INTERVAL / 2)
      const r = await settled(wait)
      if (r !== 'pending') {
        answers++
        seen = r.rev
        continue
      }
      clock.advance(INTERVAL / 2)
      seen = (await wait).rev
      answers++
      tick++
    }
    // ten half-intervals: five intervals, so at most five answers (one more for the one already due)
    expect(answers).toBeLessThanOrEqual(6)
    expect(seen).toBe(4 + answers * 20)

    // git state of another session is not this follow's news
    const quiet = follow({ sessionId: 'A', path: 'a.ts', seen }, ctx(windowOne)) as Promise<FollowResult>
    clock.advance(INTERVAL)
    git.set('B', { scope: 'uncommitted' })
    watch.fire(path.join(cwdB, 'b.ts'))
    expect(await settled(quiet)).toBe('pending')

    // asking again replaces the waiting call (told nothing new); a cancelled call stops waiting, the follow stays
    const again = follow({ sessionId: 'A', path: 'a.ts', seen }, ctx(windowOne)) as Promise<FollowResult>
    expect(await quiet).toEqual({ rev: seen, file: false, git: false, ended: false })
    expect(service.resourceCounts).toMatchObject({ follows: 1, waiters: 1 })
    const abort = new AbortController()
    const cancelled = follow({ sessionId: 'A', path: 'a.ts', seen }, ctx(windowOne, abort.signal)) as Promise<FollowResult>
    await again
    abort.abort()
    expect(await cancelled).toMatchObject({ ended: false })
    expect(service.resourceCounts).toMatchObject({ follows: 1, waiters: 0 })

    // following another path ends the one before: one watch per window
    const other = follow({ sessionId: 'A', path: 'doc.pdf', seen: 0 }, ctx(windowOne)) as Promise<FollowResult>
    expect(watch.watched()).toEqual([{ kind: 'file', path: path.join(cwdA, 'doc.pdf') }])
    // a second window has its own
    visible.set(windowTwo, 'B')
    const two = follow({ sessionId: 'B', path: 'b.ts', seen: 0 }, ctx(windowTwo)) as Promise<FollowResult>
    expect(watch.size).toBe(2)
    expect(service.resourceCounts).toMatchObject({ follows: 2, waiters: 2 })

    // The window shows another session → its follow ends, its call is told so, the watch is gone
    visible.set(windowOne, 'B')
    expect(await other).toMatchObject({ ended: true })
    expect(watch.watched()).toEqual([{ kind: 'file', path: path.join(cwdB, 'b.ts') }])
    // the window goes (its connection drops it from the visible set)
    visible.drop(windowTwo)
    expect(await two).toMatchObject({ ended: true })
    expect(watch.size).toBe(0)
    expect(service.resourceCounts).toEqual({ follows: 0, waiters: 0, timers: 0, reads: 0 })

    // unfollow, and a timer left by a throttled answer goes with its follow
    const last = follow({ sessionId: 'B', path: 'b.ts', seen: 0 }, ctx(windowOne)) as Promise<FollowResult>
    watch.fire(path.join(cwdB, 'b.ts'))
    const { rev } = await last
    watch.fire(path.join(cwdB, 'b.ts'))
    const waiting = follow({ sessionId: 'B', path: 'b.ts', seen: rev }, ctx(windowOne)) as Promise<FollowResult>
    expect(service.resourceCounts).toMatchObject({ timers: 1 })
    expect(clock.pending).toBe(1)
    expect(await h['viewer.unfollow']!({}, ctx(windowOne))).toEqual({ ok: true })
    expect(await waiting).toMatchObject({ ended: true })
    expect(clock.pending).toBe(0)
    expect(watch.size).toBe(0)

    // ── open with the default app: a plain file inside the folder, never an executable or a link out ──
    visible.set(windowOne, 'A')
    const open = h['viewer.openDefault']!
    expect(await open({ sessionId: 'A', path: 'doc.pdf' }, ctx(windowOne))).toEqual({ ok: true, message: null })
    expect(opened).toEqual([path.join(cwdA, 'doc.pdf')])
    for (const p of ['tool', 'escape.ts', 'none.txt']) expect(await open({ sessionId: 'A', path: p }, ctx(windowOne))).toMatchObject({ ok: false })
    expect(opened).toHaveLength(1)

    // disposal ends what is left
    const end = follow({ sessionId: 'A', path: 'a.ts', seen: 0 }, ctx(windowOne)) as Promise<FollowResult>
    service.dispose()
    expect(await end).toMatchObject({ ended: true })
    expect(watch.size).toBe(0)
    expect(await follow({ sessionId: 'A', path: 'a.ts', seen: 0 }, ctx(windowOne))).toMatchObject({ ended: true })
  })
})
