import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@kea/kit'
import { L } from '@kea/protocol'

/** Electron's utilityProcess, faked: what main posted, and a way to answer as the child. */
const fake = vi.hoisted(() => {
  class FakeProc {
    readonly pid = 4242
    readonly posted: unknown[] = []
    options: Record<string, unknown> = {}
    readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    on(event: string, cb: (...a: unknown[]) => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb])
    }
    emit(event: string, ...a: unknown[]): void {
      for (const cb of this.listeners.get(event) ?? []) cb(...a)
    }
    postMessage(m: unknown): void {
      this.posted.push(m)
    }
    kill(): void {
      this.emit('exit', 9)
    }
  }
  const procs: FakeProc[] = []
  return { FakeProc, procs }
})

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (_entry: string, _args: string[], options: Record<string, unknown>) => {
      const p = new fake.FakeProc()
      p.options = options
      fake.procs.push(p)
      return p
    },
  },
}))

const { UtilityChild } = await import('./utility.ts')

afterEach(() => {
  vi.useRealTimers()
  fake.procs.length = 0
})

function start() {
  const log = createMemoryLogger({ process: 'main' })
  const u = new UtilityChild('ptyhost', '/nowhere/ptyhost.cjs', [], log)
  const proc = fake.procs.at(-1)
  if (!proc) throw new Error('no fork')
  const lastReportId = () => (proc.posted.filter((m) => (m as { k?: string }).k === 'report').at(-1) as { id: number }).id
  return { u, proc, log, lastReportId }
}

describe('UtilityChild: V8 flags', () => {
  it('U-PTY-55 · V8 flags reach the child as one `--js-flags=` argument, the only form a utility process honours; none, no execArgv', () => {
    const log = createMemoryLogger({ process: 'main' })
    new UtilityChild('ptyhost', '/nowhere/ptyhost.cjs', [], log, undefined, ['--max-semi-space-size=2', '--expose-gc'])
    expect(fake.procs.at(-1)?.options.execArgv).toEqual(['--js-flags=--max-semi-space-size=2 --expose-gc'])
    new UtilityChild('core', '/nowhere/core.cjs', [], log)
    expect(fake.procs.at(-1)?.options).not.toHaveProperty('execArgv')
  })
})

describe('UtilityChild: report requests', () => {
  it('U-MEM-19 · a child’s report that fails the checks ends its request at once (no wait for the deadline) and is logged; a valid one is the answer', async () => {
    vi.useFakeTimers()
    const { u, proc, log, lastReportId } = start()
    let got: unknown = 'pending'
    void u.report(L.resourceReportTimeoutMs).then((r) => (got = r))
    proc.emit('message', { k: 'report', id: lastReportId(), report: { 'ptyhost.rows': 'not a count' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(got, 'ended at once, before any deadline').toBeNull()
    expect(u.pendingReports).toBe(0)
    expect(log.entries.map((e) => [e.level, e.msg, e.process, e.id])).toEqual([['warn', 'resource report refused', 'ptyhost', lastReportId()]])
    // too many rows: refused the same way
    void u.report(L.resourceReportTimeoutMs).then((r) => (got = r))
    proc.emit('message', { k: 'report', id: lastReportId(), report: Object.fromEntries(Array.from({ length: L.resourceReportRowsMax + 1 }, (_, i) => [`r${i}`, i])) })
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toBeNull()
    // a valid answer
    void u.report(L.resourceReportTimeoutMs).then((r) => (got = r))
    proc.emit('message', { k: 'report', id: lastReportId(), report: { 'ptyhost.streams': 2, 'ptyhost.failed': Number.NaN } })
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toEqual({ 'ptyhost.streams': 2, 'ptyhost.failed': Number.NaN })
    expect(u.pendingReports).toBe(0)
  })

  it('U-FAIL-4 · a child that said `ready` is remembered as having been ready after it exits (main’s Reconnecting notice); one that never did is not', () => {
    const a = start()
    a.proc.emit('message', { k: 'ready' })
    expect([a.u.isReady, a.u.wasReady]).toEqual([true, true])
    a.proc.emit('exit', 1)
    expect([a.u.isReady, a.u.wasReady]).toEqual([false, true])
    const b = start()
    b.proc.emit('message', { k: 'locked', path: '/x/run/core.lock' })
    b.proc.emit('exit', 3)
    expect([b.u.isReady, b.u.wasReady]).toEqual([false, false])
  })
})
