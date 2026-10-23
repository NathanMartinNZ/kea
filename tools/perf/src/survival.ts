// The survival check: does a holder, and the shell it hosts, survive (1) a graceful quit, (2) the whole app being
// SIGKILLed, and (3) the app being replaced by a new build, and does each relaunch adopt it again and keep typing into
// it? The questions that need a person (Background App Activity, privacy prompts, notifications) are left to manual
// testing.
//
//   node tools/perf/src/survival.ts [--no-build]                                  dev build (dist/app, npm's Electron)
//   node tools/perf/src/survival.ts --app <Kea.app> [--next-app <Kea.app>]       packaged builds
//
// Dev build: Playwright drives the window (CDP) and types into the terminal; step 3 relaunches dist/app with another
// version string (ptyhost then installs and runs a new helper copy).
//
// Packaged builds (`pnpm kea:install --perf-probes --out <dir>`, signed with the local certificate; `--adhoc` only
// checks the harness): a fused Kea accepts no debugger (fuses; app/main/src/switches.ts), so Playwright's `_electron`
// cannot drive it and nothing is typed or clicked. The shell is the one Kea opens by itself on a home with no session
// and no surviving shell (TerminalPane's first shell): a zsh whose rc (a temporary ZDOTDIR) ticks every 0.2 s and asks
// the terminal for the cursor position (CPR, `ESC[6n`). Only ptyhost's mirror answers that query, by writing
// the reply into the holder: the path keystrokes take from ptyhost on. So answers that resume after a relaunch prove
// that the new app's ptyhost was admitted by the old holder and writes into it, and the holder's `refusals`
// must stay 0; while no Kea runs, no answer arrives. Not covered in this mode: the window's own keyboard path
// (renderer → ptyhost), which the dev mode and the e2e suite cover. Step 3 launches `--next-app` (build N+1, built
// separately, e.g. with `--version-suffix n1`), else it is skipped; for an ad-hoc pair it expects the refusal instead
// (an ad-hoc requirement is a cdhash, which changes with every build). `--kea-perf` keeps the window from taking
// keyboard focus, which is why the build must have perf probes.
//
// Uses its own temporary KEA_HOME and kills exactly the holders it spawned (identity checked first).

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { CURRENT_HELPER_DIR } from '../../../app/ptyhost/src/holder/launch.ts'
import { unregisterGiven } from '../../pack/src/unregister.ts'
import { parentPid } from './holders.ts'
import { assertLoginShellAgents, cleanupRun, launchEnv, launchKea, pathWithoutAgents, runAppProcesses, shimFirstRc, signalKnown, TEST_ZSHENV, writeAgentShims, type ProcInfo } from './launch.ts'

const root = path.resolve(import.meta.dirname, '..', '..', '..')
const dist = path.join(root, 'dist/app')
declare const __keaPerf: { ready(): boolean; attached(): Promise<void>; waitText(t: string, ms?: number): Promise<number>; screen(): string }

export type Holder = { ptyId: string; sessionId: string; pid: number; pidStartTime: number; childPid: number; refusals: number }
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The holders of `home` that have not exited, from their state files. */
export function holders(home: string): Holder[] {
  const out: Holder[] = []
  const dir = path.join(home, 'sessions')
  if (!fs.existsSync(dir)) return out
  for (const s of fs.readdirSync(dir))
    for (const f of fs.readdirSync(path.join(dir, s)))
      if (f.endsWith('.json') && !f.startsWith('.')) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, s, f), 'utf8')) as Holder & { exited: boolean }
        if (!j.exited) out.push({ ptyId: j.ptyId, sessionId: j.sessionId, pid: j.pid, pidStartTime: j.pidStartTime, childPid: j.childPid, refusals: j.refusals })
      }
  return out
}

function ringFile(home: string, ptyId: string): string | null {
  const dir = path.join(home, 'sessions')
  for (const s of fs.readdirSync(dir)) {
    const f = path.join(dir, s, `${ptyId}.ring`)
    if (fs.existsSync(f)) return f
  }
  return null
}

