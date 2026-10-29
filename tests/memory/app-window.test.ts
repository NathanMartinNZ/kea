// Leak cycles of the window and its connections against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts: overlays opened and closed, the window reloaded, and the renderer frozen during a flood.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@kea/kit'
import { L } from '@kea/protocol'
import { signalKnown } from '../../tools/perf/src/launch.ts'
import { KeaRun, PROMPT, STEP_MS, until, zooShellCommand, type Kea } from '../support/app.ts'
import { BYTE_BUDGET, expectBytesFlat, expectCountsFlat, RendererProbe, runCycles } from '../support/app-leak.ts'
import { addProject, demoRepo, projectRow, sessionMenu, sessionRow, startSession, waitLive, waitRow } from '../support/app-sessions.ts'
import { sysKey } from '../support/keys.ts'

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

async function start(): Promise<{ run: KeaRun; kea: Kea; renderer: RendererProbe }> {
  const run = KeaRun.create()
  runs.push(run)
  const kea = await run.launch()
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  const renderer = await RendererProbe.open(kea)
  probes.push(renderer)
  return { run, kea, renderer }
}

/** L-MEM-6: how long the renderer is frozen. */
const FREEZE_MS = 60_000
/** L-MEM-6: output during the freeze, well past L.streamSkipAheadBytes. */
const FLOOD_BYTES = 4 * L.streamSkipAheadBytes
/** L-MEM-6: titles in the storm, as many as the deltas of L-MEM-3. */
const STORM_TITLES = 10_000

/**
 * Record every title the tab of `ptyId` shows in its tooltip from now on, where a shell tab shows what its program set
 * (a MutationObserver runs after each commit, so no state the tab passes through is missed); returns a reader.
 */
async function watchTab(kea: Kea, ptyId: string): Promise<() => Promise<string[]>> {
  const page = await kea.page()
  await page.evaluate((id) => {
    const tab = document.querySelector(`[role=tab][data-pty="${id}"]`)
    if (!tab) throw new Error(`no tab for ${id}`)
    const seen: string[] = [] // bounded: one entry per change of one tab during one test
    let last = tab.getAttribute('data-tip') ?? ''
    new MutationObserver(() => {
      const now = tab.getAttribute('data-tip') ?? ''
      if (now !== last) seen.push((last = now))
    }).observe(tab, { attributes: true, attributeFilter: ['data-tip'] })
    ;(window as unknown as { __keaTabTitles: string[] }).__keaTabTitles = seen
  }, ptyId)
  return () => page.evaluate(() => [...(window as unknown as { __keaTabTitles: string[] }).__keaTabTitles])
}

/** Every byte series the harness reads. */
const HEAPS = ['renderer.heap', 'core.heap', 'ptyhost.heap', 'main.heap']

