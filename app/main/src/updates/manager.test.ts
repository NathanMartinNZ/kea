// Main's update state: what a check finds, when an automatic one runs (wall clock, resume, the one-time line, core's
// switch, the default home), the macOS updater's events, whether a version Squirrel had ready installed, and the
// restarts it offers with the drafts kept first.
import { L, NO_UPDATE_MARKS, type UpdateMarks, type UpdateState } from '@kea/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { UpdaterDriver, UpdaterEvents } from './driver.ts'
import type { UpdateHow } from './how.ts'
import { UpdateManager, type ManagerDeps } from './manager.ts'

const BY_COMMAND: UpdateHow = { mode: 'command', auto: true, command: 'curl … | sh', why: null }
const BY_UPDATER: UpdateHow = { mode: 'updater', auto: true, command: 'curl … | sh', why: null }

/** A clock whose time and timers the test moves. */
function fakeClock(start = 1_000_000) {
  let now = start
  let next = 1
  const timers = new Map<number, { at: number; every: number | null; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => (timers.set(next, { at: now + ms, every: null, fn }), next++),
    clearTimeout: (t: unknown) => void timers.delete(t as number),
    setInterval: (fn: () => void, ms: number) => (timers.set(next, { at: now + ms, every: ms, fn }), next++),
    clearInterval: (t: unknown) => void timers.delete(t as number),
    get count() {
      return timers.size
    },
    /** Move the clock by `ms`, firing what comes due in order. */
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, t] = due
        now = t.at
        if (t.every === null) timers.delete(id)
        else t.at += t.every
        t.fn()
      }
      now = end
    },
    /** The system slept: the wall clock moved, no timer fired. */
    sleep(ms: number) {
      now += ms
      for (const t of timers.values()) t.at += ms
    },
  }
}

function make(o: Partial<ManagerDeps> & { marks0?: UpdateMarks; offered?: () => Promise<string | null> } = {}) {
  const clock = fakeClock()
  const states: UpdateState[] = []
  let saved: UpdateMarks = o.marks0 ?? NO_UPDATE_MARKS
  const feed = vi.fn(o.offered ?? (() => Promise.resolve('1.0.3')))
  const relaunch = vi.fn()
  const order: string[] = []
  const m = new UpdateManager({
    version: '1.0.2',
    how: BY_COMMAND,
    autoAllowed: true,
    clock,
    marks: { load: () => saved, save: (x) => void (saved = x) },
    feed,
    makeDriver: null,
    changed: (s) => states.push(s),
    beforeRestart: () => (order.push('drafts'), Promise.resolve()),
    relaunch: () => (order.push('relaunch'), relaunch()),
    log: { info: () => undefined, warn: () => undefined },
    ...o,
  })
  return { m, clock, states, feed, relaunch, order, marks: () => saved }
}

const flush = () => new Promise((r) => setImmediate(r))

/** A ready window, core's switch on, the line seen: every gate open. */
function open(m: UpdateManager) {
  m.coreSetting(true)
  m.windowLoaded()
  m.noticeShown()
}

describe('the update check', () => {
  it('U-DST-1 · a check finds a newer version, the newest, or fails with one line; Check for Updates… always runs one, a click during one joins it', async () => {
    const { m, feed } = make()
    m.checkNow()
    m.checkNow()
    expect(m.state.phase).toEqual({ k: 'checking' })
    await flush()
    expect(feed).toHaveBeenCalledTimes(1)
    expect(m.state.phase).toEqual({ k: 'available', version: '1.0.3' })
    expect(m.state.lastChecked).toBe(1_000_000)

    const same = make({ offered: () => Promise.resolve('1.0.2') })
    same.m.checkNow()
    await flush()
    expect(same.m.state.phase).toEqual({ k: 'current', version: '1.0.2' })

    const none = make({ offered: () => Promise.resolve(null) })
    none.m.checkNow()
    await flush()
    expect(none.m.state.phase, 'a release without this system’s file offers nothing').toEqual({ k: 'current', version: '1.0.2' })

    const bad = make({ offered: () => Promise.reject(new Error('GitHub answered 503\nmore')) })
    bad.m.checkNow()
    await flush()
    expect(bad.m.state.phase).toEqual({ k: 'failed', reason: 'GitHub answered 503' })
  })

  it('U-DST-2 · a build not from a release never checks, not even when asked; its state says so', async () => {
    const { m, feed } = make({ how: { mode: 'none', auto: false, command: null, why: null } })
    open(m)
    m.checkNow()
    await flush()
    expect(feed).not.toHaveBeenCalled()
    expect(m.state).toMatchObject({ mode: 'none', auto: false, notice: false, phase: { k: 'idle' } })
  })
})