export function ringSeq(home: string, ptyId: string): number {
  const f = ringFile(home, ptyId)
  return f ? Number(fs.readFileSync(f).readBigUInt64LE(24)) : -1
}

/** The ring's bytes from `from` (clamped to what it still holds) to its latest seq (layout: kea-helper README). */
export function ringText(home: string, ptyId: string, from: number): { latest: number; text: string } {
  const f = ringFile(home, ptyId)
  if (!f) return { latest: -1, text: '' }
  const fd = fs.openSync(f, 'r')
  try {
    const h = Buffer.alloc(64)
    fs.readSync(fd, h, 0, 64, 0)
    const cap = Number(h.readBigUInt64LE(8))
    const earliest = Number(h.readBigUInt64LE(16))
    const latest = Number(h.readBigUInt64LE(24))
    const out = Buffer.alloc(Math.max(0, latest - Math.max(from, earliest)))
    for (let s = Math.max(from, earliest), i = 0; s < latest; ) {
      const off = s % cap
      const n = Math.min(latest - s, cap - off)
      fs.readSync(fd, out, i, n, 64 + off)
      s += n
      i += n
    }
    return { latest, text: out.toString('latin1') }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Keep the run off the user's own setup: a temporary ZDOTDIR holding `zshrc` (core's login-shell probe would
 * otherwise source their zsh files and put a real agent CLI back on PATH; appEnv drops it from the inherited one), the
 * run's own HOME (launchEnv: core's fallback environment adds `~/.local/bin`) and the shell pseudo-agent as the default
 * agent, as tests/support/app.ts's KeaRun does. No agent session is started here, but Kea detects every agent CLI at
 * each start, and one installed in a folder the login shell or core's fallback environment adds by itself
 * (/opt/homebrew/bin, where npm puts Command Code) cannot be taken off the PATH: the run's own folder of fake-agent
 * shims comes first instead, put first again by the ZDOTDIR after path_helper. Before Kea starts, both environments
 * must find every agent command there and nowhere else (`assertLoginShellAgents`). Real CLIs run only in the contract
 * suite.
 */
