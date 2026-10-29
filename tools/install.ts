// `pnpm kea:install`: build Kea.app for this Mac, sign it with the local certificate, and install it over the app
// in /Applications. The survival check (tools/perf/src/survival.ts) and the update tests (C-UPD-1) run on
// these builds.
//
//   node tools/install.ts [--no-install] [--no-relaunch] [--adhoc] [--perf-probes] [--out <dir>] [--version-suffix <s>]
//                         [--install-to <dir>]
//
//   --no-install          build into --out only; by default the app then replaces /Applications/Kea.app
//   --no-relaunch         never open Kea again after replacing it (by default it is opened again only if it was
//                         running with a window, in front: tools/pack/src/plan.ts)
//   --adhoc               sign ad hoc instead of with "Kea Local Code Signing", to check the pipeline without the
//                         certificate. Such a build must never be installed: implies --no-install
//   --perf-probes         the packaged main accepts `--kea-perf*` (tools/perf, C-UPD-1). Never installed for use:
//                         implies --no-install unless --install-to names a test target
//   --out <dir>           where Kea.app is built (default dist/pack)
//   --version-suffix <s>  app version `<package version>-<s>`, so a second build gets its own helper copy (the build
//                         N+1 of the survival check and C-UPD-1). Never installed for use: implies --no-install
//                         unless --install-to names a test target
//   --install-to <dir>    the test target: install as <dir>/Kea.app instead. <dir> must exist and must not be an
//                         Applications folder or inside one. Kea is never opened again there. Every test of the
//                         install step uses it; nothing but the default (no switch) ever writes /Applications
//
// Steps: release bundles (tools/build.ts into dist/pack-app, a folder of this tool's own, so a `pnpm dev` or `pnpm perf`
// that runs from dist/app is never rebuilt under) and release kea-helper → electron-builder arm64 `dir` target,
// unsigned, `.node` files unpacked from the asar, kea-helper in Contents/Resources → fuses → codesign inside-out (every
// loose Mach-O, every nested framework and helper app, kea-helper as `dev.kea.helper`, then the app; hardened runtime
// off, no entitlements, no timestamp server) → verify (signatures and who made each, arm64 only, kea-helper's
// identifier, fuses read back, no update feed or crash reporter, no network client beyond each bundle's own:
// tools/pack/src/audit.ts) → install.
//
// Install (tools/pack/src): the release kea-helper first, which lists the processes (`kea-helper procs`); then,
// before the app is built, say what is there and what will happen (read-only looks), and say it again before the
// install if it changed meanwhile → copy the build to `<target>.installing` and verify it there → ask the Kea running
// from the target to quit completely (its sessions run on in their holders) and wait until nothing runs from
// the bundle → swap by two renames → delete the old app → open Kea again if it had a window in front. If Kea does not
// quit in time nothing is replaced. What a killed run leaves is put right at the start of the next (replace.ts).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRUNE_MARK } from '../packages/protocol/src/disk.ts'
import { L } from '../packages/protocol/src/generated/limits.ts'
import { isAvailable } from '../packages/protocol/src/platform.ts'
import { SETTINGS } from '../packages/protocol/src/settings.ts'
import { runCargo } from './cargo.ts'
import { buildApp, electronOf, flipFuses, loadFuses } from './pack/src/app.ts'
import { appCodeNames, firstPruneDue } from './pack/src/audit.ts'
import { TARGETS } from './pack/src/config.ts'
import { checkMacApp, IDENTITY, plistOf, quiet, signAll, signingIdentity, tool } from './pack/src/macApp.ts'
import { parseOptions } from './pack/src/options.ts'
import { packOs } from './pack/src/os/index.ts'
import { describe, PRUNE_SETTING, relaunchPlan, type Findings } from './pack/src/plan.ts'
import { processTable } from './pack/src/processes.ts'
import { discardStage, finish, leftovers, recover, sides, stage, stageDeps, stageFailure, swap, swapFailure } from './pack/src/replace.ts'
import { bundleProcesses, holdersByBuild, quitKeas, runningKeas, type RunningKea } from './pack/src/running.ts'
import { applicationsFolderOf, type InstallTarget } from './pack/src/target.ts'

