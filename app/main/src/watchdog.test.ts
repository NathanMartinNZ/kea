import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@kea/kit'
import { L } from '@kea/protocol'
import type { FootprintSample, WatchdogTrigger } from './resources.ts'
import { limitKind, Watchdog, WATCHDOG_LIMITS, WatchdogPolicy, type LimitKind } from './watchdog.ts'

const IDLE: number = L.watchdogIdleMs
const COOL: number = L.watchdogCooldownMs
const STEP: number = L.watchdogIntervalMs
const KINDS: readonly LimitKind[] = ['core', 'ptyhost', 'renderer', 'gpu']

/** A sample: each process's `[pid, bytes]`; bytes null: the helper could not read it. */
function sample(procs: Record<string, [number, number | null]>): FootprintSample {
  const s: FootprintSample = { t: 0, pids: {}, bytes: {} }
  for (const [name, [pid, bytes]] of Object.entries(procs)) {
    s.pids[name] = pid
    if (bytes !== null) s.bytes[name] = bytes
    else (s.errors ??= {})[name] = 'no such process'
  }
  return s
}

/** Every promise continuation that is ready has run (the microtask queue is empty): no time passes. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

/** One process's triggers, as `limit:action` (and why), over a run of samples. */
const brief = (ts: readonly WatchdogTrigger[]): string[] => ts.map((t) => `${t.process} ${t.limit}:${t.action}${t.why ? ` (${t.why})` : ''}`)