export function harnessEnv(home: string, zshrc: string): Record<string, string> {
  const zdotdir = path.join(home, 's7-zdotdir')
  fs.mkdirSync(zdotdir, { recursive: true })
  const shims = agentShims(home)
  writeAgentShims(shims)
  fs.writeFileSync(path.join(zdotdir, '.zshenv'), TEST_ZSHENV)
  fs.writeFileSync(path.join(zdotdir, '.zprofile'), shimFirstRc(shims))
  // before the caller's lines: the packaged mode's rc never returns in the shell tab
  fs.writeFileSync(path.join(zdotdir, '.zshrc'), `${shimFirstRc(shims)}${zshrc}`)
  fs.writeFileSync(path.join(home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'shell' } }, null, 2)}\n`)
  const env = launchEnv({ home, env: { SHELL: '/bin/zsh', ZDOTDIR: zdotdir, PATH: `${shims}:${pathWithoutAgents()}` } })
  assertLoginShellAgents(env, shims)
  return env
}

/** The run's folder of fake agents (`harnessEnv` fills it). */
const agentShims = (home: string): string => path.join(home, 's7-agent-bin')

/** The parent of `pid` (`kea-helper procs`, as every harness reads processes), or -1 when it is gone. */
function ppid(pid: number): number {
  return parentPid(pid) ?? -1
}

/** Electron processes of this run (launch.ts: by KEA_HOME or userData on their command line). */
function appProcesses(home: string, packaged: boolean): ProcInfo[] {
  return runAppProcesses(home, { packaged })
}

type Check = (what: string, ok: boolean, detail?: string) => void

function report(home: string, rows: string[], e: unknown): void {
  if (e) {
    console.error(String((e as Error).message ?? e))
    for (const f of ['ptyhost', 'core', 'main']) {
      const p = path.join(home, 'logs', `${f}.log`)
      if (fs.existsSync(p)) console.error(`--- ${f}.log (tail) ---\n${fs.readFileSync(p, 'utf8').split('\n').slice(-25).join('\n')}`)
    }
    process.exitCode = 1
  }
  console.log('\n| Check | Result | Detail |\n|---|---|---|')
  for (const r of rows) console.log(r)
}

// ── dev build: Playwright ───────────────────────────────────────────────────────────

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchKea({ dist, home, env: harnessEnv(home, ''), agents: agentShims(home) })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof __keaPerf !== 'undefined' && __keaPerf.ready(), null, { timeout: 30_000 })
  return { app, page }
}

/** Make the tab of `ptyId` active and wait for its first snapshot. */
async function focusPty(page: Page, ptyId: string): Promise<void> {
  try {
    await page.waitForSelector(`.terminal-host[data-pty="${ptyId}"]`, { state: 'attached', timeout: 15_000 })
  } catch {
    const ptys = await page.evaluate(() => [...document.querySelectorAll('.terminal-host')].map((e) => e.getAttribute('data-pty')))
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.tab')].map((e) => e.textContent))
    throw new Error(`no pane for ${ptyId}; panes ${JSON.stringify(ptys)}, tabs ${JSON.stringify(tabs)}`)
  }
  const i = await page.evaluate((id) => [...document.querySelectorAll('.terminal-host')].findIndex((e) => e.getAttribute('data-pty') === id), ptyId)
  await page.locator('.tab:not(.add)').nth(i).click()
  await page.evaluate(() => __keaPerf.attached())
}

async function typeAndSee(page: Page, tag: string): Promise<number> {
  const t0 = Date.now()
  await page.keyboard.type(`echo ${tag}-$((40+2))`)
  await page.keyboard.press('Enter')
  try {
    await page.evaluate((t) => __keaPerf.waitText(t, 15_000), `${tag}-42`)
  } catch (e) {
    throw new Error(`${(e as Error).message}\n--- screen ---\n${await page.evaluate(() => __keaPerf.screen())}`)
  }
  return Date.now() - t0
}

async function mainDev(home: string, check: Check): Promise<void> {
  if (!process.argv.includes('--no-build')) execFileSync(process.execPath, [path.join(root, 'tools/build.ts'), '--release'], { stdio: 'inherit' })
  const pkgFile = path.join(dist, 'package.json')
  const pkg = fs.readFileSync(pkgFile, 'utf8')
  let app: ElectronApplication | null = null
  try {
    // 1. a shell with a ticking child
    ;({ app } = await launch(home))
    let page = await app.firstWindow()
    await page.evaluate(() => __keaPerf.attached())
    // the shell is ready once it has drawn its prompt (whatever the person's prompt looks like)
    await page.waitForFunction(() => __keaPerf.screen().trim().length > 0, null, { timeout: 15_000 })
    await page.keyboard.type('while true; do date +%s; sleep 0.2; done')
    await page.keyboard.press('Enter')
    // the loop is running: a timestamp from now on is on screen
    await page.evaluate((t) => __keaPerf.waitText(t, 10_000), String(Math.floor(Date.now() / 1000) + 1)).catch(async () => {
      throw new Error(`the ticking loop did not start\n--- screen ---\n${await page.evaluate(() => __keaPerf.screen())}`)
    })
    const [h] = holders(home)
    if (!h) throw new Error('no holder started')
    check('holder daemonised (parent is launchd)', ppid(h.pid) === 1, `holder ${h.pid}, parent ${ppid(h.pid)}`)

    // 2. graceful quit
    await app.close()
    app = null
    const s0 = ringSeq(home, h.ptyId)
    await sleep(1500)
    check('graceful quit: holder and shell alive, output still flowing into the ring', alive(h.pid) && alive(h.childPid) && ringSeq(home, h.ptyId) > s0, `ring +${ringSeq(home, h.ptyId) - s0} B in 1.5 s`)
    ;({ app } = await launch(home))
    page = await app.firstWindow()
    await focusPty(page, h.ptyId)
    await page.keyboard.press('Control+C')
    check('relaunch after quit: adopted, typing echoes', true, `echo in ${await typeAndSee(page, 'S7-QUIT')} ms`)

    // 3. crash: SIGKILL main; its helpers go with it
    await page.keyboard.type('while true; do date +%s; sleep 0.2; done')
    await page.keyboard.press('Enter')
    const mainPid = app.process().pid as number
    process.kill(mainPid, 'SIGKILL')
    app = null
    await sleep(2000)
    const stray = appProcesses(home, false)
    for (const p of stray) signalKnown(p, 'SIGKILL')
    const s1 = ringSeq(home, h.ptyId)
    await sleep(1000)
    check('SIGKILL of the app: no app process outlives main by 2 s', stray.length === 0, `${stray.length} outlived it`)
    check('SIGKILL of the app: holder and shell alive, output still flowing', alive(h.pid) && alive(h.childPid) && ringSeq(home, h.ptyId) > s1)
    ;({ app } = await launch(home))
    page = await app.firstWindow()
    await focusPty(page, h.ptyId)
    await page.keyboard.press('Control+C')
    check('relaunch after the crash: adopted, typing echoes', true, `echo in ${await typeAndSee(page, 'S7-CRASH')} ms`)
    await app.close()
    app = null

    // 4. replaced by a new build (another version string: ptyhost installs and runs a new helper copy)
    fs.writeFileSync(pkgFile, pkg.replace(/"version": "([^"]+)"/, '"version": "$1-s7"'))
    ;({ app } = await launch(home))
    page = await app.firstWindow()
    await focusPty(page, h.ptyId)
    check('new build: the old holder is adopted, typing echoes', alive(h.pid), `echo in ${await typeAndSee(page, 'S7-NEWBUILD')} ms; helper copies: ${fs.readdirSync(path.join(home, 'bin')).length}`)
  } finally {
    await app?.close().catch(() => undefined)
    fs.writeFileSync(pkgFile, pkg)
  }
}

// ── packaged builds: no debugger, the shell probes the terminal ─────────────────────

export const TICK = 'S7-TICK'
// zsh rc for the shell tab (only the interactive tab: core's `zsh -l -i -c` environment probe skips it). Non-canonical
// input with a 0.5 s read timeout; anything read that contains the CPR's final `R` counts as an answer.
export const ZSHRC = `# tools/perf/src/survival.ts --app: tick and ask the terminal for the cursor position (answered only by Kea's mirror)
if [[ -o interactive && -z $ZSH_EXECUTION_STRING ]]; then
  stty -echo -icanon min 0 time 5
  while true; do
    printf '\\033[6n'
    r=$(dd bs=64 count=1 2>/dev/null)
    if [[ $r == *R* ]]; then print '${TICK} ok'; else print '${TICK} none'; fi
    sleep 0.2
  done