const root = path.resolve(import.meta.dirname, '..')
/** This tree's release kea-helper: shipped in the bundle, and what lists the processes the install looks at. */
const HELPER = path.join(root, 'native/kea-helper/target/release/kea-helper')
/** This user's processes, as they are now. */
const table = () => processTable(HELPER)
/** The release bundles this tool packages: its own folder under dist/, never dist/app (`pnpm dev` and `pnpm perf` run from that one). */
const STAGE = path.join('dist', 'pack-app')

// ── options ─────────────────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.error(`\nkea:install: ${message}`)
  process.exit(1)
}

/** A step of tools/pack/src that throws the sentence to print when its line fails. */
function must<T>(f: () => T): T {
  try {
    return f()
  } catch (e) {
    fail((e as Error).message)
  }
}

// ── steps ───────────────────────────────────────────────────────────────────────────

function run(file: string, args: string[]): void {
  const r = spawnSync(file, args, { stdio: 'inherit' })
  if (r.status !== 0) fail(`${path.basename(file)} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status}`})`)
}

function step(n: string): void {
  console.log(`\n── ${n}`)
}

/** Kea.app from tools/pack/src/config.ts's macOS configuration (the zip's too), at `<out>/Kea.app`, unsigned. */
async function pack(o: { out: string; versionSuffix: string; helper: string }): Promise<string> {
  const electron = electronOf(root)
  const appVersion = (JSON.parse(fs.readFileSync(path.join(root, STAGE, 'package.json'), 'utf8')) as { version: string }).version
  const stage = path.join(o.out, '.builder')
  const app = path.join(o.out, 'Kea.app')
  // the options refuse an --out in an Applications folder, by any spelling (U-PACK-22); looked at again where the
  // build deletes what is at <out>/Kea.app, with no look at what runs from it
  const apps = applicationsFolderOf(o.out)
  if (apps) fail(`nothing is built in ${o.out}: it is in ${apps}`)
  fs.rmSync(app, { recursive: true, force: true })
  const inputs = { stage: STAGE, output: stage, electronDir: electron.dir, electronVersion: electron.version, helper: o.helper, version: o.versionSuffix ? `${appVersion}-${o.versionSuffix}` : null, icons: path.join(root, 'assets/icon'), licences: null }
  let built: string
  try {
    built = await buildApp(root, TARGETS['mac-arm64'], inputs)
  } catch (e) {
    fail((e as Error).message)
  }
  fs.renameSync(built, app)
  fs.rmSync(stage, { recursive: true, force: true })
  return app
}

// ── install (tools/pack/src) ─────────────────────────────────────────────────────────────────────

/** How often the process table is read while Kea quits. */
const QUIT_POLL_MS = 200

/** The pid of the app in front (`lsappinfo`, read-only: it activates nothing), or null if it cannot be told. */
function frontmostPid(): number | null {
  const asn = quiet(tool('lsappinfo'), ['front']).out.trim()
  if (!asn) return null
  const m = /"?pid"?\s*=\s*(\d+)/.exec(quiet(tool('lsappinfo'), ['info', '-only', 'pid', asn]).out)
  return m ? Number(m[1]) : null
}

function versionOf(app: string): string | null {
  try {
    return String(plistOf(app).CFBundleShortVersionString ?? '') || null
  } catch {
    return null
  }
}

/**
 * The read-only look: what is at the target, the Kea that runs from it, the holders alive by build. `next`: the build
 * about to be installed, as far as it is known. Nothing is written, signalled or connected to.
 */
function look(target: InstallTarget, next: { version: string; prunes: boolean }, o: { noRelaunch: boolean; notes: readonly string[] }): { findings: Findings; keas: RunningKea[] } {
  const procs = table()
  const keas = runningKeas(procs, target.app)
  const front = keas.length ? frontmostPid() : null
  // the installed app's own home (never for a test target), and the home of each Kea found running
  const homes = new Set<string>(target.test ? [] : [path.join(os.homedir(), '.kea')])
  for (const k of keas) if (k.home) homes.add(k.home)
  const days = SETTINGS.find((d) => d.key === PRUNE_SETTING)?.default
  // an install killed between its two renames left the old app beside the target: that is the app this replaces
  const there = fs.existsSync(target.app) ? target.app : fs.existsSync(sides(target.app).previous) ? sides(target.app).previous : null
  const findings: Findings = {
    target: target.app,
    test: target.test,
    installedVersion: there ? (versionOf(there) ?? 'of an unreadable version') : null,
    newVersion: next.version,
    recovered: o.notes,
    keas: keas.map((k) => ({ pid: k.main.pid, home: k.home, window: k.window, front: front === k.main.pid, held: k.held.length })),
    holders: [...homes].map((home) => ({ home, groups: holdersByBuild(procs, home) })),
    // the first prune of archived sessions' build folders: this build prunes and the one being replaced does
    // not (or cannot be read)
    firstPrune: firstPruneDue(there, next.prunes),
    pruneDays: typeof days === 'number' ? days : 0,
    noRelaunch: o.noRelaunch,
    quitSeconds: L.installQuitTimeoutMs / 1000,
  }
  return { findings, keas }
}

/** The plan without its notes: what a later look is compared with. */
const planOf = (f: Findings): string => describe({ ...f, recovered: [] }).join('\n')

/**
 * Before the app is built (only the helper that lists the processes is): say what is there and what the install will
 * do (the user reads this first, not after the build's output). Stops the run when the install could not go on anyway.
 * Returns the plan as it was said.
 */
function announce(target: InstallTarget, o: { noRelaunch: boolean; versionSuffix: string }): string {
  const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
  // the build about to be made is this source tree's, and it prunes (core's worktrees/disk.ts); install() reads the build itself
  const { findings } = look(target, { version: o.versionSuffix ? `${version}-${o.versionSuffix}` : version, prunes: true }, { noRelaunch: o.noRelaunch, notes: leftovers(target.app) })
  for (const l of describe(findings)) console.log(l)
  if (findings.keas.some((k) => k.held > 0)) fail('nothing was built or replaced (see above).')
  console.log('\nNothing changes until the build below is made and checked.')
  return planOf(findings)
}

/**
 * Replace the app at `target` with `built`. Everything it prints is for the person at the Mac: what is there, what
 * will happen, each step as it is done. `said`: the plan `announce` printed before the build; it is printed again only
 * if a new look differs. Returns the summary's last lines. On any refusal or failure before the swap the target is as
 * it was (`fail` ends the run).
 */
async function install(built: string, target: InstallTarget, o: { noRelaunch: boolean; said: string }): Promise<string[]> {
  const recovered = recover(target.app)
  for (const r of recovered) console.log(`Note: ${r}`)
  const { findings, keas } = look(target, { version: versionOf(built) ?? '?', prunes: appCodeNames(built, PRUNE_MARK) === true }, { noRelaunch: o.noRelaunch, notes: [] })
  if (planOf(findings) === o.said) console.log('Nothing has changed since the look above.')
  else {
    console.log('Since the look above, this has changed:')
    for (const l of describe(findings)) console.log(l)
  }
  if (findings.keas.some((k) => k.held > 0)) fail('nothing was replaced (see above).')
  const relaunch = relaunchPlan(findings)

  console.log('\nCopying the new build next to the app…')
  try {
    // the copy throws when it fails (never `run`, which would end here with the partial copy left behind): U-PACK-23
    stage(built, target.app, stageDeps())
  } catch (e) {
    fail(stageFailure(e, target.app))
  }

  if (keas.length) {
    console.log(`Asking Kea to quit (pid ${keas.map((k) => k.main.pid).join(', ')})…`)
    const t0 = performance.now()
    const q = await quitKeas(target.app, keas, { table, terminate: (pid) => process.kill(pid, 'SIGTERM'), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => performance.now() }, { timeoutMs: L.installQuitTimeoutMs, pollMs: QUIT_POLL_MS })
    for (const s of q.skipped) console.log(`  pid ${s.pid} was not asked: ${s.why}`)
    if (!q.empty) {
      discardStage(target.app)
      const left = q.left.map((p) => `${p.pid} ${path.basename(p.comm)}`).join(', ')
      fail(`Kea did not quit within ${findings.quitSeconds} s (still running from the app: ${left}).\nNothing was replaced: ${target.app} is as it was. Kea has been asked to quit and may still do so; your sessions keep running either way. Run this again once it has quit (if it never does, end it in Activity Monitor).`)
    }
    console.log(`Kea has quit (${((performance.now() - t0) / 1000).toFixed(1)} s). Its sessions run on.`)
  }
  // nothing may run from the bundle at the swap: replacing a bundle a process runs from is how apps break
  const still = bundleProcesses(table(), target.app)
  if (still.length) {
    discardStage(target.app)
    fail(`a process started from ${target.app} since it was looked at (${still.map((p) => `${p.pid} ${path.basename(p.comm)}`).join(', ')}).\nNothing was replaced. Quit Kea and run this again.`)
  }

  try {
    swap(target.app)
  } catch (e) {
    discardStage(target.app)
    fail(swapFailure(target.app, e, { quit: keas.length > 0 }))
  }
  const done = finish(target.app)
  console.log(`Replaced ${target.app}.`)
  if (done.error) console.log(`  The old app is still at ${target.app}.previous (${done.error}); the next install removes it.`)

  const last = [`installed: ${target.app}`]
  if (relaunch.will) {
    const r = quiet(tool('open'), [target.app])
    last.push(r.status === 0 ? 'Kea is open again; it reattaches every session.' : `Kea could not be opened (${r.out.trim() || `open exit ${r.status}`}): open it yourself.`)
  } else last.push(relaunch.say)
  return last
}

// ── main ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // the OS layer says whether this machine takes the build (Apple silicon Macs only)
  if (!isAvailable(packOs.installPlace)) fail(packOs.installPlace.reason)
  const refused = packOs.installPlace.refusal(process.arch)
  if (refused) fail(refused)
  let o: ReturnType<typeof parseOptions>
  try {
    o = parseOptions(process.argv.slice(2), { root })
  } catch (e) {
    fail((e as Error).message)
  }
  const started = performance.now()

  step('signing identity')
  const identity = o.adhoc ? '-' : must(signingIdentity)
  console.log(o.adhoc ? 'ad hoc (--adhoc): this build will not be installed' : `"${IDENTITY}" (${identity})`)

  // the helper first: it lists the processes every look below reads, and it ships in the bundle
  step('kea-helper release build')
  if (runCargo(['build', '--release', '--manifest-path', path.join(root, 'native/kea-helper/Cargo.toml')]) !== 0) fail('the kea-helper release build failed')
  if (!fs.existsSync(HELPER)) fail(`no ${path.relative(root, HELPER)}`)

  // the plan first: what is at the target, whether Kea runs from it, which terminals are alive, what will be done
  let said = ''
  if (o.target) {
    step(`what is at ${o.target.app}${o.target.test ? ' (test target)' : ''}, and what this will do`)
    said = announce(o.target, { noRelaunch: o.noRelaunch, versionSuffix: o.versionSuffix })
  }

  step('release build')
  run(process.execPath, [path.join(root, 'tools/build.ts'), '--release', '--out', STAGE, ...(o.perfProbes ? ['--perf-probes'] : [])])

  step('package (electron-builder, arm64 dir target, unsigned)')
  fs.mkdirSync(o.out, { recursive: true })
  const app = await pack({ out: o.out, versionSuffix: o.versionSuffix, helper: HELPER })

  step('fuses (before signing)')
  const fuses = await loadFuses(root)
  await flipFuses(fuses, TARGETS['mac-arm64'], app)

  step('codesign, inside-out')
  const signed = must(() => signAll(app, identity))
  console.log(`${signed.items.length} signatures (${signed.nativeModules.length} native module(s))`)

  step('verify')
  const wire = await fuses.getCurrentFuseWire(app)
  // no feed and no install kind: an app this tool installs is never updated by Kea's updater
  const lines = must(() => checkMacApp(app, { fuses, wire, adhoc: o.adhoc, signed: signed.items, feed: null }))

  let last = ['not installed']
  if (o.target) {
    step(`install to ${o.target.app}${o.target.test ? ' (test target)' : ''}`)
    last = await install(app, o.target, { noRelaunch: o.noRelaunch, said })
  }

  console.log(`\nKea ${versionOf(app) ?? '?'} → ${app}${o.perfProbes ? ' (perf probes: accepts --kea-perf*)' : ''}`)
  for (const l of lines) console.log(`  ${l}`)
  console.log(`  native modules: ${signed.nativeModules.length ? signed.nativeModules.join(', ') : 'none'}`)
  console.log(`  ${last[0]} · ${((performance.now() - started) / 1000).toFixed(1)} s`)
  for (const l of last.slice(1)) console.log(`  ${l}`)
}

await main()