describe('window and connection leaks (app)', () => {
  it('L-MEM-1 · open and close the find bar and the multi-line paste sheet 500 times: DOM nodes, listeners and every other count equal; heaps within budget', async () => {
    const { kea, renderer } = await start()
    const page = await kea.page()
    const overlay = (sel: string, open: boolean) => page.waitForFunction(([s, o]) => !!document.querySelector(s as string) === o, [sel, open] as const)
    const run = await runCycles({
      kea,
      renderer,
      batch: 50,
      cycle: async (i) => {
        await page.keyboard.press(sysKey('Meta+f'))
        await overlay('.find-bar', true)
        await page.keyboard.type(`k${i}`)
        await page.keyboard.press('Escape')
        await overlay('.find-bar', false)
        // a paste event straight to the terminal; the system clipboard is never touched
        await page.evaluate((n) => {
          const ta = document.querySelector('.terminal-host.shown textarea')
          const dt = new DataTransfer()
          dt.setData('text/plain', `echo one-${n}\necho two\n`)
          ta?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        }, i)
        await overlay('[role=alertdialog]', true)
        await page.keyboard.press('Escape')
        await overlay('[role=alertdialog]', false)
      },
    })
    expect(run.cycles.at(-1)).toBe(500)
    expectCountsFlat(run, () => true)
    await expectBytesFlat(kea, renderer, run, HEAPS, 'L-MEM-1')
    // nothing was pasted: every sheet was cancelled
    expect(await kea.screen()).not.toContain('one-')
  })

  it('L-MEM-18 · open and close the composer, every context menu and the header overflow, each sheet they open, and ⌘O’s folder pick, ×30: DOM nodes, listeners and every other count equal (folder picks in flight back to none); heaps within budget. Then the composer and each sheet again ×10, every one closed while what it asked core for is still unanswered (core held meanwhile): the same', async () => {
    const { run, kea, renderer } = await start()
    const page = await kea.page()
    const repo = demoRepo(run)
    await addProject(kea, repo.root)
    // a deleted session, so Restore Deleted Session… opens its sheet; and a live one, selected
    const gone = await startSession(kea, 'deleted before the cycles')
    await waitLive(kea, gone)
    await sessionMenu(kea, gone, 'session.delete')
    await page.getByRole('alertdialog', { name: 'Delete session' }).getByRole('button', { name: 'Delete', exact: true }).click()
    await until('the deleted row gone', async () => (await sessionRow(page, gone).count()) === 0 || undefined)
    const id = await startSession(kea, 'menus and sheets')
    await waitLive(kea, id)
    const projectId = await projectRow(page, 'demo').getAttribute('data-project-id')
    const closed = (role: 'menu' | 'dialog' | 'alertdialog' | 'region', name: string) => page.getByRole(role, { name }).waitFor({ state: 'detached', timeout: STEP_MS })
    const opened = (role: 'menu' | 'dialog' | 'alertdialog' | 'region', name: string) => page.getByRole(role, { name }).waitFor({ state: 'visible', timeout: STEP_MS })
    /**
     * The overlay just opened has everything it asked core for (the composer's bases and validation, a sheet's
     * preview), and has drawn it. Every cycle of the first set closes an overlay only from here, so every cycle, the
     * warm-up included, draws the same things (the second set, below, closes them unanswered, and holds core to make
     * that the same every time too). Without it Esc would race the answer: on a quiet machine the answer loses every
     * time, and under load a sheet's loaded branch (Remove project's list of sessions that keep it, 13 nodes) is first
     * drawn in some later cycle. Svelte builds a branch's `<template>` once, on first use, and keeps it for the life of
     * the page; those nodes count in `renderer.nodes`, so the count would rise once after the baseline and then stay.
     */
    const atRest = () =>
      until('the window at rest (no call of its own waiting on core)', () =>
        page.evaluate(() => (globalThis as unknown as { __keaProbe: { rpcPending(): number } }).__keaProbe.rpcPending() === 0),
      )
    /** Open a menu, pick `command` or close it with Esc; then the sheet the pick opened, closed with Esc once at rest. */
    const menu = async (open: () => Promise<void>, name: string, pick?: { command: string; role: 'dialog' | 'alertdialog'; sheet: string }) => {
      await open()
      await opened('menu', name)
      await atRest()
      if (!pick) {
        await page.keyboard.press('Escape')
        await closed('menu', name)
        return
      }
      await page.getByRole('menu', { name }).locator(`[role=menuitem][data-command="${pick.command}"]`).click()
      await opened(pick.role, pick.sheet)
      await atRest()
      await page.keyboard.press('Escape')
      await closed(pick.role, pick.sheet)
    }
    const sessionMenuOpen = () => sessionRow(page, id).click({ button: 'right' })
    const projectMenuOpen = () => projectRow(page, 'demo').click({ button: 'right' })
    const run_ = await runCycles({
      kea,
      renderer,
      batch: 3,
      cycle: async () => {
        // the composer (Esc closes it, back to the session)
        await page.keyboard.press(sysKey('Meta+n'))
        await opened('region', 'New session')
        await atRest()
        await page.keyboard.press('Escape')
        await closed('region', 'New session')
        // every menu, and each sheet they open, and the header's overflow menu
        await menu(sessionMenuOpen, 'Session menu')
        await menu(sessionMenuOpen, 'Session menu', { command: 'session.delete', role: 'alertdialog', sheet: 'Delete session' })
        await menu(projectMenuOpen, 'Project menu')
        await menu(projectMenuOpen, 'Project menu', { command: 'session.restoreDeleted', role: 'alertdialog', sheet: 'Restore deleted session' })
        await menu(projectMenuOpen, 'Project menu', { command: 'project.settings', role: 'dialog', sheet: 'Project settings' })
        await menu(projectMenuOpen, 'Project menu', { command: 'project.remove', role: 'alertdialog', sheet: 'Remove project' })
        await menu(() => page.getByRole('button', { name: 'Session actions' }).click(), 'Session actions')
        // ⌘O's folder pick, answered by main with the project's own folder: the project row takes focus (an existing
        // project); Esc gives it back to the terminal
        await kea.app.evaluate((_e, p) => (globalThis as unknown as { __keaTest: { queueFolder(p: string): void } }).__keaTest.queueFolder(p), repo.root)
        await page.keyboard.press(sysKey('Meta+o'))
        await page.waitForFunction((pid) => document.activeElement?.getAttribute('data-project-id') === pid, projectId, { timeout: STEP_MS })
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !!document.activeElement?.closest('.terminal-host'), undefined, { timeout: STEP_MS })
      },
    })
    expect(run_.cycles.at(-1)).toBe(30)
    await waitRow(kea, id, 'still live, untouched by the sheets', (r) => r.lifecycle === 'live')
    expect(run_.points.map((p) => p.counts['renderer.folderPicks']), 'folder picks in flight at each checkpoint').toEqual(run_.points.map(() => 0))
    expectCountsFlat(run_, () => true)
    await expectBytesFlat(kea, renderer, run_, HEAPS, 'L-MEM-18')

    // ── closed while its call is still waiting ───────────────────────────────────────────────────────────────
    // Where a retention would hide: an overlay that is gone when core answers it (the callback that would draw the
    // answer, the overlay's state, its nodes). The cycles above never do that, so that each takes one path; these do
    // nothing else. Both branches of every sheet have been drawn by now (its first state as it opened, then the
    // answer's), so everything Svelte builds once per page exists before this set's baseline. And the path is the same
    // every time here too, with no race to lose: core is stopped (SIGSTOP, identity-checked) from before the overlay
    // asks until after it has closed, so the answer can only arrive for an overlay that is no longer there. A stop
    // lasts a few round trips to the window, far below the missed heartbeats after which the supervisor restarts core
    // (L.supervisorMissedHeartbeats).
    const core = await kea.pid('core')
    const stopCore = (sig: 'SIGSTOP' | 'SIGCONT'): void => {
      if (!signalKnown(core, sig)) throw new Error(`core (${core.pid}) is not the process it was`)
    }
    const waiting = (): Promise<number> => page.evaluate(() => (globalThis as unknown as { __keaProbe: { rpcPending(): number } }).__keaProbe.rpcPending())
    /** Open an overlay with core held and close it at once: what it asked for as it opened is unanswered when it goes. */
    const closedUnanswered = async (open: () => Promise<void>, role: 'region' | 'dialog' | 'alertdialog', name: string): Promise<void> => {
      stopCore('SIGSTOP')
      try {
        await open()
        await opened(role, name)
        expect(await waiting(), `${name}: calls waiting on core as it is closed`).toBeGreaterThan(0)
        await page.keyboard.press('Escape')
        await closed(role, name)
        expect(await waiting(), `${name}: its call is still unanswered after it has closed`).toBeGreaterThan(0)
      } finally {
        stopCore('SIGCONT')
      }
      // the answers arrive now, for nothing on screen
      await atRest()
    }
    const sheetUnanswered = async (open: () => Promise<void>, name: string, pick: { command: string; role: 'dialog' | 'alertdialog'; sheet: string }): Promise<void> => {
      // the menu itself as before: its items are what core has said, so it is opened with core running
      await open()
      await opened('menu', name)
      await atRest()
      await closedUnanswered(() => page.getByRole('menu', { name }).locator(`[role=menuitem][data-command="${pick.command}"]`).click(), pick.role, pick.sheet)
    }
    const unanswered = await runCycles({
      kea,
      renderer,
      batch: 1,
      cycle: async () => {
        await closedUnanswered(() => page.keyboard.press(sysKey('Meta+n')), 'region', 'New session')
        await sheetUnanswered(sessionMenuOpen, 'Session menu', { command: 'session.delete', role: 'alertdialog', sheet: 'Delete session' })
        await sheetUnanswered(projectMenuOpen, 'Project menu', { command: 'session.restoreDeleted', role: 'alertdialog', sheet: 'Restore deleted session' })
        await sheetUnanswered(projectMenuOpen, 'Project menu', { command: 'project.settings', role: 'dialog', sheet: 'Project settings' })
        await sheetUnanswered(projectMenuOpen, 'Project menu', { command: 'project.remove', role: 'alertdialog', sheet: 'Remove project' })
      },
    })
    expect(unanswered.cycles.at(-1)).toBe(10)
    expect((await kea.pid('core')).pid, 'the same core throughout: never held long enough to be restarted').toBe(core.pid)
    await waitRow(kea, id, 'still live, untouched by the sheets', (r) => r.lifecycle === 'live')
    expectCountsFlat(unanswered, () => true)
    await expectBytesFlat(kea, renderer, unanswered, HEAPS, 'L-MEM-18 (closed unanswered)')
  })

  it('L-MEM-5 · reload the window 100 times: core and ptyhost ports, streams and scopes, and main’s listeners back to baseline; heaps within budget', async () => {
    const { kea, renderer } = await start()
    const page = await kea.page()
    const run = await runCycles({
      kea,
      renderer,
      batch: 10,
      cycle: async () => {
        await page.reload()
        await kea.whenReady()
      },
    })
    expect(run.cycles.at(-1)).toBe(100)
    // every count the harness reads stays at its baseline — live MessagePorts on both sides, ptyhost's streams and
    // holder sockets, everything in each process's kit registry (scopes, listeners, timers, the gauges it registers),
    // active handles, the renderer's resource report, and main's IPC listeners and windows
    expectCountsFlat(run, () => true)
    await expectBytesFlat(kea, renderer, run, HEAPS, 'L-MEM-5')
    await kea.echo('lmem5')
  })

  it('L-MEM-6 · renderer frozen 60 s during a terminal flood and a title storm: ptyhost sends at most a credit window per stream; core and ptyhost heaps within budget; on resume snapshots, not backlogs, and the storm’s tab gets at most two titles (latest wins)', async () => {
    const { run, kea } = await start()
    const flood = await kea.shown()
    const storm = await kea.newTab()
    const fifos = { flood: path.join(run.home, 'flood.fifo'), storm: path.join(run.home, 'storm.fifo') }
    for (const f of Object.values(fifos)) expect((await runProcess('/usr/bin/mkfifo', [f], { pool: 'other' })).code).toBe(0) // os-ok: in /usr/bin on both systems
    // the title storm: OSC 2 titles go ptyhost → core's terminals store → the tab's tooltip (latest wins)
    await kea.enter(`read x < ${fifos.storm} && for i in {1..${STORM_TITLES}}; do printf '\\e]2;t%d\\a' $i; done; echo storm-$((40+2))`)
    await kea.select(flood as string)
    await kea.enter(`read x < ${fifos.flood} && ${zooShellCommand('flood', ['--bytes', String(FLOOD_BYTES)])} && echo flood-$((40+2))`)
    const heapOf = async (name: 'core' | 'ptyhost') => {
      await kea.debug(name, 'gc')
      return (await kea.debug<{ heapUsed: number }>(name, 'heap')).heapUsed
    }
    const before = { core: await heapOf('core'), ptyhost: await heapOf('ptyhost') }
    const titles = await watchTab(kea, storm)
    await kea.debug('ptyhost', 'streams', 'reset')
    const renderer = await kea.signal('renderer', 'SIGSTOP')
    const stoppedAt = Date.now()
    let atResume = { flood: 0, storm: 0 }
    try {
      fs.writeFileSync(fifos.storm, 'go\n')
      fs.writeFileSync(fifos.flood, 'go\n')
      await until('the flood and the storm to finish', () => (run.ring(flood as string).text.includes('flood-42') && run.ring(storm).text.includes('storm-42')) || undefined)
      await new Promise((r) => setTimeout(r, Math.max(0, stoppedAt + FREEZE_MS - Date.now())))
      const sent = await kea.debug<{ dataBytes: number; snapshotChars: number }>('ptyhost', 'streams')
      expect(sent.dataBytes + sent.snapshotChars, 'sent to the frozen renderer: one window per stream').toBeLessThanOrEqual(2 * L.streamCreditBytes)
      for (const name of ['core', 'ptyhost'] as const) expect((await heapOf(name)) - before[name], `${name} heap growth while the renderer was frozen`).toBeLessThanOrEqual(BYTE_BUDGET.absolute)
    } finally {
      atResume = { flood: run.ringLatest(flood as string), storm: run.ringLatest(storm) }
      await kea.signal('renderer', 'SIGCONT')
    }
    expect((await kea.processes()).renderer?.pid, 'the same renderer resumed').toBe(renderer.pid)
    await kea.waitScreen('the end of the flood', (s) => s.includes('flood-42'))
    await until('the last title on the tab', async () => (await (await kea.page()).locator(`[role=tab][data-tip="t${STORM_TITLES}"]`).count()) === 1 || undefined)
    const sent = await kea.debug<{ snapshots: number; dataBytes: number }>('ptyhost', 'streams')
    expect(sent.snapshots, 'caught up by snapshot').toBeGreaterThan(0)
    // the stream's back-pressure, exactly: at most a credit window per stream while frozen, then a snapshot and only
    // what the shells wrote after the resume; nothing of the flood's backlog
    const after = run.ringLatest(flood as string) - atResume.flood + run.ringLatest(storm) - atResume.storm
    expect(sent.dataBytes, `data sent: a window per stream (2 × ${L.streamCreditBytes}) + ${after} B written after the resume`).toBeLessThanOrEqual(2 * L.streamCreditBytes + after)
    // core holds one delta in flight and one merged pending per subscriber, so the 10 000 titles reach the resumed
    // window as at most two deltas, the last one the latest title
    const shown = await titles()
    expect(shown.length, `titles the storm's tab showed after the resume: ${JSON.stringify(shown.slice(0, 5))}`).toBeLessThanOrEqual(2)
    expect(shown.at(-1), 'the last one is the latest').toContain(`t${STORM_TITLES}`)
  })
})

