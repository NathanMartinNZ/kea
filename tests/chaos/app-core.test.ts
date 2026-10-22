// Core's own failures against the real app (tests/support/app.ts): a bug in core — an uncaught exception or an
// unhandled rejection — ends it with exit code 1 and main's Supervisor starts a new one (C-KILL-21); and the thin
// "Reconnecting…" bar, which the window shows only while core has been away longer than L.reconnectingBarDelayMs
// (C-KILL-24). The bug is injected through the child test hook (`fault`, tests/support/app-child-hooks.cjs). And a
// new shell from a core whose store update reaches the window before its reply (C-RACE-7: a restarted core's first
// reconciliation lists the shell it is still spawning), made exact with the hook's `lateReplies`.

import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tryLock, type Disposable } from '@kea/kit'
import { L } from '@kea/protocol'
import { KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { holdersUnharmed, watchTerminals } from '../support/app-chaos.ts'

const runs: KeaRun[] = []
const locks: Disposable[] = []
afterEach(async () => {
  for (const l of locks.splice(0)) l.dispose()
  for (const r of runs.splice(0)) await r.dispose()
})

/** Margin for the moment main's `coreAway` reaches the page against the moment the renderer's timer started (ms clocks). */
const CLOCK_SLACK_MS = 2
/** A bar due must be on screen, and a bar no longer due gone, within this (one busy frame or two). */
const RENDER_SLACK_MS = 250

type BarEvent = { t: number; e: 'away' | 'back' | 'shown' | 'hidden' }
type Outage = { away: number; back: number | null; shown: number | null; hidden: number | null }

/** Record, in the page, main's `coreAway`, each new RPC port and every time the bar appears or goes (wall clock). */
async function watchBar(kea: Kea): Promise<() => Promise<BarEvent[]>> {
  const page = await kea.page()
  await page.evaluate(() => {
    const log: { t: number; e: string }[] = []
    let shown = !!document.querySelector('.reconnecting-bar')
    new MutationObserver(() => {
      const now = !!document.querySelector('.reconnecting-bar')
      if (now !== shown) log.push({ t: Date.now(), e: (shown = now) ? 'shown' : 'hidden' })
    }).observe(document.body, { childList: true, subtree: true })
    window.addEventListener('message', (ev: MessageEvent) => {
      const k = (ev.data as { kea?: unknown } | null)?.kea
      if (k === 'coreAway') log.push({ t: Date.now(), e: 'away' })
      else if (k === 'rpc') log.push({ t: Date.now(), e: 'back' })
    })
    ;(window as unknown as { __keaBar: unknown }).__keaBar = log
  })
  return () => page.evaluate(() => [...((window as unknown as { __keaBar: BarEvent[] }).__keaBar ?? [])])
}

/** Each outage from main's `coreAway` to the next RPC port, with when the bar showed and went inside it. */
function outages(events: BarEvent[]): Outage[] {
  const out: Outage[] = []
  for (const ev of events) {
    const cur = out.at(-1)
    if (ev.e === 'away') {
      if (!cur || cur.back !== null) out.push({ away: ev.t, back: null, shown: null, hidden: null })
    } else if (ev.e === 'back') {
      if (cur && cur.back === null) cur.back = ev.t
    } else if (ev.e === 'shown') {
      expect(cur && cur.back === null, `the bar showed outside an outage at ${ev.t}`).toBe(true)
      if (cur) cur.shown ??= ev.t
    } else if (cur) cur.hidden = ev.t
  }
  return out
}

/** The bar shows only once core has been away longer than the delay, and goes when core is back. */
function barFollowsOutage(o: Outage): void {
  if (o.back === null) throw new Error('core never came back')
  const away = o.back - o.away
  if (away < L.reconnectingBarDelayMs - CLOCK_SLACK_MS) {
    expect(o.shown, `core away ${away} ms: the bar never shows`).toBeNull()
    return
  }
  if (away <= L.reconnectingBarDelayMs + RENDER_SLACK_MS) return // either is right at the edge
  if (o.shown === null) throw new Error(`core away ${away} ms but the bar never showed`)
  expect(o.shown - o.away, 'not before the delay').toBeGreaterThanOrEqual(L.reconnectingBarDelayMs - CLOCK_SLACK_MS)
  expect(o.shown - o.away, 'soon after the delay').toBeLessThanOrEqual(L.reconnectingBarDelayMs + RENDER_SLACK_MS)
  expect(o.hidden, 'gone when core is back').not.toBeNull()
  expect((o.hidden as number) - o.back, 'gone at once').toBeLessThanOrEqual(RENDER_SLACK_MS)
}

/** C-RACE-7: how much later core's replies leave than its store deltas: many store ticks, so the store's update comes first. */
const LATE_MS = 40 * L.storeTickMs

/** A bug in core: the hook answers, then throws or rejects on the next turn of core's event loop. */
function fault(kea: Kea, kind: 'throw' | 'reject'): Promise<unknown> {
  return kea.app.evaluate((_e, k) => (globalThis as unknown as { __keaTest: { debug(n: string, op: string, a?: string): Promise<unknown> } }).__keaTest.debug('core', 'fault', k), kind)
}

describe('core failures (app)', () => {
  it('C-KILL-21 · a bug in core (an uncaught exception, then an unhandled rejection) is logged, core exits 1 and the Supervisor starts a new one; terminals are untouched and a fast restart never shows the Reconnecting bar', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    await kea.newTab()
    const holders = run.holders()
    const before = await kea.processes()
    const bar = await watchBar(kea)
    const watch = await watchTerminals(kea)

    for (const [i, kind] of (['throw', 'reject'] as const).entries()) {
      const old = await kea.pid('core')
      expect(await fault(kea, kind)).toBe(kind)
      const next = await kea.restarted('core', old)
      expect(next.pid).not.toBe(old.pid)
      const msg = kind === 'throw' ? 'uncaught exception' : 'unhandled rejection'
      const logged = kea.logLines('core').filter((l) => l.msg === msg && l.level === 'error' && String(l.error).includes(`kea-test: ${msg}`))
      expect(logged, `core logged the ${msg}`).toHaveLength(1)
      const exits = kea.logLines('main').filter((l) => l.msg === 'child exited' && l.name === 'core')
      expect(exits.map((l) => l.code), 'core exited 1 each time').toEqual(Array(i + 1).fill(1))
      await until('the new core’s port in the window', async () => (await watch.received('rpc')) >= i + 1 || undefined)
    }

    // the window works with the new core (a tab from its store), and the terminals never noticed
    await kea.newTab()
    expect(await watch.stop(), 'no tab left the strip and no terminal view was rebuilt').toEqual({ fewestTabs: 2, rebuilt: [] })
    await kea.echo('after-core-bugs')
    const after = await kea.processes()
    expect([after.ptyhost?.pid, after.renderer?.pid], 'ptyhost and renderer untouched').toEqual([before.ptyhost?.pid, before.renderer?.pid])
    holdersUnharmed(run, holders)

    // the bar: two outages, each shown only if longer than the delay (a restart is normally faster)
    const seen = outages(await bar())
    expect(seen, 'one outage per bug').toHaveLength(2)
    for (const o of seen) barFollowsOutage(o)
    await kea.assertUnfocused()
  })

  it('C-KILL-24 · core away longer than L.reconnectingBarDelayMs: the Reconnecting bar shows after the delay over the tab strip, nothing moves, typing goes on, and it goes when core is back', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    const page = await kea.page()
    const box = async (sel: string) => page.locator(sel).first().boundingBox()
    const layout = async () => ({ strip: await box('.tabstrip'), terminal: await box('.terminal-host:not(.hidden)') })
    const laid = await layout()
    const bar = await watchBar(kea)

    // core killed and kept away by holding its lock (each respawn says `locked` and exits)
    const lockPath = path.join(run.home, 'run', 'core.lock')
    const away = await kea.signal('core', 'SIGKILL')
    locks.push(await until('core’s lock', () => tryLock(lockPath) ?? undefined))
    const shown = page.locator('.reconnecting-bar')
    await shown.waitFor({ state: 'visible', timeout: STEP_MS })
    expect(await shown.textContent()).toBe('Reconnecting…')
    expect(await shown.getAttribute('role')).toBe('status')
    expect(await box('.reconnecting-bar'), 'laid exactly over the tab strip').toEqual(laid.strip)
    expect(await layout(), 'nothing moved: no terminal was resized').toEqual(laid)
    // typing and output are unaffected while core is away
    await kea.echo('while-core-away')
    expect(await shown.isVisible(), 'still away: still shown').toBe(true)

    locks.pop()?.dispose()
    await kea.restarted('core', away)
    await shown.waitFor({ state: 'detached', timeout: STEP_MS })
    const seen = outages(await bar())
    expect(seen).toHaveLength(1)
    const [o] = seen as [Outage]
    expect(o.shown, 'the bar showed').not.toBeNull()
    barFollowsOutage(o)
    await kea.assertUnfocused()
  })

  it('C-RACE-7 · ⌘T while core’s terminals store lists the new shell before core’s reply comes (a restarted core’s first reconciliation does): the new shell still becomes the tab on screen, once the reply comes', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    const page = await kea.page()
    // in the page: when each tab first appears in the strip, and when each terminal is first the one on screen
    await page.evaluate(() => {
      const seen: { listed: Record<string, number>; shown: Record<string, number> } = { listed: {}, shown: {} }
      const look = () => {
        const t = Date.now()
        for (const e of document.querySelectorAll('[role=tab][data-pty]')) seen.listed[e.getAttribute('data-pty') ?? ''] ??= t
        const s = document.querySelector('.terminal-host.shown')?.getAttribute('data-pty')
        if (s) seen.shown[s] ??= t
      }
      look()
      new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true })
      ;(window as unknown as { __keaTabs: typeof seen }).__keaTabs = seen
    })
    expect(await kea.debug('core', 'lateReplies', String(LATE_MS))).toBe(LATE_MS)
    const id = await kea.newTab()
    await kea.debug('core', 'lateReplies', '0')
    const seen = await page.evaluate(() => (window as unknown as { __keaTabs: { listed: Record<string, number>; shown: Record<string, number> } }).__keaTabs)
    // the order this test is about: the tab was in the strip well before its reply made it the one on screen
    expect(seen.listed[id], 'the new tab appeared in the strip').toBeDefined()
    expect((seen.shown[id] ?? 0) - (seen.listed[id] ?? 0), 'listed first, shown once the reply came').toBeGreaterThanOrEqual(LATE_MS / 2)
    await kea.echo('after-late-reply')
    expect(await kea.tabCount()).toBe(2)
    await kea.assertUnfocused()
  })
})