describe('watchdog policy', () => {
  it('U-MEM-9 · a soft limit is one trigger per episode, never one per sample: an episode ends when the process is back at or under the limit, or replaced; each kind of process has its own limit, and main and Electron’s helpers have none', () => {
    for (const kind of KINDS) {
      const p = new WatchdogPolicy()
      const { soft } = WATCHDOG_LIMITS[kind]
      const at = (pid: number, bytes: number, i: number) => brief(p.evaluate(sample({ [kind]: [pid, bytes] }), 0, i * STEP))
      expect(at(7, soft, 0), `${kind}: at the limit is not over it`).toEqual([])
      expect(at(7, soft + 1, 1)).toEqual([`${kind} soft:none`])
      expect(at(7, soft + 2, 2), `${kind}: the same episode`).toEqual([])
      expect(at(7, soft * 1.2, 3)).toEqual([])
      expect(at(7, soft, 4), `${kind}: back under, the episode ends`).toEqual([])
      expect(at(7, soft + 1, 5), `${kind}: a new episode`).toEqual([`${kind} soft:none`])
      expect(at(8, soft + 1, 6), `${kind}: replaced while over: the new process's episode`).toEqual([`${kind} soft:none`])
      expect(at(8, soft + 1, 7)).toEqual([])
    }
    expect(KINDS.map((k) => [WATCHDOG_LIMITS[k].soft, WATCHDOG_LIMITS[k].hard])).toEqual([
      [L.watchdogSoftCoreBytes, L.watchdogHardCoreBytes],
      [L.watchdogSoftPtyhostBytes, L.watchdogHardPtyhostBytes],
      [L.watchdogSoftRendererBytes, L.watchdogHardRendererBytes],
      [L.watchdogSoftGpuBytes, L.watchdogHardGpuBytes],
    ])
    expect(['main', 'core', 'ptyhost', 'renderer', 'renderer:12', 'gpu', 'gpu:9', 'utility:network.mojom.NetworkService', 'zygote:7'].map(limitKind)).toEqual([null, 'core', 'ptyhost', 'renderer', 'renderer', 'gpu', null, null, null])
    const huge = L.watchdogHardGpuBytes * 4
    expect(new WatchdogPolicy().evaluate(sample({ main: [1, huge], 'utility:network.mojom.NetworkService': [2, huge] }), IDLE, 0)).toEqual([])
  })

  it('U-MEM-9 · a hard limit acts only when the person has been idle L.watchdogIdleMs: until then one `deferred` trigger says so, and the first idle sample takes the kind’s own action (restart, restart, reload, reset WebGL); over both limits at once is one trigger', () => {
    const actions: string[] = []
    for (const kind of KINDS) {
      const p = new WatchdogPolicy()
      const { hard, soft, action } = WATCHDOG_LIMITS[kind]
      const at = (bytes: number, idle: number, i: number) => p.evaluate(sample({ [kind]: [7, bytes] }), idle, i * STEP)
      expect(at(hard, IDLE, 0), `${kind}: at the hard limit is over the soft one only`).toEqual([{ process: kind, pid: 7, bytes: hard, limit: 'soft', limitBytes: soft, action: 'none' }])
      expect(at(hard + 1, IDLE - 1, 1)).toEqual([{ process: kind, pid: 7, bytes: hard + 1, limit: 'hard', limitBytes: hard, action: 'deferred', why: 'not idle' }])
      expect(at(hard + 1, 0, 2), `${kind}: still not idle, said once`).toEqual([])
      expect(at(hard + 5, IDLE, 3)).toEqual([{ process: kind, pid: 7, bytes: hard + 5, limit: 'hard', limitBytes: hard, action }])
      actions.push(action)
      // from under the soft limit straight past the hard one, idle: the action's trigger alone
      const q = new WatchdogPolicy()
      expect(brief(q.evaluate(sample({ [kind]: [3, hard + 1] }), IDLE, 0))).toEqual([`${kind} hard:${action}`])
      // and not idle: the deferred one alone, which also stands for the soft episode
      const w = new WatchdogPolicy()
      expect(brief(w.evaluate(sample({ [kind]: [3, hard + 1] }), 0, 0))).toEqual([`${kind} hard:deferred (not idle)`])
      expect(brief(w.evaluate(sample({ [kind]: [3, soft + 1] }), 0, STEP)), `${kind}: under the hard limit again, the soft episode goes on`).toEqual([])
    }
    expect(actions).toEqual(['restart', 'restart', 'reload', 'resetWebgl'])
  })

  it('U-MEM-9 · never twice within L.watchdogCooldownMs for one process, and the cool-down follows the role, not the pid: a restarted core that passes the limit again waits it out (said once), then is restarted again, each time while idle; another process’s cool-down is its own', () => {
    const p = new WatchdogPolicy()
    const hard = L.watchdogHardCoreBytes
    const core = (pid: number, bytes: number, now: number, idle = IDLE) => brief(p.evaluate(sample({ core: [pid, bytes], ptyhost: [50, 1] }), idle, now))
    expect(core(7, hard + 1, 0)).toEqual(['core hard:restart'])
    p.settled('core')
    // the new core (another pid) is over the limit at once
    expect(core(8, hard + 1, STEP)).toEqual(['core hard:deferred (cool-down)'])
    expect(core(8, hard + 1, 2 * STEP)).toEqual([])
    expect(core(8, hard + 1, COOL - 1)).toEqual([])
    expect(core(8, hard + 1, COOL, IDLE - 1), 'the cool-down is over, but the person is back').toEqual([])
    expect(core(8, hard + 1, COOL + STEP)).toEqual(['core hard:restart'])
    p.settled('core')
    expect(core(9, hard + 1, COOL + 2 * STEP)).toEqual(['core hard:deferred (cool-down)'])
    // ptyhost has not acted: its own first action needs no wait
    expect(brief(p.evaluate(sample({ core: [9, 1], ptyhost: [50, L.watchdogHardPtyhostBytes + 1] }), IDLE, COOL + 3 * STEP))).toEqual(['ptyhost hard:restart'])
  })

  it('U-MEM-9 · never while an earlier action for that process is still under way, however long it takes: the next episode waits for it (said once) and acts once it is over', () => {
    const p = new WatchdogPolicy()
    const hard = L.watchdogHardPtyhostBytes
    const at = (pid: number, now: number) => brief(p.evaluate(sample({ ptyhost: [pid, hard + 1] }), IDLE, now))
    expect(at(7, 0)).toEqual(['ptyhost hard:restart'])
    // the restart never reported back; the cool-down has long passed
    expect(at(8, COOL * 2)).toEqual(['ptyhost hard:deferred (action under way)'])
    expect(at(8, COOL * 3)).toEqual([])
    p.settled('ptyhost')
    expect(at(8, COOL * 3 + STEP)).toEqual(['ptyhost hard:restart'])
  })

  it('U-MEM-9 · a failed sample acts on nothing and ends no episode; a process the helper could not read keeps its state; a clock that jumps (the Mac slept) triggers nothing by itself', () => {
    const p = new WatchdogPolicy()
    const { soft, hard } = WATCHDOG_LIMITS.renderer
    expect(brief(p.evaluate(sample({ renderer: [7, soft + 1] }), IDLE, 0))).toEqual(['renderer soft:none'])
    expect(p.evaluate(null, IDLE, STEP)).toEqual([])
    expect(p.evaluate(sample({ renderer: [7, null] }), IDLE, 2 * STEP), 'not read: nothing known').toEqual([])
    expect(p.evaluate(sample({ renderer: [7, soft + 1] }), IDLE, 3 * STEP), 'the episode was never ended').toEqual([])
    // hard, not idle; then failed samples while idle: no action without a sample that shows it
    expect(brief(p.evaluate(sample({ renderer: [7, hard + 1] }), 0, 4 * STEP))).toEqual(['renderer hard:deferred (not idle)'])
    expect(p.evaluate(null, IDLE * 10, 5 * STEP)).toEqual([])
    expect(p.evaluate(sample({ renderer: [7, null] }), IDLE * 10, 6 * STEP)).toEqual([])
    // a sleep longer than every limit of time, nothing over a limit: nothing
    const q = new WatchdogPolicy()
    expect(q.evaluate(sample({ core: [1, 1], ptyhost: [2, 1], renderer: [3, 1], gpu: [4, 1] }), IDLE, 0)).toEqual([])
    expect(q.evaluate(sample({ core: [1, 1], ptyhost: [2, 1], renderer: [3, 1], gpu: [4, 1] }), COOL * 100, COOL * 100)).toEqual([])
  })

  it('U-MEM-9 · an action that did not replace the process and did not bring it back under the limit is not repeated: once its cool-down is over the watchdog says it gave up, once, and leaves the process alone until it is back under the limit or replaced', () => {
    const p = new WatchdogPolicy()
    const hard = L.watchdogHardGpuBytes
    const gpu = (pid: number, bytes: number, now: number) => brief(p.evaluate(sample({ gpu: [pid, bytes] }), IDLE, now))
    expect(gpu(4, hard + 1, 0)).toEqual(['gpu hard:resetWebgl'])
    p.settled('gpu')
    expect(gpu(4, hard + 1, STEP), 'the same process, inside the cool-down').toEqual([])
    expect(gpu(4, hard + 1, COOL - 1)).toEqual([])
    expect(gpu(4, hard + 1, COOL)).toEqual(['gpu hard:gaveUp'])
    expect(gpu(4, hard + 9, COOL * 5), 'said once').toEqual([])
    // back under the hard limit (still over the soft one: that episode never ended), then over again: a new episode
    expect(gpu(4, hard, COOL * 5 + STEP)).toEqual([])
    expect(gpu(4, hard + 1, COOL * 5 + 2 * STEP)).toEqual(['gpu hard:resetWebgl'])
    p.settled('gpu')
    // replaced (Chromium restarted its GPU process) and over again: the cool-down holds, then it acts
    expect(gpu(5, hard + 1, COOL * 5 + 3 * STEP)).toEqual(['gpu hard:deferred (cool-down)'])
    expect(gpu(5, hard + 1, COOL * 6 + 2 * STEP)).toEqual(['gpu hard:resetWebgl'])
    // a reload keeps the window's renderer process: the same rule
    const q = new WatchdogPolicy()
    const r = (now: number) => brief(q.evaluate(sample({ renderer: [9, L.watchdogHardRendererBytes + 1] }), IDLE, now))
    expect(r(0)).toEqual(['renderer hard:reload'])
    expect(r(COOL), 'its reload is still under way').toEqual([])
    q.settled('renderer')
    expect(r(COOL + STEP)).toEqual(['renderer hard:gaveUp'])
  })

  it('U-MEM-9 · a window’s renderer is followed by its window, not by its place in the sample: when the first window closes and the next takes its name there, that window keeps its own episodes and cool-down, so one that was reloaded and is still over the limit is not reloaded again', async () => {
    const over = L.watchdogHardRendererBytes + 1
    // what main says of a sampled process: a renderer's role is its window (here: pid 100 is window 1, pid 700 window 7)
    const windows: Record<number, number> = { 100: 1, 700: 7 }
    const role = (name: string, pid: number): string => (pid in windows ? `window ${windows[pid]}` : name)
    const p = new WatchdogPolicy()
    const at = (procs: Record<string, [number, number | null]>, now: number) => brief(p.evaluate(sample(procs), IDLE, now, role))
    expect(at({ renderer: [100, 1], 'renderer:7': [700, over] }, 0)).toEqual(['renderer:7 hard:reload'])
    p.settled('window 7')
    expect(at({ renderer: [100, 1], 'renderer:7': [700, over] }, COOL), 'the reload kept its process, still over: given up, once').toEqual(['renderer:7 hard:gaveUp'])
    // the first window closes: the sample calls the second one `renderer` from now on
    expect(at({ renderer: [700, over] }, COOL + STEP), 'the same window under another name: left alone').toEqual([])
    expect(at({ renderer: [700, over] }, COOL * 3)).toEqual([])
    expect(p.size, 'window 1 is forgotten, window 7 remembered once').toBe(1)
    // back under the limit, then over again: a new episode of that window, which acts
    expect(at({ renderer: [700, L.watchdogSoftRendererBytes] }, COOL * 3 + STEP)).toEqual([])
    expect(at({ renderer: [700, over] }, COOL * 3 + 2 * STEP)).toEqual(['renderer hard:reload'])
    // and its cool-down is the window's too: a second window opened first in the sample does not hide it
    p.settled('window 7')
    windows[900] = 9
    expect(at({ renderer: [900, 1], 'renderer:7': [700, 1] }, COOL * 3 + 3 * STEP)).toEqual([])
    expect(at({ renderer: [900, over], 'renderer:7': [700, 1] }, COOL * 3 + 4 * STEP), 'window 9 never acted on: no cool-down of its own').toEqual(['renderer hard:reload'])

    // at work: the action's end is told to the role it was decided for
    let now = 0
    const acted: string[] = []
    const w = new Watchdog({ log: createMemoryLogger({ process: 'main' }), clock: { now: () => now }, idleMs: () => IDLE, line: async () => undefined, act: async (t) => void acted.push(t.process), role })
    await w.tick(sample({ renderer: [100, 1], 'renderer:7': [700, over] })).done
    expect(acted).toEqual(['renderer:7'])
    expect(w.counts(), 'the reload is over: nothing under way').toEqual({ acting: 0, cooling: 1 })
    now = COOL
    expect(brief(w.tick(sample({ renderer: [700, over] })).triggers), 'window 7, now first in the sample: given up, not reloaded again').toEqual(['renderer hard:gaveUp'])
    await settle()
    expect(acted).toEqual(['renderer:7'])
  })

  it('U-MEM-9 · what the policy remembers is one entry per limited process of the newest sample: a window that closes is forgotten at once, or when its cool-down and its action are over; 1 000 windows coming and going leave nothing', () => {
    const p = new WatchdogPolicy()
    const base = { core: [1, 1], ptyhost: [2, 1], gpu: [3, 1], main: [4, 1] } as Record<string, [number, number]>
    p.evaluate(sample(base), 0, 0)
    expect(p.size).toBe(3)
    const over = L.watchdogHardRendererBytes + 1
    for (let i = 0; i < 1000; i++) {
      p.evaluate(sample({ ...base, renderer: [100 + i, over], [`renderer:${i}`]: [5000 + i, L.watchdogSoftRendererBytes + 1] }), 0, i * STEP)
      expect(p.size).toBe(5)
      p.evaluate(sample(base), 0, i * STEP)
      expect(p.size).toBe(3)
    }
    // a window reloaded by the watchdog, then closed: remembered while its action is under way and its cool-down runs
    const t0 = 2000 * STEP
    expect(brief(p.evaluate(sample({ ...base, 'renderer:77': [9, over] }), IDLE, t0))).toEqual(['renderer:77 hard:reload'])
    p.evaluate(sample(base), IDLE, t0 + STEP)
    expect(p.size).toBe(4)
    // reopened under the same name inside the cool-down: no second reload yet
    expect(brief(p.evaluate(sample({ ...base, 'renderer:77': [10, over] }), IDLE, t0 + 2 * STEP))).toEqual(['renderer:77 hard:deferred (action under way)'])
    p.settled('renderer:77')
    p.evaluate(sample(base), IDLE, t0 + COOL - 1)
    expect(p.size).toBe(4)
    p.evaluate(sample(base), IDLE, t0 + COOL)
    expect(p.size).toBe(3)
  })
})

