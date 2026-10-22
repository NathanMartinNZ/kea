// Resource exhaustion and a bad environment, the terminal parts, against the real app (tests/support/app.ts); these run
// only with `pnpm chaos`. The sleep test's notification and wall-clock parts are in app-status-clock.test.ts. The
// full-disk test fills a small volume of its own, mounted at a temporary mount point and taken away afterwards (the
// harness's OS layer: an APFS disk image through hdiutil on macOS, a size-limited tmpfs on Linux), never a system
// volume.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { diskCheckpoints } from '../../app/ptyhost/src/checkpoint/store.ts'
import { counterNumbers, PROMPT, KeaRun, STEP_MS, until, type KeaProcess } from '../support/app.ts'
import { holdersUnharmed, lastOnScreen, ringContinuity, seamContinuous, startWorkload, watchTerminals } from '../support/app-chaos.ts'
import { sysKey } from '../support/keys.ts'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { skipWhere } from '../support/skip.ts'

/** Counter lines per second (tests/support/app-chaos.ts). */
const RATE = 4
/**
 * C-RES-8: the length of the simulated sleep. It must outlast every timer that runs while Kea is idle, so each one
 * comes due during the stop and fires at the wake: parking is the longest, then checkpoints, the footprint sampler and
 * the heartbeats. The memory watchdog adds no timer to them: it looks at each sample of the sampler, whose interval
 * this outlasts, and its cool-down is a time it compares then, one that only runs after an action. So the sleep need
 * not last a cool-down (which would make this a long test): a wake that made the watchdog act or report would fail the
 * test by its error line in main.log, and the run by `KeaRun.dispose`, which allows no trigger; a clock that jumps past
 * the cool-down with nothing over a limit has a unit test of its own (U-MEM-9).
 */
const SLEEP_MS = L.mirrorParkIdleMs + L.checkpointMaxAgeMs
/** Everything a launch, a check and the cleanup around the sleep may take on top of it. */
const SLEEP_TEST_MS = SLEEP_MS + 3 * 60_000

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})
function newRun(o: { longPath?: boolean } = {}): KeaRun {
  const r = KeaRun.create(o)
  runs.push(r)
  return r
}

/** The full-disk volume: room for a home with a project, a session and its terminals, and little more. */
const VOLUME_MB = 64
const MIB = 1024 * 1024