describe('automatic checks', () => {
  it('U-DST-3 · the first runs L.updateCheckDelayMs after the window first loads, then again once L.updateCheckIntervalMs has passed since the last attempt, tested every L.updateTickMs', async () => {
    const { m, clock, feed } = make()
    open(m)
    clock.advance(L.updateCheckDelayMs - 1)
    expect(feed).not.toHaveBeenCalled()
    clock.advance(1)
    await flush()
    expect(feed).toHaveBeenCalledTimes(1)
    clock.advance(L.updateCheckIntervalMs - 1)
    await flush()
    expect(feed, 'not yet due at any tick').toHaveBeenCalledTimes(1)
    // due now: the next tick runs it
    clock.advance(L.updateTickMs)
    await flush()
    expect(feed).toHaveBeenCalledTimes(2)
  })

  it('U-DST-4 · each gate holds it back: core has not said its switch in this run, the switch is off, the line was never seen, the window never loaded, another home', async () => {
    for (const [why, setup] of [
      ['no word from core', (m: UpdateManager) => (m.windowLoaded(), m.noticeShown())],
      ['the switch off', (m: UpdateManager) => (m.coreSetting(false), m.windowLoaded(), m.noticeShown())],
      ['the line never seen', (m: UpdateManager) => (m.coreSetting(true), m.windowLoaded())],
      ['no window yet', (m: UpdateManager) => (m.coreSetting(true), m.noticeShown())],
    ] as const) {
      const { m, clock, feed } = make()
      setup(m)
      clock.advance(L.updateCheckIntervalMs * 2)
      await flush()
      expect(feed, why).not.toHaveBeenCalled()
      expect(clock.count, `${why}: no timer held`).toBe(0)
    }
    const other = make({ autoAllowed: false })
    open(other.m)
    other.clock.advance(L.updateCheckIntervalMs * 2)
    await flush()
    expect(other.feed, 'another home').not.toHaveBeenCalled()
    expect(other.m.state.notice, 'another home shows no line').toBe(false)

    const pkg = make({ how: { mode: 'packageManager', auto: false, command: 'sudo apt …', why: null } })
    open(pkg.m)
    pkg.clock.advance(L.updateCheckIntervalMs * 2)
    await flush()
    expect(pkg.feed, 'the system updates it').not.toHaveBeenCalled()
    pkg.m.checkNow()
    await flush()
    expect(pkg.feed, 'a click still checks').toHaveBeenCalledTimes(1)
  })

  it('U-DST-5 · the switch turned off clears the timers and none runs; turned on again, they come back', async () => {
    const { m, clock, feed } = make()
    open(m)
    expect(clock.count).toBe(2)
    m.coreSetting(false)
    expect(clock.count).toBe(0)
    clock.advance(L.updateCheckDelayMs * 2)
    await flush()
    expect(feed).not.toHaveBeenCalled()
    m.coreSetting(true)
    clock.advance(0)
    await flush()
    expect(feed, 'due at once: the delay has long passed').toHaveBeenCalledTimes(1)
  })

  it('U-DST-6 · after sleep a due check runs at resume, and a failed automatic check runs again at the next resume', async () => {
    let fail = true
    const { m, clock, feed } = make({ offered: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve('1.0.2')) })
    open(m)
    clock.advance(L.updateCheckDelayMs)
    await flush()
    expect(m.state.phase.k).toBe('failed')
    fail = false
    m.resume()
    await flush()
    expect(feed).toHaveBeenCalledTimes(2)
    expect(m.state.phase.k).toBe('current')
    m.resume()
    await flush()
    expect(feed, 'nothing due, nothing failed').toHaveBeenCalledTimes(2)
    clock.sleep(L.updateCheckIntervalMs)
    m.resume()
    await flush()
    expect(feed, 'came due while asleep').toHaveBeenCalledTimes(3)
  })

  it('U-DST-7 · the one-time line is due where Kea checks by itself until it is seen; seeing it is kept and starts the schedule', () => {
    const { m, marks, states } = make()
    expect(m.state.notice).toBe(true)
    m.coreSetting(true)
    m.windowLoaded()
    m.noticeShown()
    expect(marks().noticeShown).toBe(true)
    expect(states.at(-1)?.notice).toBe(false)
    const again = make({ marks0: { ...NO_UPDATE_MARKS, noticeShown: true } })
    expect(again.m.state.notice).toBe(false)
  })
})

/** A driver the test answers for. */
function fakeDriver() {
  let on: UpdaterEvents | null = null
  const d = { check: vi.fn(), download: vi.fn(), install: vi.fn(), dispose: vi.fn() } satisfies UpdaterDriver
  return { make: (events: UpdaterEvents) => ((on = events), d), d, on: () => on as UpdaterEvents }
}

