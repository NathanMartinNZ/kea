// The kill matrix's terminal parts, against the real app (tests/support/app.ts). Each test runs the chaos workload (a
// counter in one tab, an idle shell in another), injects one fault, then checks the post-conditions of
// tests/support/app-chaos.ts: the counter one strict run across the seam between the rebuilt snapshot and the live
// stream (`seamContinuous`), the holders unharmed, and for a core fault, typing through it with no key waiting past the
// keystroke-echo budget's p99 (P-TERM-1, `typeThrough`). `pnpm verify` runs the tests tools/verify-tier-a.ts names, and
// `pnpm chaos` all of them; what a fault does to sessions, status and hooks is tested in the other app-* files.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@kea/kit'
import { L } from '@kea/protocol'
import { counterText } from '@kea-tools/process-zoo/src/index.ts'
import { COUNTER_FORMAT, counterCommand, KeaRun, PROMPT, ringMax, shq, STEP_MS, until, writeFifo, zooShellCommand, type Kea } from '../support/app.ts'
import {
  backoffMs,
  expectTypingUninterrupted,
  holdersUnharmed,
  isAlive,
  lastOnScreen,
  restartDelays,
  ringContinuity,
  ringGrows,
  seamContinuous,
  startWorkload,
  typeThrough,
  watchTerminals,
} from '../support/app-chaos.ts'

/** Counter lines per second: slow enough that a fault and its recovery stay well inside the scrollback. */
const RATE = 4
/** Ten kills in a row (C-KILL-8, C-KILL-14), each as soon as the new process is up. */
const KILLS = 10
/** How long the renderer stays frozen in the frozen-renderer test (C-KILL-5). */
const FREEZE_MS = 30_000
/** Output during the freeze: well past the point where ptyhost stops sending the backlog. */
const FLOOD_BYTES = 4 * L.streamSkipAheadBytes
/**
 * C-KILL-13: counter lines written at full speed while ptyhost is stopped: more than twice the holder's flow window
 * and one read, so the holder pauses, then free-runs; still well inside the ring.
 */
const BURST_LINES = 70_000

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})
function newRun(): KeaRun {
  const r = KeaRun.create()
  runs.push(r)
  return r
}

/** Start `cat` in the terminal on screen and wait until a key typed into it echoes. */
async function catRunning(kea: Kea): Promise<void> {
  await kea.enter('cat')
  await kea.keyEcho('x')
}