/** Fill a volume until it refuses even small writes (ENOSPC at 1 MiB, then 64 KiB, then 4 KiB chunks); returns the file. */
function fillVolume(mount: string): string {
  const file = path.join(mount, 'filler')
  const fd = fs.openSync(file, 'w')
  try {
    for (const size of [MIB, 64 * 1024, 4096]) {
      const chunk = Buffer.alloc(size, 0x5a)
      for (;;) {
        try {
          fs.writeSync(fd, chunk)
          fs.fsyncSync(fd)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOSPC') break
          throw e
        }
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return file
}

describe('resources and environment (app)', () => {
  it('C-RES-1 · disk full: KEA_HOME on a small volume that fills up: a checkpoint fails and is skipped, and the window shows the disk-full banner; the terminals keep working (the counter runs on, a shell echoes) and nothing restarts; space freed: the next checkpoint is written and the banner goes', async (ctx) => {
    // Linux mounts the volume as root (sudo -n): a machine that does not allow it skips by name
    skipWhere(ctx, await harnessOs.smallVolumes.problem())
    // the home is the volume: mounted on the empty home directory before the run writes anything into it
    const home = KeaRun.newHome()
    const volume = await harnessOs.smallVolumes.mount(home, VOLUME_MB, 'kea-c-res-1')
    const run = KeaRun.create({ home })
    try {
      const kea = await run.launch()
      const page = await kea.page()
      const w = await startWorkload(kea, RATE)
      const holders = run.holders()
      const before = await kea.processes()
      const shell = run.holder(w.shell)
      const stateDir = path.join(run.home, 'sessions', shell.sessionId)
      const banner = page.locator('[role=status][data-banner="diskFull"]')
      expect(await banner.count(), 'no banner while there is room').toBe(0)

      // the disk fills up; then a checkpoint is due at once: ⌘K in the shell clears it and writes one
      const filler = fillVolume(home)
      await kea.select(w.shell)
      await kea.echo('cres1-before')
      await kea.press(sysKey('Meta+k'))
      await until('the checkpoint to fail', () => kea.logLines('ptyhost').some((l) => l.msg === 'checkpoint not written' && l.ptyId === w.shell) || undefined)
      await banner.waitFor({ timeout: STEP_MS })
      expect(await banner.textContent()).toMatch(/disk is full/i)

      // the terminals keep working: the shell echoes, the counter runs on through the live stream, nothing restarted
      await kea.echo('cres1-full')
      await kea.select(w.counter)
      const seen = await lastOnScreen(kea)
      await kea.waitScreen('the counter running on', (s) => counterNumbers(s).some((n) => n >= seen + 2))
      const during = await kea.processes()
      for (const k of ['main', 'core', 'ptyhost', 'renderer'] as const) expect(during[k]?.pid, `${k} neither restarted nor reloaded`).toBe(before[k]?.pid)
      holdersUnharmed(run, holders)

      // space returns: the next checkpoint is written and the banner goes
      const stale = diskCheckpoints.read(stateDir, w.shell)?.seq ?? -1
      fs.rmSync(filler)
      await kea.select(w.shell)
      await kea.echo('cres1-after')
      await kea.press(sysKey('Meta+k'))
      await until('a checkpoint written again', () => (diskCheckpoints.read(stateDir, w.shell)?.seq ?? -1) > stale || undefined)
      await banner.waitFor({ state: 'detached', timeout: STEP_MS })
      await kea.echo('cres1-done')
      await seamContinuous(run, kea, w.counter)
      holdersUnharmed(run, holders)
      ringContinuity(run, w.counter)
      await kea.assertUnfocused()
    } finally {
      // nothing of the run may still use the volume when it goes: Kea quit, every holder and what runs under it killed
      // (each identity-checked); then the volume goes, and the run's cleanup finds an empty home
      try {
        await run.closeAll()
      } finally {
        await volume.detach()
        await run.dispose()
      }
    }
  })

  it('C-RES-2 · KEA_HOME on a path too long for a socket: sockets fall back to /tmp/kea-<uid>/; terminals work, also after a relaunch', async () => {
    const run = newRun({ longPath: true })
    const uid = process.getuid?.()
    expect(run.runDir.startsWith(`/tmp/kea-${uid}/`), `fallback socket directory, not ${run.runDir}`).toBe(true)
    const kea = await run.launch()
    const w = await startWorkload(kea, RATE)
    const holders = run.holders()
    for (const h of holders) {
      expect(h.socket.startsWith(`${run.runDir}/`), `socket of ${h.ptyId} in the fallback directory`).toBe(true)
      expect(fs.statSync(h.socket).isSocket()).toBe(true)
    }
    const seen = await lastOnScreen(kea)
    await kea.select(w.shell)
    await kea.echo('cres2')
    // the next launch finds the same holders through the same fallback directory
    await kea.close()
    const again = await run.launch()
    expect(await again.tabCount()).toBe(2)
    await seamContinuous(run, again, w.counter, { before: seen })
    await again.select(w.shell)
    await again.echo('cres2b')
    holdersUnharmed(run, holders)
    ringContinuity(run, w.counter)
  })

  it(
    'C-RES-8 · simulated sleep: every Kea process and holder stopped longer than any idle timer, then woken: no restart, reload or timeout; the window is told; terminals render and work',
    async () => {
      const run = newRun()
      const kea = await run.launch()
      const w = await startWorkload(kea, RATE)
      const holders = run.holders()
      const before = await kea.processes()
      const seen = await lastOnScreen(kea)
      const watch = await watchTerminals(kea)
      const logged = { main: kea.logLines('main').length, core: kea.logLines('core').length, ptyhost: kea.logLines('ptyhost').length }
      // the whole app at once, as a sleeping machine stops it: main first, so it never sees a child stop
      const order: KeaProcess[] = ['main', 'core', 'ptyhost', 'renderer', 'gpu', 'network']
      const procs = order.flatMap((k) => (before[k] ? [before[k]] : []))
      for (const p of procs) run.signalProcess(p, 'SIGSTOP')
      for (const h of holders) run.signalHolder(h, 'SIGSTOP')
      try {
        // the sleep itself
        await new Promise((r) => setTimeout(r, SLEEP_MS))
      } finally {
        for (const h of holders) run.signalHolder(h, 'SIGCONT')
        for (const p of [...procs].reverse()) run.signalProcess(p, 'SIGCONT')
      }
      // the system tells main through powerMonitor; a stopped process gets no such event, so the test sends main's
      await kea.app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
      await until('the window to be told of the wake', async () => (await watch.received('wake')) >= 1 || undefined)
      await seamContinuous(run, kea, w.counter, { before: seen })
      await kea.select(w.shell)
      await kea.echo('cres8')
      expect(await kea.screen()).toContain(PROMPT)
      const after = await kea.processes()
      for (const k of ['main', 'core', 'ptyhost', 'renderer'] as const) expect(after[k]?.pid, `${k} neither restarted nor reloaded`).toBe(before[k]?.pid)
      expect(await watch.stop(), 'no tab lost and no terminal view rebuilt').toEqual({ fewestTabs: 2, rebuilt: [] })
      // no timeout fired on the gap: nothing was logged at warn or error level after the wake
      for (const proc of ['main', 'core', 'ptyhost'] as const) {
        const late = kea
          .logLines(proc)
          .slice(logged[proc])
          .filter((l) => l.level === 'warn' || l.level === 'error')
        expect(late, `${proc}.log after the wake`).toEqual([])
      }
      holdersUnharmed(run, holders)
      ringContinuity(run, w.counter)
      await kea.assertUnfocused()
    },
    SLEEP_TEST_MS,
  )
})