describe('watchdog at work', () => {
  function harness(o: { idle?: () => number; act?: (t: WatchdogTrigger) => Promise<void> } = {}) {
    const log = createMemoryLogger({ process: 'main' })
    const order: string[] = []
    const lines: { triggers: WatchdogTrigger[]; sample: FootprintSample }[] = []
    let now = 0
    let releaseLine: (() => void) | null = null
    const gate = { hold: false }
    const w = new Watchdog({
      log,
      clock: { now: () => now },
      idleMs: o.idle ?? (() => IDLE),
      line: async (triggers, s) => {
        order.push('line:start')
        if (gate.hold) await new Promise<void>((r) => (releaseLine = r))
        lines.push({ triggers: [...triggers], sample: s })
        order.push('line:written')
      },
      act: async (t) => {
        order.push(`act:${t.process}:${t.action}`)
        await o.act?.(t)
      },
    })
    return { w, log, order, lines, gate, advance: (ms: number) => (now += ms), release: () => (releaseLine as unknown as () => void)() }
  }
  /** The error-level entries, without the logger's own `t`, `level` and `proc`. */
  const errors = (log: ReturnType<typeof createMemoryLogger>) => log.entries.filter((e) => e.level === 'error').map(({ t: _t, level: _l, proc: _p, ...rest }) => rest)

  it('U-MEM-9 · every trigger is logged at error level with the process, the limit and the action, and the interval’s triggers go into one line with its sample; the line is written before an action starts, since the action replaces the process the reports describe', async () => {
    const h = harness()
    h.gate.hold = true
    const s = sample({ core: [7, L.watchdogHardCoreBytes + 1], ptyhost: [8, L.watchdogSoftPtyhostBytes + 1], renderer: [9, 1], gpu: [10, 1], main: [1, 1] })
    const tick = h.w.tick(s)
    const want: WatchdogTrigger[] = [
      { process: 'core', pid: 7, bytes: L.watchdogHardCoreBytes + 1, limit: 'hard', limitBytes: L.watchdogHardCoreBytes, action: 'restart' },
      { process: 'ptyhost', pid: 8, bytes: L.watchdogSoftPtyhostBytes + 1, limit: 'soft', limitBytes: L.watchdogSoftPtyhostBytes, action: 'none' },
    ]
    expect(tick.triggers).toEqual(want)
    expect(errors(h.log)).toEqual(want.map((t) => ({ msg: 'watchdog: limit exceeded', ...t })))
    await settle()
    expect(h.order, 'no action while the line is being collected').toEqual(['line:start'])
    h.release()
    await tick.done
    expect(h.order).toEqual(['line:start', 'line:written', 'act:core:restart'])
    expect(h.lines).toEqual([{ triggers: want, sample: s }])
    expect(h.log.entries.at(-1)).toMatchObject({ level: 'info', msg: 'watchdog: action finished', process: 'core', action: 'restart', ms: 0 })
    // nothing over a limit, or no sample: nothing logged, no line
    const before = h.log.entries.length
    expect(h.w.tick(sample({ core: [11, 1], ptyhost: [8, L.watchdogSoftPtyhostBytes + 1] })).triggers).toEqual([])
    expect(h.w.tick(null).triggers).toEqual([])
    expect(h.log.entries.length).toBe(before)
    expect(h.lines).toHaveLength(1)
    // row `main.watchdog`: core's action is over and its cool-down runs; it is over L.watchdogCooldownMs later
    expect(h.w.counts()).toEqual({ acting: 0, cooling: 1 })
    h.advance(COOL)
    expect(h.w.counts()).toEqual({ acting: 0, cooling: 0 })
  })

  it('U-MEM-9 · an action is under way until it reports back, done or failed (a failure is logged and still ends it); an idle source that throws counts as not idle; a line that cannot be written does not stop the action', async () => {
    let fail: (() => void) | null = null
    const h = harness({ act: () => new Promise<void>((_, reject) => (fail = () => reject(new Error('no such window')))) })
    const over = (pid: number) => sample({ renderer: [pid, L.watchdogHardRendererBytes + 1] })
    const first = h.w.tick(over(7))
    expect(brief(first.triggers)).toEqual(['renderer hard:reload'])
    await settle()
    expect(h.order).toEqual(['line:start', 'line:written', 'act:renderer:reload'])
    expect(h.w.counts()).toEqual({ acting: 1, cooling: 1 })
    h.advance(COOL)
    expect(h.w.counts()).toEqual({ acting: 1, cooling: 0 })
    // under way: another renderer under that name (the window was reopened) is not acted on
    expect(brief(h.w.tick(over(8)).triggers)).toEqual(['renderer hard:deferred (action under way)'])
    ;(fail as unknown as () => void)()
    await first.done
    expect(errors(h.log).at(-1)).toEqual({ msg: 'watchdog: action failed', process: 'renderer', action: 'reload', error: 'Error: no such window' })
    h.advance(STEP)
    expect(brief(h.w.tick(over(8)).triggers), 'over, so the next one may act').toEqual(['renderer hard:reload'])

    const throwing = harness({
      idle: () => {
        throw new Error('no power monitor')
      },
    })
    expect(brief(throwing.w.tick(sample({ core: [7, L.watchdogHardCoreBytes + 1] })).triggers)).toEqual(['core hard:deferred (not idle)'])
    expect(throwing.log.entries.some((e) => e.level === 'warn' && e.msg === 'watchdog: idle time not read')).toBe(true)

    const log = createMemoryLogger({ process: 'main' })
    const acted: string[] = []
    const w = new Watchdog({
      log,
      idleMs: () => IDLE,
      line: () => Promise.reject(new Error('disk full')),
      act: async (t) => void acted.push(t.process),
    })
    await w.tick(sample({ gpu: [4, L.watchdogHardGpuBytes + 1] })).done
    expect(acted).toEqual(['gpu'])
    expect(log.entries.some((e) => e.level === 'warn' && e.msg === 'watchdog: line not written')).toBe(true)
  })
})
