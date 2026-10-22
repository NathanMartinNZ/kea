// Sleep, wake and clock jumps for status: the parts the sleep test in app-resources.test.ts cannot check, since it
// stops every process and both clocks move together. A sleep moves the wall clock while the monotonic clocks do not
// (the one that stamps hook envelopes, CLOCK_UPTIME_RAW on macOS and CLOCK_MONOTONIC on Linux, and the event loop's
// timers), and NTP or the person can move the wall clock at any time; neither may decide a notification or fire a
// timeout. That part drives the status engine, core's notification policy and main's notifier in-process
// (tests/support/status.ts) with both clocks in the test's hands; the glyph-atlas part wakes the real app
// (tests/support/app.ts). These run only with `pnpm chaos`.

import { L, type AgentEvent, type NotificationOp, type SessionView } from '@kea/protocol'
import { NotificationPolicy } from '@kea/core/src/status/policy.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notifier, RecordingSurfaces } from '../../app/main/src/notifier.ts'
import { KeaRun, until } from '../support/app.ts'
import { engineUnderTest } from '../support/status.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const c of cleanup.splice(0).reverse()) await c()
})

const T0 = 1_790_000_000_000
const HOUR = 3_600_000

describe('sleep and clock jumps', () => {
  it('C-RES-12 · a sleep during an agent turn and wall-clock jumps with no monotonic gap: no notification the turn did not earn, no timeout fired by the jump (the dwell, a notification’s time-to-live), a usage limit that reset during the sleep posts N5 within L.conditionCheckMs of waking; the glyph atlas is refreshed on wake', async () => {
    vi.useFakeTimers({ now: T0 })
    let monoNs = 5_000_000_000n
    const monoMs = () => Number(monoNs / 1_000_000n)
    const u = engineUnderTest({ sessions: 5, mono: () => monoNs })
    cleanup.push(() => u.dispose())
    for (const [i, id] of u.ids.entries()) u.sessions.set(id, { ...u.sessions.get(id)!, title: `S${i}`, attention: [], phase: 'idle', unread: false, failureKind: null, lastActivityAt: 0 } as SessionView)
    const ops: NotificationOp[] = []
    const rec = new RecordingSurfaces()
    const notifier = new Notifier({ native: rec, onClick: () => undefined, mono: monoMs })
    cleanup.push(() => notifier.dispose())
    const policy = new NotificationPolicy({
      notices: (cb) => u.engine.notices.event(cb),
      sessions: u.sessions,
      conditions: u.engine.conditions.store,
      projectName: () => 'demo',
      agentName: () => 'Fake',
      settings: () => ({ needsYou: true, finished: true, failed: true, sound: false, onlyWhenUnfocused: true }),
      viewing: () => u.engine.viewingId,
      mono: monoMs,
      out: (op) => {
        ops.push(op)
        notifier.apply(op)
      },
    })
    cleanup.push(() => policy.dispose())
    const hook = (id: string, ...events: AgentEvent[]) => expect(u.engine.ingest({ sessionId: id, source: 'hook', events, mono: monoNs, at: Date.now() }), `${id} is live`).toBe(true)
    /** Time passes on both clocks. */
    const run = (ms: number) => {
      monoNs += BigInt(ms) * 1_000_000n
      vi.advanceTimersByTime(ms)
    }
    /** The wall clock alone moves (a sleep, NTP, the person): no timer runs, the monotonic clocks stay. */
    const jump = (ms: number) => vi.setSystemTime(Date.now() + ms)
    const posts = (from: number) => ops.slice(from).filter((o): o is Extract<NotificationOp, { op: 'post' }> => o.op === 'post')
    const [a, b, c, d, e] = u.ids as [string, string, string, string, string]
    // `a` runs another agent (respawned as one): its turn finishing does not end the others' condition
    for (const lifecycle of ['detached', 'live'] as const) u.sessions.set(a, { ...u.sessions.get(a)!, agent: 'other', lifecycle })

    // ── a sleep during a turn ──
    run(1_000)
    hook(a, { t: 'turn.started' }, { t: 'tool.started', name: 'Bash', summary: 'npm test' })
    // two sessions hit the usage limit; it resets half an hour later, while the machine sleeps
    const resetsAt = Date.now() + HOUR / 2
    for (const id of [b, c]) hook(id, { t: 'turn.started' }, { t: 'turn.failed', error: 'usage limit reached', kind: 'rate_limit', resetsAt })
    expect(posts(0).map((p) => [p.tag, p.body])).toEqual([
      ['c:fake', expect.stringMatching(/^1 session waiting/)],
      ['c:fake', expect.stringMatching(/^2 sessions waiting/)],
    ])
    const slept = ops.length
    jump(2 * HOUR)
    expect(ops.length, 'nothing on the sleep itself').toBe(slept)
    // awake: the turn goes on and finishes 3 s after it started by the monotonic clock (2 h by the wall)
    run(2_000)
    hook(a, { t: 'tool.finished', name: 'Bash', summary: 'npm test', ok: true }, { t: 'turn.finished', backgroundWork: false, lastMessage: 'All tests pass.' })
    expect(posts(slept).filter((p) => p.tag === `s:${a}`), 'a 3 s turn earns no N2: it is shorter than L.notifyMinTurnMs').toEqual([])
    // the reset passed during the sleep: N5, within L.conditionCheckMs of waking
    run(L.conditionCheckMs - 2_000)
    expect(posts(slept).map((p) => [p.tag, p.title, p.body])).toEqual([['c:fake', 'Fake · limit reset', '2 sessions waiting']])
    expect([...u.engine.conditions.store.values()].map((x) => x.state)).toEqual(['reset'])

    // ── the wall clock jumps, the monotonic clock does not ──
    const jumped = ops.length
    hook(d, { t: 'turn.started' }, { t: 'attention.permission', key: 'Bash: npm test', tool: 'Bash', summary: 'npm test' })
    // (a turn of the agent finishing ends its condition, so N5 is withdrawn)
    hook(e, { t: 'turn.started' }, { t: 'turn.finished', backgroundWork: false })
    expect(u.engine.state(e)!.unread).toBe(true)
    u.engine.setViewing(e)
    expect(posts(jumped).map((p) => p.tag), 'only the permission request').toEqual([`s:${d}`])
    expect(ops.slice(jumped).filter((o) => o.op === 'withdraw')).toEqual([{ op: 'withdraw', tag: 'c:fake' }])
    const quiet = ops.length
    // forward past the time-to-live, then back past where it was
    jump(3 * HOUR)
    jump(-6 * HOUR)
    expect(u.engine.state(e)!.unread, 'the dwell did not fire on the jump').toBe(true)
    expect([policy.liveTags(), notifier.liveTags()].map((t) => t.includes(`s:${d}`)), 'nothing expired on the jump').toEqual([true, true])
    expect(ops.length, 'and nothing was posted or withdrawn').toBe(quiet)
    run(L.viewedDwellMs)
    expect(u.engine.state(e)!.unread, 'read after the dwell, by the monotonic clock').toBe(false)
    // the time-to-live runs on the monotonic clock: L.notificationTtlMs after the post, not before
    run(L.notificationTtlMs - L.viewedDwellMs - 1)
    expect([policy.liveTags(), notifier.liveTags()].map((t) => t.includes(`s:${d}`))).toEqual([true, true])
    run(1)
    expect([policy.liveTags(), notifier.liveTags()].map((t) => t.includes(`s:${d}`)), 'expired').toEqual([false, false])
    expect(posts(jumped).map((p) => p.tag), 'nothing more posted').toEqual([`s:${d}`])

    // ── the wake reaches the window: every WebGL view's glyph atlas is cleared and rebuilt ──
    vi.useRealTimers()
    const app = KeaRun.create()
    cleanup.push(() => app.dispose())
    const kea = await app.launch()
    const gl = (await kea.views()).filter((v) => v.webgl)
    expect(gl.length, 'a WebGL terminal view').toBeGreaterThan(0)
    const before = new Map(gl.map((v) => [v.ptyId, v.atlas.clears.wake ?? 0]))
    // the system tells main through powerMonitor; the test sends main's
    await kea.app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
    await until('every WebGL view’s atlas cleared for the wake', async () => {
      const now = (await kea.views()).filter((v) => before.has(v.ptyId))
      return now.length === before.size && now.every((v) => (v.atlas.clears.wake ?? 0) > before.get(v.ptyId)!) ? true : undefined
    })
    await kea.echo('cres12')
    await kea.assertUnfocused()
  }, 120_000)
})
