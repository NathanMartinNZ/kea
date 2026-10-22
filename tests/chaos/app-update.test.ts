// A new build installed over running sessions.
//
// The end-to-end update (C-UPD-1): two builds signed with the local certificate, the second installed over the first by
// `tools/install.ts` itself while the first runs with a terminal. The install target is a folder of the test's own
// (`--install-to`: never /Applications) and the home a temp KEA_HOME. A fused, packaged Kea takes no debugger, so
// nothing is typed: as in tools/perf/src/survival.ts, whose pieces this uses, the shell Kea opens by itself on an empty
// home asks its terminal for the cursor position five times a second, and only ptyhost's mirror answers, by writing
// into the holder, which is the path a keystroke takes from ptyhost on. Both builds are perf-probe builds started with
// `--kea-perf`, so their windows never take the keyboard.
//
// The install's refusal (C-UPD-6): a Kea that does not quit when asked (its main process stopped) is left with its app
// as it was.
//
// The same update on the dev build the other chaos suites launch, where the window can be driven (C-UPD-5): an agent
// mid-turn is typed into after the update, its hooks (which still call build N's helper copy) reach build N+1's core,
// a new terminal runs build N+1's copy, and build N's copy goes when its last holder has ended.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { runDir } from '@kea/kit'
import { L } from '@kea/protocol'
import { BACKUP_EXCLUDE_ATTR } from '@kea/core/src/os/darwin.ts'
import { auditNetLog } from '../../tools/pack/src/audit.ts'
import { packOs } from '../../tools/pack/src/os/index.ts'
import { needOrSkip } from '../support/skip.ts'
import { bundleProcesses } from '../../tools/pack/src/running.ts'
import { APP_ID } from '../../tools/pack/src/target.ts'
import { registeredNow, unregisterOwnApp } from '../../tools/pack/src/unregister.ts'
import { processTable } from '../../tools/pack/src/processes.ts'
import { killOwnHolders } from '../../tools/perf/src/holders.ts'
import { cleanupRun, processInfo, repoRoot } from '../../tools/perf/src/launch.ts'
import { answered, appVersion, currentHelper, firstHolder, harnessEnv, holders, launchApp, quit, ringSeq, ringText, TICK, ZSHRC, type Holder, type Running } from '../../tools/perf/src/survival.ts'
import { homePrefix, KeaRun, STEP_MS, testAppDist, until, type Kea } from '../support/app.ts'
import { holdersUnharmed, isAlive } from '../support/app-chaos.ts'
import { RELEASE_HELPER } from '../support/holders.ts'
import { agentHooks, claudeByDefault, fakeClaude } from '../support/app-fake-agent.ts'
import { addProject, demoRepo, startSession, tabOf, waitRow } from '../support/app-sessions.ts'

const run = promisify(execFile)
/** This user's processes, listed by the release helper the install built (`kea-helper procs`), as the install lists them. */
const packTable = () => processTable(RELEASE_HELPER)
const INSTALL = path.join(repoRoot, 'tools', 'install.ts')
/** Two signed builds, four launches of a packaged app. */
const PACKAGED_MS = 420_000
const ANSWER_MS = 30_000

const cleanups: (() => unknown)[] = []
const runs: KeaRun[] = []
afterEach(async () => {
  // every clean-up runs, also after one that found something left: the first failure is the test's
  const failed: unknown[] = []
  for (const c of [...runs.splice(0).map((r) => () => r.dispose()), ...cleanups.splice(0).reverse()]) await Promise.resolve().then(c).catch((e: unknown) => failed.push(e))
  if (failed.length) throw failed[0]
})