describe('the macOS updater', () => {
  it('U-DST-8 · a newer version downloads at once, its progress shows, and Squirrel’s ready offers Restart to Update, which keeps the drafts and then installs', async () => {
    const f = fakeDriver()
    const { m, marks, order } = make({ how: BY_UPDATER, makeDriver: f.make })
    m.checkNow()
    expect(f.d.check).toHaveBeenCalledTimes(1)
    f.on().available('1.0.3')
    expect(f.d.download).toHaveBeenCalledTimes(1)
    expect(m.state.phase).toEqual({ k: 'downloading', version: '1.0.3', percent: 0 })
    f.on().progress('1.0.3', 40)
    expect(m.state.phase).toEqual({ k: 'downloading', version: '1.0.3', percent: 40 })
    f.on().ready('1.0.3')
    expect(m.state.phase).toEqual({ k: 'ready', version: '1.0.3' })
    expect(m.title).toBe('Restart to Update')
    expect(marks().expected).toEqual({ version: '1.0.3', attempts: 0 })
    m.checkNow()
    expect(f.d.check, 'no check once ready').toHaveBeenCalledTimes(1)
    m.restart()
    await flush()
    expect(order).toEqual(['drafts'])
    expect(f.d.install).toHaveBeenCalledTimes(1)
  })

  it('U-DST-9 · a Squirrel failure, or a download that fails, gives way to install.sh with the reason; an inactive updater means nothing updates this build', () => {
    const f = fakeDriver()
    const { m } = make({ how: BY_UPDATER, makeDriver: f.make })
    m.checkNow()
    f.on().available('1.0.3')
    f.on().failed('code signature did not match', 'squirrel')
    expect(m.state).toMatchObject({ mode: 'command', phase: { k: 'available', version: '1.0.3' } })
    expect(m.state.why).toMatch(/code signature did not match/)

    const g = fakeDriver()
    const check = make({ how: BY_UPDATER, makeDriver: g.make })
    check.m.checkNow()
    g.on().failed('net::ERR_INTERNET_DISCONNECTED', 'check')
    expect(check.m.state).toMatchObject({ mode: 'updater', phase: { k: 'failed', reason: 'net::ERR_INTERNET_DISCONNECTED' } })

    const h = fakeDriver()
    const inactive = make({ how: BY_UPDATER, makeDriver: h.make })
    inactive.m.checkNow()
    h.on().inactive()
    expect(inactive.m.state).toMatchObject({ mode: 'none', auto: false, phase: { k: 'idle' } })

    const broken = make({ how: BY_UPDATER, makeDriver: () => { throw new Error('Cannot find module updater.cjs') } })
    broken.m.checkNow()
    expect(broken.m.state.mode, 'a bundle that will not load: install.sh').toBe('command')
    expect(broken.feed).toHaveBeenCalledTimes(1)
  })

  it('U-DST-10 · a version Squirrel had ready that is still not running after L.updateInstallAttemptsMax starts is never downloaded again; running it, or a newer one, clears the mark', () => {
    let marks: UpdateMarks = { ...NO_UPDATE_MARKS, expected: { version: '1.0.3', attempts: 0 } }
    for (let start = 1; start < L.updateInstallAttemptsMax; start++) {
      const s = make({ marks0: marks, how: BY_UPDATER })
      s.m.checkInstalled()
      marks = s.marks()
      expect(marks.expected).toEqual({ version: '1.0.3', attempts: start })
    }
    const last = make({ marks0: marks, how: BY_UPDATER, makeDriver: fakeDriver().make })
    last.m.checkInstalled()
    expect(last.marks()).toMatchObject({ expected: null, skip: ['1.0.3'] })
    expect(last.m.state.phase).toEqual({ k: 'didNotInstall', version: '1.0.3' })

    const f = fakeDriver()
    const later = make({ marks0: last.marks(), how: BY_UPDATER, makeDriver: f.make })
    later.m.checkNow()
    f.on().available('1.0.3')
    expect(f.d.download, 'a skipped version').not.toHaveBeenCalled()
    expect(later.m.state.phase).toEqual({ k: 'didNotInstall', version: '1.0.3' })

    for (const running of ['1.0.3', '1.0.4']) {
      const ok = make({ version: running, marks0: { ...NO_UPDATE_MARKS, expected: { version: '1.0.3', attempts: 1 } } })
      ok.m.checkInstalled()
      expect(ok.marks().expected, running).toBeNull()
    }
  })
})

describe('files replaced under a running Kea', () => {
  it('U-DST-11 · upgraded ends checking and offers Restart Kea, which keeps the drafts and then restarts; removed offers nothing', async () => {
    const { m, clock, feed, order } = make()
    open(m)
    m.upgraded('1.0.3')
    expect(clock.count).toBe(0)
    expect(m.state.phase).toEqual({ k: 'upgraded', version: '1.0.3' })
    expect(m.title).toBe('Restart Kea')
    m.checkNow()
    await flush()
    expect(feed).not.toHaveBeenCalled()
    m.restart()
    await flush()
    expect(order).toEqual(['drafts', 'relaunch'])

    const r = make()
    r.m.removed()
    r.m.restart()
    await flush()
    expect(r.relaunch).not.toHaveBeenCalled()
    expect(r.m.title).toBe('Check for Updates…')
  })
})
