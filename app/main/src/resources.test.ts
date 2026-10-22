import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger, resources, type Clock, type ProcessResult } from '@kea/kit'
import { L, type ResourceReport } from '@kea/protocol'
import { collectReports, FootprintSampler, nameProcesses, parseFootprint, Replies, RESOURCE_LOG_FILE, ResourceLog, type Collected, type FootprintSample, type ReportSource, type RunFn, type WatchdogTrigger } from './resources.ts'

/** Timers and `now` on Vitest's fake clock (Date is faked with the timers). */
const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

function result(stdout: string, code = 0): ProcessResult {
  return { code, signal: null, stdout: Buffer.from(stdout), stderr: '', stdoutBytes: stdout.length, truncated: false, timedOut: false, cancelled: false, durationMs: 1, queuedMs: 0, pid: 1 }
}

const timers = (): number => resources.report()['kit.timers'] as number

let tmp: string
beforeAll(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'kea-main-resources-'))
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('footprint sampler', () => {
  it('U-MEM-18 · one `kea-helper footprint <pid…>` run per L.watchdogIntervalMs through runProcess; the ring keeps the newest L.metricsSamplesKept; one run at a time; disposed, nothing runs', async () => {
    const before = timers()
    const calls: { argv: string[]; pool: string; timeoutMs: number | undefined }[] = []
    let gate: (() => void) | null = null
    const run: RunFn = async (file, args, opts) => {
      calls.push({ argv: [file, ...args], pool: opts.pool, timeoutMs: opts.timeoutMs })
      if (gate === null) await new Promise<void>((r) => (gate = r))
      // core's line reports an error, main's a size; ptyhost is not printed at all
      return result(`${args[1]} ${Number(args[1]) * 1000}\n${args[2]} error no such process\n`)
    }
    const seen: FootprintSample[] = []
    const s = new FootprintSampler({
      helper: '/x/kea-helper',
      pids: () => [
        { name: 'main', pid: 11 },
        { name: 'core', pid: 22 },
        { name: 'ptyhost', pid: 33 },
      ],
      log: createMemoryLogger(),
      clock,
      run,
      onInterval: (x) => seen.push(x as FootprintSample),
    })
    s.start()
    expect(timers()).toBe(before + 1) // one timer: the interval
    await vi.advanceTimersByTimeAsync(L.watchdogIntervalMs - 1)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual([{ argv: ['/x/kea-helper', 'footprint', '11', '22', '33'], pool: 'other', timeoutMs: L.resourceReportTimeoutMs }])
    // a sample asked for while the run is in flight shares it: still one run
    const shared = s.sample()
    expect(calls).toHaveLength(1)
    ;(gate as unknown as () => void)()
    const first = await shared
    expect(first).toEqual({ t: Date.now(), pids: { main: 11, core: 22, ptyhost: 33 }, bytes: { main: 11_000 }, errors: { core: 'no such process', ptyhost: 'not reported' } })
    expect(s.latest).toBe(first)
    expect(s.size).toBe(1)
    expect(seen).toEqual([first])

    // the ring: the newest L.metricsSamplesKept samples, oldest dropped
    const extra = 5
    for (let i = 0; i < L.metricsSamplesKept + extra - 1; i++) await vi.advanceTimersByTimeAsync(L.watchdogIntervalMs)
    expect(calls).toHaveLength(L.metricsSamplesKept + extra)
    expect(s.size).toBe(L.metricsSamplesKept)
    const kept = s.samples()
    expect(kept[0]?.t).toBe((first as FootprintSample).t + extra * L.watchdogIntervalMs)
    expect(kept.at(-1)).toBe(s.latest)

    s.dispose()
    expect(timers()).toBe(before)
    await vi.advanceTimersByTimeAsync(L.watchdogIntervalMs * 2)
    expect(calls).toHaveLength(L.metricsSamplesKept + extra)
    expect(await s.sample()).toBeNull()
  })

  it('U-MEM-18 · processes are named from what main knows, then by type (Linux’s zygotes `zygote`); helper output is parsed by pid; a failed run keeps no sample', async () => {
    const known = new Map([
      [1, 'main'],
      [2, 'core'],
      [5, 'renderer'],
    ])
    const named = nameProcesses(
      [
        { pid: 1, type: 'Browser' },
        { pid: 2, type: 'Utility', serviceName: 'Kea core' },
        { pid: 3, type: 'GPU' },
        { pid: 4, type: 'Utility', serviceName: 'network.mojom.NetworkService' },
        { pid: 5, type: 'Tab' },
        { pid: 6, type: 'Utility', serviceName: 'network.mojom.NetworkService' },
        // Linux's zygotes, which main adds itself (`zygote`, then `zygote:<pid>`)
        { pid: 7, type: 'Zygote' },
        { pid: 8, type: 'Zygote' },
      ],
      known,
    )
    expect(named).toEqual([
      { name: 'main', pid: 1 },
      { name: 'core', pid: 2 },
      { name: 'gpu', pid: 3 },
      { name: 'utility:network.mojom.NetworkService', pid: 4 },
      { name: 'renderer', pid: 5 },
      { name: 'utility:network.mojom.NetworkService:6', pid: 6 },
      { name: 'zygote', pid: 7 },
      { name: 'zygote:8', pid: 8 },
    ])
    expect(parseFootprint('1 100\n3 error permission denied\nx error invalid pid\n99 5\n\n', named.slice(0, 3))).toEqual({ bytes: { main: 100 }, errors: { gpu: 'permission denied', core: 'not reported' } })

    const log = createMemoryLogger()
    const s = new FootprintSampler({ helper: '/h', pids: () => [{ name: 'main', pid: 1 }], log, clock, run: async () => result('', 1) })
    expect(await s.sample()).toBeNull()
    expect(s.size).toBe(0)
    expect(log.entries.map((e) => e.msg)).toEqual(['footprint sample failed'])
    const none = new FootprintSampler({ helper: '/h', pids: () => [], log, clock, run: async () => result('') })
    expect(await none.sample()).toBeNull()
    s.dispose()
    none.dispose()
  })

  it('U-MEM-18 · every interval ends in onInterval, with its sample or null when the run failed (exit code, timeout, a run or pid list that throws); nothing after dispose', async () => {
    const outcomes: (() => Promise<ProcessResult>)[] = [
      async () => result('1 100\n'),
      async () => result('', 1),
      async () => ({ ...result(''), code: null, timedOut: true }),
      async () => {
        throw new Error('spawn EAGAIN')
      },
    ]
    let n = 0
    let pidsThrow = false
    const seen: (number | null)[] = []
    const log = createMemoryLogger()
    const s = new FootprintSampler({
      helper: '/h',
      pids: () => {
        if (pidsThrow) throw new Error('no metrics')
        return [{ name: 'main', pid: 1 }]
      },
      log,
      clock,
      run: () => (outcomes[n++] as () => Promise<ProcessResult>)(),
      onInterval: (x) => seen.push(x ? (x.bytes.main as number) : null),
    })
    s.start()
    for (let i = 0; i < outcomes.length; i++) await vi.advanceTimersByTimeAsync(L.watchdogIntervalMs)
    expect(seen).toEqual([100, null, null, null])
    pidsThrow = true
    await vi.advanceTimersByTimeAsync(L.watchdogIntervalMs)
    expect(seen).toEqual([100, null, null, null, null])
    expect(log.entries.filter((e) => e.msg === 'footprint sample failed')).toHaveLength(4)
    s.dispose()
    await vi.advanceTimersByTimeAsync(L.watchdogIntervalMs * 3)
    expect(seen).toHaveLength(5)
  })
})

