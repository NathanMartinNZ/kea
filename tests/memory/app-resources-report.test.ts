// The resource report of every process and main's resources.ndjson line, against the real app (tests/support/app.ts).
// app-report.test.ts checks the terminal rows; this checks the rows of main, core, the renderer and ptyhost that a
// window of shell tabs has, each against ground truth read from outside the process that reports it, and the line main
// writes once an hour (here on demand, through the dev-only test hook), with every process's footprint. L-MEM-20 reads
// ptyhost's rows from its kit registry through the child hook; L-MEM-21 reads them in the line, as ptyhost answers
// main's `report` request, with core up and with core away.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tryLock, type Disposable } from '@kea/kit'
import { AGENTS_STORE, BANNERS_STORE, COMMANDS, CONDITIONS_STORE, isCommandId, KEYBINDINGS_STORE, L, PROJECTS_STORE, SESSIONS_STORE, SETTINGS_GHOSTTY_STORE, SETTINGS_STATUS_STORE, SETTINGS_STORE, TERMINALS_STORE } from '@kea/protocol'
import { KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'

/**
 * The core stores a window follows at rest (app/renderer: the sessions state, the settings mirror with Ghostty's config
 * beside it in features/settings/store.ts, the banner strip, the key bindings in features/commands/bindings.svelte.ts).
 * One more while Settings › Disk is open and one more while Settings › Advanced is open; this test opens neither.
 */
const WINDOW_STORES = [TERMINALS_STORE, PROJECTS_STORE, SESSIONS_STORE, SETTINGS_STORE, SETTINGS_STATUS_STORE, SETTINGS_GHOSTTY_STORE, BANNERS_STORE, CONDITIONS_STORE, AGENTS_STORE, KEYBINDINGS_STORE]

type Report = Record<string, number | Record<string, number>>
type Line = {
  t: string
  level: string
  proc: string
  msg: string
  trigger: string
  reports: Record<string, Report>
  missing: Record<string, string>
  footprint: { t: string; pids: Record<string, number>; bytes: Record<string, number>; errors?: Record<string, string> } | null
}
type TestApi = { resourceLine(): Promise<unknown> }

/** Main's own commands in the menu bar (app/main/src/menu.ts `mainItem`): not the renderer's. */
const MAIN_COMMANDS = new Set(['app.openKea', 'app.closeToMenuBar', 'app.quit'])

const runs: KeaRun[] = []
const locks: Disposable[] = []
afterEach(async () => {
  for (const l of locks.splice(0)) l.dispose()
  for (const r of runs.splice(0)) await r.dispose()
})

function withDeadline<T>(what: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: no answer within ${STEP_MS} ms`)), STEP_MS)))]).finally(() => clearTimeout(timer))
}

/** Main writes one line now (a fresh footprint sample first); returns that line as read back from the file. */
async function resourceLine(kea: Kea): Promise<Line> {
  const fields = await withDeadline('a resources.ndjson line', kea.app.evaluate(() => (globalThis as unknown as { __keaTest: TestApi }).__keaTest.resourceLine()))
  const file = path.join(kea.run.home, 'logs', 'resources.ndjson')
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line)
  const last = lines.at(-1) as Line
  expect(last, 'the newest line is the one the hook wrote').toEqual({ t: last.t, level: 'info', proc: 'main', msg: 'resources', ...(fields as object) })
  return last
}

/** The renderer's commands in the menu bar main built: items with a command id, no native role, not main's own. */
async function menuCommands(kea: Kea): Promise<string[]> {
  const ids = await kea.app.evaluate(({ Menu }) => {
    const out: string[] = []
    const walk = (items: Electron.MenuItem[]) => {
      for (const it of items) {
        if (it.id && !it.role) out.push(it.id)
        if (it.submenu) walk(it.submenu.items)
      }
    }
    walk(Menu.getApplicationMenu()?.items ?? [])
    return out
  })
  return [...new Set(ids.filter((id) => isCommandId(id) && !MAIN_COMMANDS.has(id)))]
}

/** Records in core's file of shell-tab records (`<KEA_HOME>/terminals.json`: the `shells` pseudo-session's). */
function recordIds(run: KeaRun): string[] {
  const doc = JSON.parse(fs.readFileSync(path.join(run.home, 'terminals.json'), 'utf8')) as { records: { ptyId: string }[] }
  return doc.records.map((r) => r.ptyId)
}

/** Drop one record from the file, atomically (temp, then rename), as a lost write would. */
function dropRecord(run: KeaRun, ptyId: string): void {
  const file = path.join(run.home, 'terminals.json')
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: { ptyId: string }[] }
  doc.records = doc.records.filter((r) => r.ptyId !== ptyId)
  fs.writeFileSync(`${file}.test`, JSON.stringify(doc), { mode: 0o600 })
  fs.renameSync(`${file}.test`, file)
}

describe('resource reports and resources.ndjson (app)', () => {
  it('L-MEM-20 · every report row of core, the renderer and main that a window of shell tabs has (and ptyhost’s, through its registry) equals ground truth; main’s resources.ndjson line holds the reports plus each process’s footprint', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    const lost = await kea.newTab()
    await kea.newTab()

    // an orphan: a live holder whose record is gone, found by the reconciliation of a restarted core
    dropRecord(run, lost)
    const oldCore = await kea.pid('core')
    await kea.supervisorRestart('core')
    await kea.restarted('core', oldCore)
    await until('core to list the orphan', () => kea.logLines('core').some((l) => l.msg === 'terminals reconciled' && (l.orphans as string[]).includes(`${lost}:noRecord`)) || undefined)
    await until('the orphan’s tab to close', async () => (await kea.tabCount()) === 2 || undefined)
    const page = await kea.page()
    await until('its view and stream to go', async () => (await page.locator('.terminal-host').count()) === 2 && (await kea.debug<Record<string, number>>('ptyhost', 'kit'))['ptyhost.streams'] === 2 || undefined)

    // ground truth, from outside the processes that report
    const windows = await kea.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    const views = await page.locator('.terminal-host').count()
    const records = recordIds(run)
    const live = run.holders().filter((h) => run.holderAlive(h) && !h.exited)
    const orphans = live.filter((h) => !records.includes(h.ptyId))
    const menu = await menuCommands(kea)
    const procs = await kea.processes()
    expect({ windows, views, records: records.length, live: live.length, orphans: orphans.map((h) => h.ptyId) }).toEqual({ windows: 1, views: 2, records: 2, live: 3, orphans: [lost] })
    // the menu bar holds only commands of the table (not every one of them: some have no menu item), and the
    // counts below are per command of the table, whether or not it has an item
    expect(menu.length, 'the renderer’s commands in the menu bar').toBeGreaterThan(0)
    expect(menu.filter((id) => !COMMANDS.some((c) => c.id === id)), 'menu items that are no command of the table').toEqual([])

    const line = await resourceLine(kea)
    expect(line.trigger).toBe('test')
    expect(line.missing, 'every process answered').toEqual({})
    const { main, core, renderer } = line.reports as Record<'main' | 'core' | 'renderer', Report>

    // main: windows, connection records, menu states, metrics samples (one per footprint run), no request left
    const sampled = kea.logLines('main').filter((l) => l.msg === 'footprint sampled' && (l.at as number) <= Date.parse(line.footprint?.t ?? '')).length
    expect(main['main.windows'], 'main windows').toBe(windows)
    expect(main['main.connections'], 'main connection records').toBe(windows)
    // per window, what its renderer reported for the menu bar: the commands registered now, each of the table (a
    // session's pane adds the viewer's own two, and none is open here), and the keys the person changed (none here)
    const state = await page.evaluate(() => (globalThis as unknown as { __keaProbe: { menuState(): { commands: { id: string }[]; keys?: Record<string, string> } } }).__keaProbe.menuState())
    expect(state.commands.filter((c) => !isCommandId(c.id)).map((c) => c.id), 'reported commands that are no command of the table').toEqual([])
    expect(main['main.menuStates'], 'main menu states').toEqual({ windows, entries: state.commands.length + Object.keys(state.keys ?? {}).length })
    expect(main['main.metricsSamples'], 'main metrics samples').toBe(Math.min(sampled, L.metricsSamplesKept))
    expect(sampled).toBeGreaterThan(0)
    expect(main['main.reportRequests'], 'main report requests in flight').toBe(0)

    // core: one connection scope per window, the control connection to ptyhost, the store subscriptions the renderer
    // holds (the window follows `terminals`, `projects`, `sessions`, `settings`, `settings.status`, `settings.ghostty`,
    // `banners`, `keybindings`, and for status `status.conditions` and `agents`) with
    // nothing pending at rest, its records file, the orphan
    expect(core['core.connections'], 'core connection scopes').toBe(windows)
    expect(core['core.control'], 'core control connection').toBe(procs.ptyhost ? 1 : 0)
    expect(core['core.controlWaiters'], 'core calls waiting for the control port').toBe(0)
    expect(core['core.subscriptions'], 'core store subscriptions').toBe(renderer['renderer.storeSubscriptions'])
    expect(renderer['renderer.storeSubscriptions'], 'renderer store subscriptions').toBe(WINDOW_STORES.length)
    expect(core['core.pendingDeltas'], 'core pending deltas').toBe(0)
    expect(core['core.terminalRecords'], 'core terminal records').toBe(records.length)
    expect(core['core.orphans'], 'core orphans').toBe(orphans.length)

    // renderer: a handler per command registered now (every command of the table but the four a session's pane
    // registers: the viewer's two and its pane keys), the menu state it last reported (as main holds it), the terminal
    // rows of L-MEM-13; every row dotted under `renderer.` like every other process's
    expect(COMMANDS.map((c) => c.id).filter((id) => !state.commands.some((c) => c.id === id)), 'every command of the table registered but the session pane’s four').toEqual(['viewer.open', 'viewer.pinTab', 'view.focusAgent', 'view.focusWork'])
    expect(renderer['renderer.commandHandlers'], 'renderer command handlers').toBe(state.commands.length)
    expect(renderer['renderer.menuStateEntries'], 'renderer menu state').toBe(state.commands.length + Object.keys(state.keys ?? {}).length)
    expect(renderer['renderer.terminals'], 'renderer terminals').toBe(views)
    expect(renderer['renderer.streamPorts'], 'renderer stream ports').toBe(views)
    expect(Object.keys(renderer).filter((k) => !k.startsWith('renderer.')), 'renderer rows not dotted').toEqual([])

    // ptyhost, from its registry: a credit window per attached stream, nothing queued or rebuilding at rest, core's
    // control connection up so no note waits, a socket per live holder (the orphan's too)
    const pty = await kea.debug<Report>('ptyhost', 'kit')
    expect(pty['ptyhost.creditWindows'], 'ptyhost credit windows').toMatchObject({ windows: views })
    expect(pty['ptyhost.ptyQueues'], 'ptyhost per-PTY queues').toMatchObject({ snapshotWaiters: 0 })
    expect(pty['ptyhost.pendingRebuilds'], 'ptyhost pending rebuilds').toEqual({ queued: 0, running: 0 })
    expect(pty['ptyhost.notesQueued'], 'ptyhost notes queued for core').toBe(0)
    expect(pty['ptyhost.control'], 'ptyhost control connection').toBe(1)
    expect(pty['ptyhost.holderSockets'], 'ptyhost holder sockets').toBe(live.length)

    // footprint: every Kea process sampled under its own pid, each with a size
    const fp = line.footprint
    if (!fp) throw new Error('no footprint sample in the line')
    for (const name of ['main', 'core', 'ptyhost', 'renderer', 'gpu'] as const) {
      expect(fp.pids[name], `${name} pid`).toBe(procs[name]?.pid)
      expect(Number.isInteger(fp.bytes[name]) && (fp.bytes[name] as number) > 0, `${name} footprint ${fp.bytes[name]}`).toBe(true)
    }
    expect(fp.errors ?? {}, 'every process read').toEqual({})
  })

  it('L-MEM-21 · ptyhost answers main’s report request: the line holds ptyhost’s rows (connection scopes, credit windows, per-PTY queues, pending rebuilds, notes queued for core) equal to ground truth, and while core is away the notes queued count the notes raised meanwhile', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    await kea.newTab()
    const page = await kea.page()

    /** ptyhost's part of a fresh line, checked against ground truth read from outside ptyhost. */
    const ptyhostPart = async (o: { core: 'up' | 'away'; notes: number }): Promise<Report> => {
      const windows = await kea.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      const views = await page.locator('.terminal-host').count()
      const live = run.holders().filter((h) => run.holderAlive(h) && !h.exited)
      const line = await resourceLine(kea)
      // core held away is not running (each respawn says `locked` and exits): not asked, listed with why
      expect(line.missing, 'who gave no report, and why').toEqual(o.core === 'up' ? {} : { core: 'not running' })
      const r = line.reports.ptyhost
      if (!r) throw new Error('no ptyhost report in the line')
      for (const row of ['connections', 'creditWindows', 'ptyQueues', 'pendingRebuilds', 'notesQueued', 'control', 'streams', 'streamsHeld', 'holderSockets']) {
        expect(r, 'every ptyhost report row').toHaveProperty([`ptyhost.${row}`])
      }
      // one connection scope per window, holding a stream per terminal view; a credit window per stream
      expect(r['ptyhost.connections'], 'ptyhost connection scopes').toEqual({ windows, streams: views })
      expect(r['ptyhost.streams'], 'ptyhost streams').toBe(views)
      expect(r['ptyhost.creditWindows'], 'ptyhost credit windows').toMatchObject({ windows: views })
      expect(r['ptyhost.streamsHeld'], 'ptyhost streams waiting for an adoption').toBe(0)
      // at rest nothing waits in a per-PTY queue, and nothing is rebuilding
      expect(r['ptyhost.ptyQueues'], 'ptyhost per-PTY queues').toEqual({ coalescerBytes: 0, snapshotWaiters: 0, holderWriteBytes: 0 })
      expect(r['ptyhost.pendingRebuilds'], 'ptyhost pending rebuilds').toEqual({ queued: 0, running: 0 })
      expect(r['ptyhost.holderSockets'], 'ptyhost holder sockets').toBe(live.length)
      // core's control connection, and the notes waiting for it
      expect(r['ptyhost.control'], 'ptyhost control connection').toBe(o.core === 'up' ? 1 : 0)
      expect(r['ptyhost.notesQueued'], 'ptyhost notes queued for core').toBe(o.notes)
      return r
    }
    await ptyhostPart({ core: 'up', notes: 0 })

    // core away: killed, and kept from coming back by holding its lock (each respawn says `locked` and exits)
    const lockPath = path.join(run.home, 'run', 'core.lock')
    const away = await kea.signal('core', 'SIGKILL')
    locks.push(await until('core’s lock', () => tryLock(lockPath) ?? undefined))
    await until('ptyhost to lose core’s control connection', async () => (await kea.debug<Report>('ptyhost', 'kit'))['ptyhost.control'] === 0 || undefined)

    // notes raised meanwhile: two titles (OSC 0) in the terminal on screen, one `pty.title` note each
    await kea.enter(`printf '\\033]0;kea-one\\007\\033]0;kea-two\\007'; echo titles-$((40+2))`)
    await kea.waitScreen('the titles printed', (s) => s.includes('titles-42'))
    await until('ptyhost to queue both notes', async () => (await kea.debug<Report>('ptyhost', 'kit'))['ptyhost.notesQueued'] === 2 || undefined)
    await ptyhostPart({ core: 'away', notes: 2 })

    // core back: the queued notes are delivered, nothing waits any more
    locks.pop()?.dispose()
    await kea.restarted('core', away)
    await until('the queued notes delivered', async () => {
      const r = await kea.debug<Report>('ptyhost', 'kit')
      return (r['ptyhost.control'] === 1 && r['ptyhost.notesQueued'] === 0) || undefined
    })
    await ptyhostPart({ core: 'up', notes: 0 })
  })
})