describe('kill matrix (app)', () => {
  it('C-KILL-1 · SIGKILL of the renderer: the window reloads, every terminal reattaches byte-exact, nothing else is touched', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const before = await kea.processes()
    const seen = await lastOnScreen(kea)
    const renderer = await kea.signal('renderer', 'SIGKILL')
    await kea.whenReady()
    const after = await kea.processes()
    expect(after.renderer?.pid, 'a new renderer process').not.toBe(renderer.pid)
    expect([after.core?.pid, after.ptyhost?.pid], 'core and ptyhost untouched').toEqual([before.core?.pid, before.ptyhost?.pid])
    expect(await kea.tabCount(), 'both tabs reattached').toBe(2)
    await seamContinuous(run, kea, w.counter, { before: seen })
    await kea.select(w.shell)
    await kea.echo('ckill1')
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
    await kea.assertUnfocused()
  })

  it('C-KILL-2 · SIGKILL of core: typing never waits on it (every key within P-TERM-1’s p99) and output goes on; core restarts and the window re-subscribes', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const before = await kea.processes()
    const seen = await lastOnScreen(kea)
    await kea.select(w.shell)
    await catRunning(kea)
    const watch = await watchTerminals(kea)
    const core = await kea.signal('core', 'SIGKILL')
    const killedAt = Date.now()
    // type through the outage, every key timed, until the window holds the new core's port (it has re-subscribed)
    const typed = await typeThrough(kea, async () => (await watch.received('rpc')) >= 1, { min: 2 })
    const next = await kea.pid('core')
    expect(next.pid, 'core restarted').not.toBe(core.pid)
    const startedAt = Date.parse(kea.logLines('core').find((l) => l.msg === 'started' && l.pid === next.pid)?.t ?? '')
    expect(typed.at.filter((t) => t > killedAt && t < startedAt).length, 'keys echoed while no core was running').toBeGreaterThan(0)
    expectTypingUninterrupted(typed.ms, 'from the kill until the window re-subscribed')
    await kea.press('Control+c')
    // the new core serves the window: a new tab comes from its terminals store
    await kea.newTab()
    // terminals are unaffected throughout, also while the window re-subscribed to the new core's stores
    expect(await watch.stop(), 'no tab left the strip and no terminal view was rebuilt').toEqual({ fewestTabs: 2, rebuilt: [] })
    const after = await kea.processes()
    expect([after.ptyhost?.pid, after.renderer?.pid], 'ptyhost and renderer untouched').toEqual([before.ptyhost?.pid, before.renderer?.pid])
    await seamContinuous(run, kea, w.counter, { before: seen })
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
    await kea.assertUnfocused()
  })

  it('C-KILL-4 · SIGSTOP of core (a hang): missed heartbeats get it killed and restarted; typing never waits on it (every key within P-TERM-1’s p99); terminals unaffected', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const before = await kea.processes()
    const seen = await lastOnScreen(kea)
    await kea.select(w.shell)
    await catRunning(kea)
    const watch = await watchTerminals(kea)
    const hung = await kea.signal('core', 'SIGSTOP')
    // type through the hang and the restart, until the window holds the new core's port
    const typed = await typeThrough(kea, async () => (await watch.received('rpc')) >= 1, { min: 2 })
    expectTypingUninterrupted(typed.ms, 'from the hang until the window re-subscribed to the new core')
    await until('the hung core to be gone', () => !isAlive(hung.pid) || undefined)
    const next = await kea.pid('core')
    expect(next.pid, 'core restarted').not.toBe(hung.pid)
    expect(restartDelays(kea, 'core').map((d) => d.reason), 'killed for its missed heartbeats').toEqual(['heartbeat'])
    await kea.press('Control+c')
    await kea.newTab()
    expect(await watch.stop(), 'no tab left the strip and no terminal view was rebuilt').toEqual({ fewestTabs: 2, rebuilt: [] })
    const after = await kea.processes()
    expect([after.ptyhost?.pid, after.renderer?.pid], 'ptyhost and renderer untouched').toEqual([before.ptyhost?.pid, before.renderer?.pid])
    await seamContinuous(run, kea, w.counter, { before: seen })
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
    await kea.assertUnfocused()
  })

  it('C-KILL-3 · SIGKILL of main: holders and shells run on alone; a relaunch reattaches every terminal, byte-exact at the seam', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const seen = await lastOnScreen(kea)
    await kea.signal('main', 'SIGKILL')
    await kea.gone()
    await ringGrows(run, w.counter)
    const again = await run.launch()
    expect(await again.tabCount(), 'the two shells restored, none added').toBe(2)
    await seamContinuous(run, again, w.counter, { before: seen })
    await again.select(w.shell)
    await again.echo('ckill3')
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
  })

  it('C-KILL-22 · Quit Kea Completely with a counter running, relaunched after more than a screen of output: core and ptyhost shut down when asked; holders and shells run on; every terminal reattaches byte-exact at the seam', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const procs = await kea.processes()
    const seen = await lastOnScreen(kea)
    const rows = (await kea.views()).find((v) => v.ptyId === w.counter)?.rows ?? 0
    expect(rows, 'the counter terminal’s height').toBeGreaterThan(0)
    expect(await kea.quitFromMenu(), 'main exits by itself, cleanly').toEqual({ code: 0, signal: null })
    // each child was asked to shut down and exited by itself, within the grace (none had to be stopped)
    for (const name of ['core', 'ptyhost'] as const) {
      expect(
        kea.logLines(name).some((l) => l.msg === 'shutdown'),
        `${name} shut down on request`,
      ).toBe(true)
      expect(
        kea.logLines('main').filter((l) => l.msg === 'child exited' && l.name === name).map((l) => l.code),
        `${name} (${procs[name]?.pid}) exited with code 0`,
      ).toEqual([0])
    }
    await kea.gone()
    // the outage: more than a screen of the counter's output while no Kea process runs
    await until(`more than a screen (${rows} rows) of output past kc ${seen}`, () => ringMax(run, w.counter) > seen + rows || undefined, (rows / RATE) * 1000 + STEP_MS)
    holdersUnharmed(run, holders)
    const again = await run.launch()
    expect(await again.tabIds(), 'both tabs back, in their order').toEqual([w.counter, w.shell])
    await seamContinuous(run, again, w.counter, { before: seen })
    await again.select(w.shell)
    await again.echo('ckill22')
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
    await again.assertUnfocused()
  })

  it('C-KILL-6 · SIGKILL of one holder: only its PTY is lost (its shell gets SIGHUP); the other terminal and every Kea process are untouched', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const before = await kea.processes()
    const seen = await lastOnScreen(kea)
    const victim = run.holder(w.shell)
    const survivor = run.holder(w.counter)
    run.signalHolder(victim, 'SIGKILL')
    await until('the lost PTY’s shell to exit on SIGHUP', () => !isAlive(victim.childPid) || undefined)
    // a shell tab whose PTY ended closes (renderer); a session's agent shows a detached screen instead (C-KILL-17)
    await until('the lost tab to close', async () => (await kea.tabCount()) === 1 || undefined)
    expect(await kea.shown()).toBe(w.counter)
    const after = await kea.processes()
    for (const k of ['main', 'core', 'ptyhost', 'renderer'] as const) expect(after[k]?.pid, `${k} untouched`).toBe(before[k]?.pid)
    await seamContinuous(run, kea, w.counter, { before: seen })
    holdersUnharmed(run, [survivor])
    ringContinuity(run, w.counter)
  })

  it('C-KILL-11 · everything killed, holders included (simulated reboot): a relaunch converges to one fresh, working shell', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    await kea.signal('main', 'SIGKILL')
    await kea.gone()
    for (const h of holders) run.killHolderTree(h)
    await until('every old holder and shell to be gone', () => holders.every((h) => !isAlive(h.pid) && !isAlive(h.childPid)) || undefined)
    const again = await run.launch()
    await again.waitScreen('a fresh shell prompt', (s) => s.includes(PROMPT))
    // the dead PTYs are not live tabs: the only terminal is a new one, and it works
    await until('only the fresh shell left as a tab', async () => (await again.tabCount()) === 1 || undefined)
    const fresh = await again.shown()
    expect([w.counter, w.shell]).not.toContain(fresh)
    await again.echo('ckill11')
    expect(run.holderAlive(run.holder(fresh as string))).toBe(true)
    const p = await again.processes()
    expect(p.core && p.ptyhost, 'core and ptyhost running').toBeTruthy()
  })

  it('C-KILL-12 · SIGKILL of ptyhost: it restarts, re-adopts every holder and the window reattaches byte-exact; typing resumes; core is untouched', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const before = await kea.processes()
    const seen = await lastOnScreen(kea)
    const old = await kea.signal('ptyhost', 'SIGKILL')
    await kea.restarted('ptyhost', old)
    await seamContinuous(run, kea, w.counter, { before: seen })
    await kea.select(w.shell)
    await kea.echo('ckill12')
    const after = await kea.processes()
    expect([after.core?.pid, after.renderer?.pid], 'core and renderer untouched').toEqual([before.core?.pid, before.renderer?.pid])
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
    await kea.assertUnfocused()
  })

  it('C-KILL-23 · the renderer hangs in a busy loop: main sees it unresponsive, ends it and reloads the window; every terminal reattaches byte-exact; nothing else is touched', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const before = await kea.processes()
    const seen = await lastOnScreen(kea)
    const page = await kea.page()
    const crashed = page.waitForEvent('crash', { timeout: STEP_MS })
    // the page spins from the task that logs this line: once it arrives, the renderer answers nothing (and no call to
    // it is left waiting, which Playwright would only see answered after the crash)
    const spinning = page.waitForEvent('console', { predicate: (m) => m.text() === 'kea-test: spinning', timeout: STEP_MS })
    await page.evaluate(() => {
      setTimeout(() => {
        console.log('kea-test: spinning')
        for (;;);
      }, 0)
    })
    await spinning
    // Chromium's hang monitor ignores a renderer while a debugger is attached to it (it may be sitting on a
    // breakpoint), and the harness drives the page over CDP: main gets the event Chromium sends otherwise
    await kea.app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0]?.emit('unresponsive'))
    await crashed
    expect(
      kea.logLines('main').some((l) => l.msg === 'renderer unresponsive: reloading the window'),
      'main ended the hung renderer',
    ).toBe(true)
    await kea.whenReady()
    const after = await kea.processes()
    expect(after.renderer?.pid, 'a new renderer process').not.toBe(before.renderer?.pid)
    await until('the hung renderer to be gone', () => !isAlive(before.renderer!.pid) || undefined)
    expect([after.main?.pid, after.core?.pid, after.ptyhost?.pid], 'main, core and ptyhost untouched').toEqual([before.main?.pid, before.core?.pid, before.ptyhost?.pid])
    expect(await kea.tabIds(), 'both tabs back, in their order').toEqual([w.counter, w.shell])
    await seamContinuous(run, kea, w.counter, { before: seen })
    await kea.select(w.shell)
    await kea.echo('ckill23')
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
    await kea.assertUnfocused()
  })

  it('C-KILL-5 · SIGSTOP of the renderer for 30 s during a flood: core and ptyhost unaffected, holders free-run, at most a credit window goes out; on resume a snapshot, not the backlog', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const before = await kea.processes()
    await kea.select(w.shell)
    // the flood starts when the test says so: the shell waits on a FIFO until the renderer is stopped
    const fifo = path.join(run.home, 'go.fifo')
    expect((await runProcess('/usr/bin/mkfifo', [fifo], { pool: 'other' })).code).toBe(0) // os-ok: in /usr/bin on both systems
    await kea.enter(`read x < ${shq(fifo)} && ${zooShellCommand('flood', ['--bytes', String(FLOOD_BYTES)])} && echo flood-$((40+2))`)
    await kea.debug('ptyhost', 'streams', 'reset')
    const counterFrom = run.ringLatest(w.counter)
    const renderer = await kea.signal('renderer', 'SIGSTOP')
    const stoppedAt = Date.now()
    let resumedShell = 0
    try {
      await writeFifo(fifo, 'go\n')
      await until('the whole flood in the holder’s ring', () => run.ring(w.shell).text.includes('flood-42') || undefined)
      await ringGrows(run, w.counter)
      // the renderer stays frozen for the whole of FREEZE_MS
      await new Promise((r) => setTimeout(r, Math.max(0, stoppedAt + FREEZE_MS - Date.now())))
      const sent = await kea.debug<{ dataBytes: number; snapshotChars: number }>('ptyhost', 'streams')
      // with no credit coming back, each of the two streams holds at most one window
      expect(sent.dataBytes + sent.snapshotChars, 'sent to the frozen renderer').toBeLessThanOrEqual(2 * L.streamCreditBytes)
      const during = await kea.processes()
      expect([during.core?.pid, during.ptyhost?.pid, during.renderer?.pid], 'nothing restarted or reloaded').toEqual([before.core?.pid, before.ptyhost?.pid, renderer.pid])
    } finally {
      resumedShell = run.ringLatest(w.shell)
      await kea.signal('renderer', 'SIGCONT')
    }
    await kea.waitScreen('the end of the flood', (s) => s.includes('flood-42') && s.trimEnd().endsWith(PROMPT.trimEnd()))
    const sent = await kea.debug<{ snapshots: number; dataBytes: number }>('ptyhost', 'streams')
    expect(sent.snapshots, 'the renderer caught up by a snapshot').toBeGreaterThan(0)
    // the bound below: the flood's stream got one credit window while frozen, then a snapshot and only what its shell
    // wrote after the resume; the counter's stream, never behind, got all its own output. Nothing of the backlog
    const counterOut = run.ringLatest(w.counter) - counterFrom
    const shellAfter = run.ringLatest(w.shell) - resumedShell
    expect(sent.dataBytes, `data sent: one window (${L.streamCreditBytes}) + the counter’s ${counterOut} B + the shell’s ${shellAfter} B after the resume`).toBeLessThanOrEqual(L.streamCreditBytes + counterOut + shellAfter)
    await kea.echo('ckill5')
    const after = await kea.processes()
    for (const k of ['main', 'core', 'ptyhost', 'renderer'] as const) expect(after[k]?.pid, `${k} untouched`).toBe(before[k]?.pid)
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
    await kea.assertUnfocused()
  })

  it('C-KILL-8 · core killed 10 times in a row: each restart waits out its backoff; no holder harmed; the last core serves the window', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const before = await kea.processes()
    const seen = await lastOnScreen(kea)
    let core = await kea.pid('core')
    // with the restart backoff, ten restarts take longer than 10 s: each kill comes as soon as a core is up
    for (let i = 0; i < KILLS; i++) core = await kea.restarted('core', await kea.signal('core', 'SIGKILL'))
    const delays = restartDelays(kea, 'core')
    expect(delays).toHaveLength(KILLS)
    // log times are whole milliseconds: a delay can read 1 ms short
    delays.forEach((d, i) => expect(d.delayMs, `restart ${i + 1} after its backoff`).toBeGreaterThanOrEqual(backoffMs(i) - 1))
    await until('the window on the last core', async () => (await kea.processes()).core?.pid === core.pid || undefined)
    await kea.newTab()
    expect(await kea.tabCount()).toBe(3)
    const after = await kea.processes()
    expect([after.ptyhost?.pid, after.renderer?.pid], 'ptyhost and renderer untouched').toEqual([before.ptyhost?.pid, before.renderer?.pid])
    await seamContinuous(run, kea, w.counter, { before: seen })
    await kea.select(w.shell)
    await kea.echo('ckill8')
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
    await kea.assertUnfocused()
  })

  it('C-KILL-13 · SIGSTOP of ptyhost during a burst of output: the holder pauses at its flow window, then free-runs before missed heartbeats get ptyhost killed and restarted; the window reattaches byte-exact', async () => {
    // free-run can come first: a holder's stale timeout is shorter than main's missed heartbeats
    expect(L.holderStaleClientMs).toBeLessThan(L.supervisorMissedHeartbeats * L.supervisorHeartbeatMs)
    expect(counterText({ count: BURST_LINES, format: COUNTER_FORMAT }, true).length, 'the burst’s bytes').toBeGreaterThan(2 * (L.holderFlowHighBytes + L.holderReadBufferBytes))
    const run = newRun()
    const kea = await run.launch()
    const counter = (await kea.shown()) as string
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    // the counter tab: the burst waits for the test, then the counter numbers on slowly
    const fifo = path.join(run.home, 'burst.fifo')
    expect((await runProcess('/usr/bin/mkfifo', [fifo], { pool: 'other' })).code).toBe(0) // os-ok: in /usr/bin on both systems
    const burst = zooShellCommand('counter', ['--count', String(BURST_LINES), '--rate', '0', '--format', COUNTER_FORMAT.replace('\n', '\\n')])
    await kea.enter(`read x < ${shq(fifo)} && ${burst} && ${counterCommand(RATE, { start: BURST_LINES + 1 })}`)
    const shell = await kea.newTab()
    await kea.select(counter)
    const holders = run.holders()
    const before = await kea.processes()
    const old = await kea.signal('ptyhost', 'SIGSTOP')
    const from = run.ringLatest(counter)
    const burstAt = Date.now()
    await writeFifo(fifo, 'go\n')
    // a paused holder reads at most its window and one read past what was acked; past that, it free-runs
    const mark = from + L.holderFlowHighBytes + L.holderReadBufferBytes
    const passedAt = await until('the holder to read past its flow window', () => (run.ringLatest(counter) > mark ? Date.now() : undefined), L.holderStaleClientMs + STEP_MS)
    // it paused first: free-run starts only once the paused client has been silent for the stale timeout, and the
    // pause cannot begin before the burst does
    expect(passedAt - burstAt, `the holder held its window for the stale timeout (${L.holderStaleClientMs} ms) before free-running`).toBeGreaterThanOrEqual(L.holderStaleClientMs)
    await kea.restarted('ptyhost', old)
    await until('the hung ptyhost to be gone', () => !isAlive(old.pid) || undefined)
    expect(restartDelays(kea, 'ptyhost').map((d) => d.reason)).toEqual(['heartbeat'])
    const killing = kea.logLines('main').find((l) => l.msg === 'supervisor: missed heartbeats, killing' && l.name === 'ptyhost')
    expect(killing, 'main logged why it killed ptyhost').toBeDefined()
    expect(passedAt, 'the holder read past its window while the hung ptyhost was still attached (free-run)').toBeLessThan(Date.parse(killing!.t))
    await seamContinuous(run, kea, counter)
    await kea.select(shell)
    await kea.echo('ckill13')
    const after = await kea.processes()
    expect([after.core?.pid, after.renderer?.pid], 'core and renderer untouched').toEqual([before.core?.pid, before.renderer?.pid])
    holdersUnharmed(run, holders)
    ringContinuity(run, counter)
    await kea.assertUnfocused()
  })

  it('C-KILL-14 · ptyhost killed 10 times in a row, then core and ptyhost together: backoff restarts, no holder harmed, the window works', async () => {
    const run = newRun()
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    const before = await kea.processes()
    const seen = await lastOnScreen(kea)
    // each kill as soon as the new ptyhost is up, which can be before it has adopted the holders: a connection
    // still awaiting the holder's admission check then hangs up, which a holder must not count as a refusal
    for (let i = 0; i < KILLS; i++) {
      const old = await kea.signal('ptyhost', 'SIGKILL')
      await kea.restarted('ptyhost', old)
    }
    const delays = restartDelays(kea, 'ptyhost')
    expect(delays).toHaveLength(KILLS)
    delays.forEach((d, i) => expect(d.delayMs, `restart ${i + 1} after its backoff`).toBeGreaterThanOrEqual(backoffMs(i) - 1))
    // both at once: neither may wait for the other
    const core = await kea.signal('core', 'SIGKILL')
    const ptyhost = await kea.signal('ptyhost', 'SIGKILL')
    await Promise.all([kea.restarted('core', core), kea.restarted('ptyhost', ptyhost)])
    await seamContinuous(run, kea, w.counter, { before: seen })
    await kea.select(w.shell)
    await kea.echo('ckill14')
    await kea.newTab()
    expect(await kea.tabCount()).toBe(3)
    expect((await kea.processes()).renderer?.pid, 'renderer untouched').toBe(before.renderer?.pid)
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
    await kea.assertUnfocused()
  })
})