describe('report collection', () => {
  it('U-MEM-19 · a process that does not answer within L.resourceReportTimeoutMs is listed as missing, never awaited longer; its late answer is ignored', async () => {
    const before = timers()
    const core = new Replies<ResourceReport>(clock)
    const ptyhost = new Replies<ResourceReport>(clock)
    const asked: number[] = []
    const sources: ReportSource[] = [
      { name: 'main', ask: async () => ({ 'main.windows': 1 }) },
      { name: 'core', ask: () => core.ask((id) => queueMicrotask(() => core.answer(id, { 'core.connections': 1, 'kit.children': { 'other.active': 0 } })), L.resourceReportTimeoutMs) },
      { name: 'ptyhost', ask: () => ptyhost.ask((id) => asked.push(id), L.resourceReportTimeoutMs) }, // stopped: never answers
      { name: 'renderer', ask: () => Promise.reject(new Error('window gone')) },
      { name: 'renderer:9', ask: async () => null }, // refused, or ended with its window
      { name: 'renderer:10', absent: 'not running' },
    ]
    let settled = false
    const p = collectReports(sources).then((r) => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(L.resourceReportTimeoutMs - 1)
    expect(settled).toBe(false)
    expect(ptyhost.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({
      reports: { main: { 'main.windows': 1 }, core: { 'core.connections': 1, 'kit.children': { 'other.active': 0 } } },
      missing: { ptyhost: 'no answer', renderer: 'no answer', 'renderer:9': 'no answer', 'renderer:10': 'not running' },
    })
    expect(ptyhost.size).toBe(0)
    expect(ptyhost.answer(asked[0] as number, { 'ptyhost.control': 1 })).toBe(false) // too late
    expect(timers()).toBe(before) // every deadline timer gone
    core.dispose()
    ptyhost.dispose()
  })

  it('U-MEM-19 · an answer counts only from the one asked and only once; an exit ends every request at once', async () => {
    const r = new Replies<ResourceReport>(clock)
    let id = 0
    const q = r.ask((i) => (id = i), L.resourceReportTimeoutMs, 7)
    expect(r.answer(id, { a: 1 }, 8)).toBe(false) // another window
    expect(r.answer(id + 1, { a: 1 }, 7)).toBe(false) // another request
    expect(r.answer(id, { a: 2 }, 7)).toBe(true)
    expect(r.answer(id, { a: 3 }, 7)).toBe(false)
    expect(await q).toEqual({ a: 2 })

    const waiting = [r.ask(() => undefined, L.resourceReportTimeoutMs), r.ask(() => undefined, L.resourceReportTimeoutMs)]
    expect(r.size).toBe(2)
    r.cancelAll() // the child exited
    expect(await Promise.all(waiting)).toEqual([null, null])
    expect(r.size).toBe(0)
    // a send that throws (the window is being destroyed) ends its request at once
    expect(await r.ask(() => {
      throw new Error('destroyed')
    }, L.resourceReportTimeoutMs)).toBeNull()
    r.dispose()
    expect(await r.ask(() => undefined, L.resourceReportTimeoutMs)).toBeNull()
  })

  it('U-MEM-19 · a refused answer ends its request at once; a window that closes, reloads or loses its renderer ends its own requests at once and no other window’s', async () => {
    const before = timers()
    const r = new Replies<ResourceReport>(clock)
    const ids: number[] = []
    const a1 = r.ask((i) => ids.push(i), L.resourceReportTimeoutMs, 1)
    const a2 = r.ask((i) => ids.push(i), L.resourceReportTimeoutMs, 1)
    const b = r.ask((i) => ids.push(i), L.resourceReportTimeoutMs, 2)
    expect(r.end(ids[0] as number, 2)).toBe(false) // not who was asked
    expect(r.end(ids[0] as number, 1)).toBe(true)
    expect(await a1).toBeNull()
    r.cancelFrom(1)
    expect(await a2).toBeNull()
    expect(r.size).toBe(1)
    expect(r.answer(ids[2] as number, { 'renderer.terminals': 1 }, 2)).toBe(true)
    expect(await b).toEqual({ 'renderer.terminals': 1 })
    expect(timers(), 'every deadline timer gone at once').toBe(before)
    r.dispose()
  })

  it('U-MEM-19 · with no window open the renderer is listed as missing with `no window`; a child that is not running is not asked', async () => {
    let asked = 0
    const got = await collectReports([
      { name: 'main', ask: async () => ({ 'main.windows': 0 }) },
      { name: 'core', absent: 'not running' },
      { name: 'ptyhost', ask: async () => (asked++, { 'ptyhost.streams': 0 }) },
      { name: 'renderer', absent: 'no window' },
    ])
    expect(got).toEqual({ reports: { main: { 'main.windows': 0 }, ptyhost: { 'ptyhost.streams': 0 } }, missing: { core: 'not running', renderer: 'no window' } })
    expect(asked).toBe(1)
  })
})

describe('resources.ndjson', () => {
  const sample: FootprintSample = { t: Date.UTC(2026, 9, 7, 12, 0, 0), pids: { main: 1, core: 2, ptyhost: 3, renderer: 4, gpu: 5 }, bytes: { main: 100, core: 200, ptyhost: 300, renderer: 400, gpu: 500 } }
  const collected: Collected = { reports: { main: { 'main.windows': 1 }, core: { 'core.connections': 1, 'core.orphans': 0 }, renderer: { 'renderer.commandHandlers': 12 } }, missing: { ptyhost: 'no answer' } }

  function lines(file: string): Record<string, unknown>[] {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  it('U-MEM-20 · the hourly line holds every process’s report, the missing ones and the newest footprint sample; it is due only L.resourceLogIntervalMs after the last', async () => {
    const dir = join(tmp, 'line')
    let samples = 0
    const log = new ResourceLog({
      dir,
      clock,
      collect: async () => collected,
      sampler: {
        latest: sample,
        sample: async () => {
          samples++
          return sample
        },
      },
    })
    expect(log.path).toBe(join(dir, RESOURCE_LOG_FILE))
    log.tick(sample)
    await vi.advanceTimersByTimeAsync(L.resourceLogIntervalMs - 1)
    log.tick(sample)
    await vi.advanceTimersByTimeAsync(0)
    expect(fs.readFileSync(log.path, 'utf8')).toBe('')
    await vi.advanceTimersByTimeAsync(1)
    log.tick(sample)
    await vi.advanceTimersByTimeAsync(0)
    log.tick(sample) // just written: the next is an hour away
    await vi.advanceTimersByTimeAsync(0)
    const fields = { reports: collected.reports, missing: { ptyhost: 'no answer' }, footprint: { t: '2026-10-07T12:00:00.000Z', pids: sample.pids, bytes: sample.bytes } }
    expect(lines(log.path)).toEqual([{ t: new Date(Date.now()).toISOString(), level: 'info', proc: 'main', msg: 'resources', trigger: 'hourly', ...fields }])
    expect(samples).toBe(0) // the hourly line uses the interval's own sample

    // the test hook's line: a fresh sample first
    const line = await log.write('test', { sample: true })
    expect(samples).toBe(1)
    expect(line).toEqual({ trigger: 'test', ...fields })
    expect(lines(log.path).map((l) => l.trigger)).toEqual(['hourly', 'test'])
    log.dispose()
  })

  it('U-MEM-20 · resources.ndjson rotates like every log: at most L.logFilesKept files, each within its size, newest line last', async () => {
    const dir = join(tmp, 'rotate')
    const one = Buffer.byteLength(`${JSON.stringify({ t: new Date().toISOString(), level: 'info', proc: 'main', msg: 'resources', trigger: 'test', reports: collected.reports, missing: {}, footprint: null })}\n`)
    const maxBytes = one * 2 + 1
    let n = 0
    const log = new ResourceLog({ dir, clock, maxBytes, collect: async (): Promise<Collected> => ({ reports: collected.reports, missing: n++ % 2 ? {} : { ptyhost: 'no answer' } }), sampler: { latest: null, sample: async () => null } })
    const total = L.logFilesKept * 2 + 3
    for (let i = 0; i < total; i++) await log.write('test')
    log.dispose()
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual([RESOURCE_LOG_FILE, ...Array.from({ length: L.logFilesKept - 1 }, (_, i) => `${RESOURCE_LOG_FILE}.${i + 1}`)].sort())
    for (const f of files) expect(fs.statSync(join(dir, f)).size).toBeLessThanOrEqual(maxBytes)
    expect(lines(join(dir, RESOURCE_LOG_FILE)).at(-1)).toMatchObject({ msg: 'resources', trigger: 'test', footprint: null, missing: (total - 1) % 2 ? {} : { ptyhost: 'no answer' } })
  })

  it('U-MEM-20 · the hourly line is written on the first interval an hour after the last line even when that interval’s footprint sample failed: `footprint: null`, never an older sample', async () => {
    const dir = join(tmp, 'failed-sample')
    let fail = false
    const sampler = new FootprintSampler({
      helper: '/h',
      pids: () => [{ name: 'main', pid: 1 }],
      log: createMemoryLogger(),
      clock,
      run: async () => (fail ? result('', 1) : result('1 100\n')),
      onInterval: (x) => log.tick(x),
    })
    const log = new ResourceLog({ dir, clock, collect: async () => collected, sampler })
    sampler.start()
    await vi.advanceTimersByTimeAsync(L.resourceLogIntervalMs - L.watchdogIntervalMs)
    expect(sampler.latest?.bytes).toEqual({ main: 100 }) // a good sample is there…
    fail = true // …but the interval that is due fails
    await vi.advanceTimersByTimeAsync(L.watchdogIntervalMs)
    expect(lines(log.path)).toEqual([{ t: new Date(Date.now()).toISOString(), level: 'info', proc: 'main', msg: 'resources', trigger: 'hourly', reports: collected.reports, missing: collected.missing, footprint: null }])
    fail = false
    await vi.advanceTimersByTimeAsync(L.resourceLogIntervalMs)
    expect(lines(log.path).map((l) => (l.footprint as { bytes: unknown } | null)?.bytes ?? null)).toEqual([null, { main: 100 }])
    sampler.dispose()
    log.dispose()
  })

  it('U-MEM-20 · lines with different triggers never merge: a test line asked for while the hourly one is written is its own line; a second ask of a trigger already waiting joins it', async () => {
    const dir = join(tmp, 'chain')
    let release: (() => void) | null = null
    let collects = 0
    const log = new ResourceLog({
      dir,
      clock,
      collect: async () => {
        collects++
        if (collects === 1) await new Promise<void>((r) => (release = r))
        return collected
      },
      sampler: { latest: sample, sample: async () => sample },
    })
    await vi.advanceTimersByTimeAsync(L.resourceLogIntervalMs)
    log.tick(sample) // the hourly line starts, its collection held
    await vi.advanceTimersByTimeAsync(0)
    const t1 = log.write('test', { sample: true })
    const t2 = log.write('test', { sample: true })
    expect(t2, 'a second test line while one waits joins it').toBe(t1)
    log.tick(sample) // the hourly one is being written: not due again
    ;(release as unknown as () => void)()
    expect((await t1).trigger).toBe('test')
    expect(lines(log.path).map((l) => l.trigger)).toEqual(['hourly', 'test'])
    expect(collects).toBe(2)
    log.dispose()
  })

  it('U-MEM-20 · a watchdog line holds its triggers, every process’s report and the sample they were found in; triggers that come while a watchdog line waits join it, none lost and no second line; no other line has `watchdog`', async () => {
    const dir = join(tmp, 'watchdog')
    let release: (() => void) | null = null
    let collects = 0
    const log = new ResourceLog({
      dir,
      clock,
      collect: async () => {
        collects++
        if (collects === 1) await new Promise<void>((r) => (release = r))
        return collected
      },
      sampler: { latest: null, sample: async () => null },
    })
    const core: WatchdogTrigger = { process: 'core', pid: 2, bytes: L.watchdogHardCoreBytes + 1, limit: 'hard', limitBytes: L.watchdogHardCoreBytes, action: 'restart' }
    const gpu: WatchdogTrigger = { process: 'gpu', pid: 5, bytes: L.watchdogSoftGpuBytes + 1, limit: 'soft', limitBytes: L.watchdogSoftGpuBytes, action: 'none' }
    const ptyhost: WatchdogTrigger = { process: 'ptyhost', pid: 3, bytes: L.watchdogHardPtyhostBytes + 1, limit: 'hard', limitBytes: L.watchdogHardPtyhostBytes, action: 'deferred', why: 'not idle' }
    const held = log.write('test') // being written: its collection is held
    await vi.advanceTimersByTimeAsync(0)
    const w1 = log.write('watchdog', { footprint: sample, watchdog: [core] })
    const w2 = log.write('watchdog', { footprint: null, watchdog: [gpu, ptyhost] })
    expect(w2, 'joins the watchdog line that waits').toBe(w1)
    ;(release as unknown as () => void)()
    expect((await held).watchdog).toBeUndefined()
    expect(await w1).toEqual({ trigger: 'watchdog', watchdog: [core, gpu, ptyhost], reports: collected.reports, missing: collected.missing, footprint: { t: '2026-10-07T12:00:00.000Z', pids: sample.pids, bytes: sample.bytes } })
    // once written, the next trigger is a line of its own
    await log.write('watchdog', { footprint: sample, watchdog: [gpu] })
    const written = lines(log.path)
    expect(written.map((l) => [l.trigger, l.watchdog])).toEqual([
      ['test', undefined],
      ['watchdog', [core, gpu, ptyhost]],
      ['watchdog', [gpu]],
    ])
    expect(Object.keys(written[1] as object)).toEqual(['t', 'level', 'proc', 'msg', 'trigger', 'watchdog', 'reports', 'missing', 'footprint'])
    log.dispose()
  })

  it('U-MEM-20 · a gauge that threw (NaN) is written as null: JSON has no NaN', async () => {
    const dir = join(tmp, 'nan')
    const log = new ResourceLog({ dir, clock, collect: async () => ({ reports: { renderer: { 'renderer.terminals': Number.NaN, 'renderer.commandHandlers': 3 }, ptyhost: { 'ptyhost.ptyQueues': { coalescerBytes: Number.NaN, snapshotWaiters: 0 } } }, missing: {} }), sampler: { latest: null, sample: async () => null } })
    const line = await log.write('test')
    expect(line.reports.renderer?.['renderer.terminals']).toBeNaN()
    expect(lines(log.path)[0]?.reports).toEqual({ renderer: { 'renderer.terminals': null, 'renderer.commandHandlers': 3 }, ptyhost: { 'ptyhost.ptyQueues': { coalescerBytes: null, snapshotWaiters: 0 } } })
    log.dispose()
  })
})