/** A folder of this run's in the temp directory (the suites' teardown fails the run if one is left). */
function tempDir(what: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${homePrefix()}${what}-`)))
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

/**
 * `tools/install.ts` as `pnpm kea:install` runs it, into a test target only. What it printed (the plan and each step)
 * comes back; a failed install throws with it.
 */
async function install(target: string, args: string[]): Promise<string> {
  if (!target.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error(`${target} is not a folder of this test`)
  try {
    const r = await run(process.execPath, [INSTALL, '--perf-probes', '--install-to', target, ...args], { cwd: repoRoot, maxBuffer: 32 << 20, timeout: 240_000 })
    return r.stdout
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message: string }
    throw new Error(`tools/install.ts failed: ${x.message}\n${(x.stdout ?? '').slice(-3000)}\n${(x.stderr ?? '').slice(-3000)}`)
  }
}

/**
 * The end of a packaged run: everything of it killed and removed (`cleanupRun`), and its build taken out of
 * LaunchServices before its folder is deleted. Then nothing of it is left:
 *   - its home is gone, and so is the folder its sockets were in. A home in the temp directory under this suite's
 *     `…upd-` name is too long for `<home>/run`, so they were under /tmp/kea-<uid>, where a killed holder leaves its
 *     socket's name behind;
 *   - macOS registered the build when it was launched, by its path, as Kea (`dev.kea.app`): no path of this run's
 *     work folder is registered any more, so nothing that asks for Kea by its id can be given a test build.
 */
function endPackagedRun(home: string, work: string, app: string): void {
  cleanupRun(home, { packaged: true })
  const unregistered = unregisterOwnApp(app, work)
  expect(runDir(home), 'this home’s sockets are outside it').not.toBe(path.join(home, 'run'))
  expect([home, runDir(home)].filter((d) => fs.existsSync(d)), 'left behind by the run').toEqual([])
  expect(unregistered, 'the build taken out of LaunchServices').toEqual({ done: true, app })
  expect(registeredNow(APP_ID).filter((r) => r.path.startsWith(work + path.sep)), 'this run’s builds still registered with LaunchServices').toEqual([])
}

/** The executable a pid runs, in full (`ps comm`); null once it is gone. */
const executableOf = (pid: number): string | null => processInfo(pid)?.comm ?? null

/** Core's log lines of `home` (NDJSON). */
function coreLog(home: string): { msg: string; [k: string]: unknown }[] {
  const f = path.join(home, 'logs', 'core.log')
  if (!fs.existsSync(f)) return []
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as { msg: string }]
      } catch {
        return []
      }
    })
}

/** What core said of the earlier builds' helper copies each time it looked (agents/helper.ts). */
const copyLooks = (home: string) => coreLog(home).filter((l) => l.msg === 'helper copies of earlier builds') as unknown as { removed: string[]; kept: { name: string; why: string }[] }[]

async function excludedFromBackup(p: string): Promise<boolean> {
  return run('/usr/bin/xattr', ['-p', BACKUP_EXCLUDE_ATTR, p]).then( // os-ok: macOS test tool, called only by the macOS-only update tests
    () => true,
    () => false,
  )
}

describe('a new build installed over running sessions', () => {
  it(
    'C-UPD-1 · build N runs a terminal; the install tool puts build N+1 in its place (Kea asked to quit, swapped, nothing left over); the old holder runs on from bin/current, admits N+1 and is written to again; a new terminal runs N+1’s helper, renamed over bin/current; no per-build copy is left behind',
    async (ctx) => {
      needOrSkip(ctx, packOs.installPlace) // tools/install.ts installs a macOS build (Linux: packages, install.sh)
      const work = tempDir('upd-work')
      const target = path.join(work, 'target')
      fs.mkdirSync(target)
      const app = path.join(target, 'Kea.app')
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${homePrefix()}upd-`)))
      let kea: Running | null = null
      cleanups.push(async () => {
        if (kea && kea.proc.exitCode === null && kea.proc.signalCode === null) await quit(kea).catch(() => kea?.proc.kill('SIGKILL'))
        endPackagedRun(home, work, app)
      })

      // ── build N, installed where nothing is yet
      const first = await install(target, ['--out', path.join(work, 'build-n')])
      expect(first).toMatch(/Nothing is installed at .*\/target\/Kea\.app yet\./)
      expect(first).toMatch(/Kea was not running, so it is not opened\./)
      const versionN = appVersion(app)
      const env = harnessEnv(home, ZSHRC)
      // Chromium's own record of what this launch asks of the network (Kea itself asks for nothing)
      const netLog = path.join(work, 'net-log.json')
      kea = launchApp(app, home, env, [`--log-net-log=${netLog}`])
      const a: Holder = await firstHolder(home, kea, ANSWER_MS)
      await answered(home, a.ptyId, 0, kea, ANSWER_MS)
      const current = currentHelper(home)
      const shippedN = fs.readFileSync(path.join(app, 'Contents', 'Resources', 'kea-helper'))
      expect(executableOf(a.pid), 'the holder runs from the newest helper’s stable path, not from the bundle').toBe(current)
      expect(fs.readFileSync(current).equals(shippedN), 'bin/current holds build N’s helper').toBe(true)
      expect(processInfo(a.pid)?.ppid, 'daemonised').toBe(1)
      // as the installed app does it: Kea's own folders are out of Time Machine (the temp home's)
      await until('the home’s folders to be excluded from Time Machine', async () => (await Promise.all(['run', 'sessions', 'bin', 'logs'].map((d) => excludedFromBackup(path.join(home, d))))).every(Boolean) || undefined)
      expect(await excludedFromBackup(home)).toBe(false)
      const runningPid = kea.proc.pid

      // ── build N+1, installed over the running N by the tool itself
      const second = await install(target, ['--version-suffix', 'n1', '--out', path.join(work, 'build-n1')])
      // found by its bundle path, with its home; its window never had the keyboard (`--kea-perf`)
      expect(second).toContain(`Kea is running from it (pid ${runningPid}, home ${home}): its window is open, behind another app.`)
      expect(second).toContain(`1 terminal is running in the background under ${home}, started by 1 build:`)
      expect(second).toContain(`${versionN} (bin/current): 1`)
      expect(second).toMatch(/Kea is asked to quit completely, and given \d+ s\. Your sessions keep running without it\. If it does not quit, nothing is replaced\./)
      // the plan is said before anything is built, and looked at again right before the install
      expect(second.indexOf('What happens next')).toBeGreaterThan(0)
      expect(second.indexOf('What happens next')).toBeLessThan(second.indexOf('── release build'))
      expect(second.indexOf('Nothing has changed since the look above.')).toBeGreaterThan(second.indexOf('── verify'))
      expect(second).toMatch(/Kea has quit \(\d+\.\d s\)\. Its sessions run on\./)
      expect(second).toContain(`Replaced ${app}.`)
      expect(second).toContain('Kea is not opened again: this is a test target.')
      expect(await kea.exited, 'Kea quit cleanly when the tool asked').toBe(0)
      kea = null
      // from its start to its quit, with a terminal open, build N asked nothing of the network
      const net = auditNetLog(fs.readFileSync(netLog, 'utf8'))
      expect(net.problems, `requests of Kea's own (${net.events} net log events)`).toEqual([])
      expect(bundleProcesses(packTable(), app), 'nothing runs from the app').toEqual([])
      expect(fs.readdirSync(target), 'no staging copy, no previous app').toEqual(['Kea.app'])
      expect(appVersion(app)).toBe(`${versionN}-n1`)
      // the session ran on: same holder, same shell, output flowing, and nobody answers its queries
      expect(isAlive(a.pid) && isAlive(a.childPid)).toBe(true)
      expect(executableOf(a.pid)).toBe(current)
      const quiet = ringSeq(home, a.ptyId)
      await until('three ticks with no Kea to answer', () => ringText(home, a.ptyId, quiet).text.split(`${TICK} none`).length > 3 || undefined)
      const relaunchFrom = ringSeq(home, a.ptyId)

      // ── N+1 from the same path: the old holder admits it (same certificate) and is written to again
      kea = launchApp(app, home, env)
      await answered(home, a.ptyId, relaunchFrom, kea, ANSWER_MS)
      expect(holders(home).find((h) => h.ptyId === a.ptyId)?.refusals, 'the holder refused no client').toBe(0)
      // the tool's quit was a complete, clean one: build N closed its database, so build N+1 had no reason to doubt it
      expect(coreLog(home).filter((l) => l.msg === 'database open').at(-1)).toMatchObject({ fresh: false, setAside: null, integrityChecked: false })
      const shippedN1 = fs.readFileSync(path.join(app, 'Contents', 'Resources', 'kea-helper'))
      expect(shippedN1.equals(shippedN), 'build N+1 ships another helper file (its own signature)').toBe(false)
      // no terminal started yet by N+1: bin/current is still build N's, and no agent ever ran, so no copy for hooks
      expect(fs.readFileSync(current).equals(shippedN)).toBe(true)
      expect(fs.readdirSync(path.join(home, 'bin'))).toEqual(['current'])
      expect(executableOf(a.pid)).toBe(current)
      expect(await quit(kea)).toBe(0)
      kea = null

      // ── the old terminal ends while Kea is away; the next launch opens a shell of its own, on N+1's copy
      const killed = killOwnHolders(home)
      expect(killed.killed).toContain(a.pid)
      await until('the old holder to be gone', () => !isAlive(a.pid) || undefined)
      kea = launchApp(app, home, env)
      const b = await until('a new terminal', () => holders(home).find((h) => h.ptyId !== a.ptyId))
      await answered(home, b.ptyId, 0, kea, ANSWER_MS)
      expect(executableOf(b.pid), 'a new terminal starts from the same stable path').toBe(current)
      expect(fs.readFileSync(current).equals(shippedN1), 'build N+1’s helper, renamed over build N’s').toBe(true)
      expect(fs.readdirSync(path.join(home, 'bin'))).toEqual(['current'])
      expect(fs.readdirSync(path.dirname(current)), 'no temp file left').toEqual(['kea-helper'])
      expect(await quit(kea)).toBe(0)
      kea = null
    },
    PACKAGED_MS,
  )

  it(
    'C-UPD-6 · a Kea that does not quit: the install tool waits its time limit, then stops with the old app as it was (same build, signature intact, no staging copy left) and the session untouched; Kea quits once it can and nothing else changed',
    async (ctx) => {
      needOrSkip(ctx, packOs.installPlace) // tools/install.ts installs a macOS build (Linux: packages, install.sh)
      const work = tempDir('upd-work')
      const target = path.join(work, 'target')
      fs.mkdirSync(target)
      const app = path.join(target, 'Kea.app')
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${homePrefix()}upd-`)))
      let kea: Running | null = null
      cleanups.push(async () => {
        if (kea && kea.proc.exitCode === null && kea.proc.signalCode === null) {
          kea.proc.kill('SIGCONT')
          await quit(kea).catch(() => kea?.proc.kill('SIGKILL'))
        }
        endPackagedRun(home, work, app)
      })
      await install(target, ['--out', path.join(work, 'build-n')])
      const versionN = appVersion(app)
      kea = launchApp(app, home, harnessEnv(home, ZSHRC))
      const a = await firstHolder(home, kea, ANSWER_MS)
      await answered(home, a.ptyId, 0, kea, ANSWER_MS)
      const main = processInfo(kea.proc.pid as number)
      expect(main?.comm).toBe(path.join(app, 'Contents', 'MacOS', 'Kea'))

      // Kea's main process is stopped: the tool's request to quit stays pending for as long as it is
      kea.proc.kill('SIGSTOP')
      const t0 = Date.now()
      const refused = await install(target, ['--version-suffix', 'n1', '--out', path.join(work, 'build-n1')]).then(
        () => null,
        (e: Error) => e.message,
      )
      expect(refused, 'the install must fail').not.toBeNull()
      expect(refused).toMatch(new RegExp(`Kea did not quit within ${L.installQuitTimeoutMs / 1000} s \\(still running from the app: .*${kea.proc.pid} Kea`))
      expect(refused).toContain(`Nothing was replaced: ${app} is as it was.`)
      expect(refused).not.toContain('Replaced')
      expect(Date.now() - t0, 'it waited the whole time limit').toBeGreaterThanOrEqual(L.installQuitTimeoutMs)
      // the old app as it was, nothing beside it
      expect(fs.readdirSync(target)).toEqual(['Kea.app'])
      expect(appVersion(app)).toBe(versionN)
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]) // os-ok: macOS test tool, called only by the macOS-only update tests
      expect(processInfo(kea.proc.pid as number)).toMatchObject({ start: main?.start, comm: main?.comm })
      expect(isAlive(a.pid) && isAlive(a.childPid), 'the session ran on').toBe(true)

      // once Kea runs again it takes the request it was sent and quits; the session is still there for the next launch
      kea.proc.kill('SIGCONT')
      await kea.exited
      await until('nothing to run from the app', () => bundleProcesses(packTable(), app).length === 0 || undefined)
      kea = null
      expect(isAlive(a.pid) && isAlive(a.childPid)).toBe(true)
      const from = ringSeq(home, a.ptyId)
      kea = launchApp(app, home, harnessEnv(home, ZSHRC))
      await answered(home, a.ptyId, from, kea, ANSWER_MS)
      expect(appVersion(app), 'still build N').toBe(versionN)
      expect(await quit(kea)).toBe(0)
      kea = null
    },
    PACKAGED_MS,
  )

  it('C-UPD-5 · build N’s agent is mid-turn through the update: typed into under build N+1, its hooks (still build N’s helper copy) reach the new core; every holder, old and new, starts from bin/current; bin/<N> stays while a running command names it and goes when the last one has ended', async (ctx) => {
    needOrSkip(ctx, packOs.installPlace) // tools/install.ts installs a macOS build (Linux: packages, install.sh)
    const kr = KeaRun.create()
    runs.push(kr)
    claudeByDefault(kr)
    const agent = fakeClaude(kr, 'update', TURN)
    const next = nextBuild()
    const bin = path.join(kr.home, 'bin')
    const current = currentHelper(kr.home)
    const copies = () => fs.readdirSync(bin).filter((d) => d !== 'agents' && d !== 'current')

    // ── build N: a session whose agent waits for a key, mid-turn
    const kea = await kr.launch()
    await addProject(kea, demoRepo(kr).root)
    const id = await startSession(kea, 'ride out the update', { open: false })
    await waitRow(kea, id, 'working', (r) => r.lifecycle === 'live' && r.status === 'working')
    await agentFocused(kea)
    await kea.waitScreen('the agent mid-turn', (sc) => sc.includes('press a key'))
    const before = kr.holders().filter((h) => kr.holderAlive(h))
    expect(before.length).toBeGreaterThanOrEqual(2) // the first shell and the agent
    for (const h of before) expect(executableOf(h.pid), `holder ${h.ptyId}`).toBe(current)
    // the agent's hooks run build N's own copy, which core installed for its launch
    const [nameN = '', ...others] = copies()
    expect(others).toEqual([])
    expect(nameN).toMatch(new RegExp(`^${escape(versionOf(testAppDist()))}-[0-9a-f]{12}$`))
    expect((await kea.quitFromMenu()).code, 'Quit Kea Completely').toBe(0)

    // ── build N+1 on the same home: every holder is the same process, still running bin/current
    const again = await kr.launch({ dist: next })
    await waitRow(again, id, 'reattached, still mid-turn', (r) => r.lifecycle === 'live' && r.status === 'working')
    holdersUnharmed(kr, before)
    for (const h of before) expect(executableOf(h.pid)).toBe(current)
    const look = await until('core to look at the helper copies', () => copyLooks(kr.home).at(-1))
    expect(look).toMatchObject({ removed: [], kept: [{ name: nameN, why: 'argv' }] })

    // ── typing reaches the old terminal; the agent's hooks call build N's copy and reach build N+1's core
    await agentFocused(again)
    await again.waitScreen('the agent mid-turn, redrawn', (sc) => sc.includes('press a key'))
    await again.press('x')
    await again.waitScreen('the turn finished', (sc) => sc.includes('Done.'))
    await waitRow(again, id, 'the turn applied', (r) => r.lifecycle === 'live' && r.status !== 'working')
    expect(agentHooks(agent.log).at(-1)).toBe('Stop')
    expect(fs.existsSync(path.join(kr.home, 'sessions', id, 'spool.ndjson')), 'no hook had to spool: core took each one').toBe(false)

    // ── a new terminal starts from bin/current too; build N's copy stays while its agent runs
    const tab = await again.newTab()
    const fresh = await until('the new tab’s holder', () => kr.holders().find((h) => h.ptyId === tab && kr.holderAlive(h)))
    expect(executableOf(fresh.pid)).toBe(current)
    expect(copies()).toEqual([nameN])

    // ── build N's last holders end: its copy goes, and nothing else does
    kr.killHolders(before)
    await until('build N’s holders to be gone', () => before.every((h) => !isAlive(h.pid)) || undefined)
    await until('core to remove build N’s copy', () => copyLooks(kr.home).some((l) => l.removed.includes(nameN)) || undefined)
    expect(copies()).toEqual([])
    expect(fs.existsSync(current), 'bin/current is never removed').toBe(true)
    expect(kr.holderAlive(fresh), 'the new terminal is untouched').toBe(true)
    await again.select(tab)
    await again.echo('after-the-prune')
    await again.assertUnfocused()
  })
})

// ── dev-build update ────────────────────────────────────────────────────────────────────────────

/** A turn that waits for a key, then runs a tool and stops (the agent stays up at its prompt). */
const TURN = `steps:
  - altScreen: enter
  - hook: UserPromptSubmit
  - frame: ["✻ fake-agent", "", "✶ Working… press a key"]
  - wait: key
  - hook: { event: PreToolUse, tool: Read, input: { file_path: "a.txt" } }
  - hook: { event: PostToolUse, tool: Read, input: { file_path: "a.txt" } }
  - hook: { event: Stop, fields: { last_assistant_message: "Done." } }
  - frame: ["✻ fake-agent", "", "⏺ Done.", "", "> "]
`

const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const versionOf = (dist: string): string => (JSON.parse(fs.readFileSync(path.join(dist, 'package.json'), 'utf8')) as { version: string }).version

/**
 * Build N+1 for the dev build: the suites' build under another version, beside it in dist/ (main finds the helper and
 * its native modules from there). The helper binary is the same, so only the version tells the copies apart, as for a
 * Kea whose helper did not change between two versions.
 */
function nextBuild(): string {
  const from = testAppDist()
  const to = `${from}-n1`
  cleanups.push(() => fs.rmSync(to, { recursive: true, force: true }))
  fs.rmSync(to, { recursive: true, force: true })
  fs.cpSync(from, to, { recursive: true })
  const pkg = path.join(to, 'package.json')
  const json = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }
  fs.writeFileSync(pkg, `${JSON.stringify({ ...json, version: `${json.version}-n1` }, null, 2)}\n`)
  return to
}

/** The session's Agent terminal on screen holding the page's keyboard. */
async function agentFocused(kea: Kea): Promise<void> {
  const page = await kea.page()
  const pty = await tabOf(kea, 'agent')
  await until('the Agent terminal on screen', async () => (await kea.shown()) === pty || undefined)
  await page.locator('.terminal-host.shown').click({ timeout: STEP_MS })
  await until('the Agent terminal holding the keyboard', () => page.evaluate(() => !!document.activeElement && !!document.querySelector('.terminal-host.shown')?.contains(document.activeElement)) || undefined)
}