fi
`

export type Running = { proc: ChildProcess; exited: Promise<number | null>; stderr: () => string }

/**
 * Start a packaged perf-probe build on `home` with the run's environment (`harnessEnv`, which has checked that no
 * real agent CLI is in reach). `--kea-perf` keeps its window from taking the keyboard; `args`: more switches.
 */
export function launchApp(app: string, home: string, env: NodeJS.ProcessEnv, args: readonly string[] = []): Running {
  const proc = spawn(path.join(app, 'Contents', 'MacOS', 'Kea'), [`--kea-home=${home}`, '--kea-perf', ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  proc.stderr?.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-4000)))
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)))
  return { proc, exited, stderr: () => err }
}

/** Wait until the ring holds an answered tick after seq `from`; the app must keep running meanwhile. */
export async function answered(home: string, ptyId: string, from: number, app: Running, ms: number): Promise<number> {
  const t0 = Date.now()
  let gone = false
  void app.exited.then(() => (gone = true))
  while (Date.now() - t0 < ms) {
    if (ringText(home, ptyId, from).text.includes(`${TICK} ok`)) return Date.now() - t0
    if (gone) throw new Error(`Kea exited (code ${app.proc.exitCode}) before answering: ${app.stderr().trim() || 'no stderr'}`)
    await sleep(100)
  }
  throw new Error(`no answered tick within ${ms} ms; ring since then: ${JSON.stringify(ringText(home, ptyId, from).text.slice(-300))}`)
}

export async function quit(app: Running): Promise<number | null> {
  app.proc.kill('SIGTERM') // Electron quits gracefully on SIGTERM (before-quit → children shut down → exit 0)
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Kea did not quit within 15 s of SIGTERM')), 15_000)))
  try {
    return await Promise.race([app.exited, late])
  } finally {
    clearTimeout(timer)
  }
}

/** The version a packaged build reports (`app.getVersion()`), from its Info.plist. */
export function appVersion(app: string): string {
  // os-ok: perf measures the macOS reference machine
  return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
}

/** The file every holder starts from, whatever the build: `<home>/bin/current/kea-helper`. */
export function currentHelper(home: string): string {
  return path.join(home, 'bin', CURRENT_HELPER_DIR, 'kea-helper')
}

/** The first holder that appears on `home`: the shell Kea opens by itself on a home with no session. */
export async function firstHolder(home: string, app: Running, ms: number): Promise<Holder> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const [h] = holders(home)
    if (h) return h
    if (app.proc.exitCode !== null || app.proc.signalCode !== null) throw new Error(`Kea exited (code ${app.proc.exitCode ?? app.proc.signalCode}): ${app.stderr().trim() || 'no stderr'} (a packaged build needs --perf-probes for --kea-perf)`)
    await sleep(100)
  }
  throw new Error(`no holder within ${ms} ms`)
}

async function mainPackaged(home: string, check: Check, appN: string, appN1: string | null): Promise<void> {
  for (const a of [appN, appN1]) if (a && !fs.existsSync(path.join(a, 'Contents', 'MacOS', 'Kea'))) throw new Error(`${a} is not a Kea.app`)
  const env = harnessEnv(home, ZSHRC)
  const ANSWER_MS = 30_000
  const REFUSAL_WAIT_MS = 10_000 // well past ptyhost's HELLO wait: a refused attach has given up by then
  let app: Running | null = null
  try {
    // 1. the shell tab ticks; its queries are answered
    app = launchApp(appN, home, env)
    const h = await firstHolder(home, app, ANSWER_MS)
    const first = await answered(home, h.ptyId, 0, app, ANSWER_MS)
    check('holder daemonised (parent is launchd)', ppid(h.pid) === 1, `holder ${h.pid}, parent ${ppid(h.pid)}`)
    check('shell ticking, its terminal queries answered by the mirror', true, `first answer after ${first} ms`)

    // 2. graceful quit: output keeps flowing, nothing answers
    const code = await quit(app)
    app = null
    await sleep(1000) // a reply in flight at the quit is read by then
    const q = ringText(home, h.ptyId, ringSeq(home, h.ptyId))
    await sleep(1500)
    const quiet = ringText(home, h.ptyId, q.latest)
    check('graceful quit (SIGTERM): exit 0, holder and shell alive, output still flowing', code === 0 && alive(h.pid) && alive(h.childPid) && quiet.latest > q.latest, `exit ${code}; ring +${quiet.latest - q.latest} B in 1.5 s`)
    check('while no Kea runs, no query is answered', !quiet.text.includes(`${TICK} ok`) && quiet.text.includes(`${TICK} none`), `${quiet.text.split(`${TICK} none`).length - 1} unanswered ticks`)
    let from = ringSeq(home, h.ptyId)
    app = launchApp(appN, home, env)
    check('relaunch after quit: adopted, queries answered again', true, `after ${await answered(home, h.ptyId, from, app, ANSWER_MS)} ms`)

    // 3. crash: SIGKILL main; its helpers go with it
    app.proc.kill('SIGKILL')
    await app.exited
    app = null
    await sleep(2000)
    const stray = appProcesses(home, true)
    for (const p of stray) signalKnown(p, 'SIGKILL')
    const s1 = ringSeq(home, h.ptyId)
    await sleep(1000)
    check('SIGKILL of the app: no app process outlives main by 2 s', stray.length === 0, `${stray.length} outlived it`)
    check('SIGKILL of the app: holder and shell alive, output still flowing', alive(h.pid) && alive(h.childPid) && ringSeq(home, h.ptyId) > s1)
    from = ringSeq(home, h.ptyId)
    app = launchApp(appN, home, env)
    check('relaunch after the crash: adopted, queries answered again', true, `after ${await answered(home, h.ptyId, from, app, ANSWER_MS)} ms`)
    await quit(app)
    app = null

    // 4. replaced by build N+1 (separately built and signed): build N's holder must admit its ptyhost
    if (!appN1) {
      check('new build (--next-app)', true, 'skipped: no --next-app given')
      return
    }
    // An ad-hoc pair cannot pass: an ad-hoc requirement is a cdhash, which changes with every build. The harness
    // then expects the refusal instead: a holder admits only a client that meets the requirement it was spawned with.
    const adhoc = [appN, appN1].some((a) => /^Signature=adhoc$/m.test(spawnSync('/usr/bin/codesign', ['-dv', a], { encoding: 'utf8' }).stderr)) // os-ok: perf measures the macOS reference machine
    from = ringSeq(home, h.ptyId)
    app = launchApp(appN1, home, env)
    let ms: number | null = null
    try {
      ms = await answered(home, h.ptyId, from, app, adhoc ? REFUSAL_WAIT_MS : ANSWER_MS)
    } catch (e) {
      if (!adhoc) throw e
    }
    const refusals = holders(home).find((x) => x.ptyId === h.ptyId)?.refusals
    const copies = fs.readdirSync(path.join(home, 'bin')).join(', ')
    if (adhoc) {
      check("ad-hoc build N+1: build N's holder refuses it (ad-hoc identity changes per build)", ms === null && alive(h.pid) && (refusals ?? 0) > 0, `refusals: ${refusals}; helper copies: ${copies}`)
    } else {
      check('new build: the old holder admits it, queries answered again', ms !== null && alive(h.pid), `after ${ms} ms; helper copies: ${copies}`)
      check("the holder refused no client (its json's refusals)", refusals === 0, `refusals: ${refusals}`)
    }
  } finally {
    if (app) await quit(app).catch(() => app?.proc.kill('SIGKILL'))
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────

function option(name: string): string | null {
  const i = process.argv.indexOf(name)
  if (i < 0) return null
  const v = process.argv[i + 1]
  if (!v) throw new Error(`${name} needs a path`)
  return path.resolve(v)
}

async function main(): Promise<void> {
  const appN = option('--app')
  const appN1 = option('--next-app')
  if (appN1 && !appN) throw new Error('--next-app needs --app (a dev build and a packaged one never share holders)')
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-s7-')))
  const rows: string[] = []
  const check: Check = (what, ok, detail = '') => {
    rows.push(`| ${what} | ${ok ? 'yes' : '**no**'} | ${detail} |`)
    if (!ok) process.exitCode = 1
  }
  let error: unknown = null
  try {
    if (appN) await mainPackaged(home, check, appN, appN1)
    else await mainDev(home, check)
  } catch (e) {
    error = e
  } finally {
    report(home, rows, error)
    const cleaned = cleanupRun(home, { packaged: !!appN })
    for (const s of cleaned.holders.skipped) if (s.why !== 'gone before the signal') console.error(`not killing pid ${s.pid}: ${s.why}`)
    for (const line of unregisterGiven([appN, appN1])) console.log(line)
  }
}

// run as a script (`node tools/perf/src/survival.ts …`), not when a test imports the pieces above
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main()
