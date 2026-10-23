// The harnesses themselves: the helper binary the suites start holders from (tests/support/holders.ts), the
// environment every launch of Kea gets (tests/support/app.ts, tools/perf/src/launch.ts), which must never let Kea reach
// a real agent CLI, the leak suite's count checks (tests/support/app-leak.ts), and the run-level guards: no memory
// watchdog trigger, no Kea left in front, no long test outside KEA_LONG, and the keys a test presses on each system.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@kea/kit'
import { kitOs } from '../../packages/kit/src/os/index.ts'
import { L } from '@kea/protocol'
import { resolveCargo } from '../../tools/cargo.ts'
import { agentCommands } from '@kea/adapters'
import { assertLoginShellAgents, fallbackLookup, harnessUserHome, launchKea, loginShellLookup, runAppProcesses, writeAgentShims } from '../../tools/perf/src/launch.ts'
import { harnessEnv } from '../../tools/perf/src/survival.ts'
import { assertNoRealAgentOnPath } from '../support/agent-guard.ts'
import { FRONT_LOG as MAIN_FRONT_LOG } from '../../app/main/src/frontGuard.ts'
import { FRONT_LOG, frontSteps, KeaRun, LAUNCHES_KEA, pathWithoutAgents, STEP_MS, WATCHDOG_LOG, watchdogTriggers } from '../support/app.ts'
import { EVENT_ROWS, expectCountsFlat, medianReading, TRANSIENT_HANDLES, type LeakRun, type Reading } from '../support/app-leak.ts'
import { BUILD_OUTPUT_MAX_BYTES, BUILD_TIMEOUT_MS, DEBUG_HELPER, helperBinary, ptyhostHarness, REPO_ROOT } from '../support/holders.ts'
import { startFullCore } from './core-support.ts'
import { LONG_GUARD_MS, overLong } from '../support/long.ts'
import { chordOf, pageKey, pressOf, sysAccel, sysKey, sysLabel, textKey } from '../support/keys.ts'
import { linux as linuxKeys } from '../../packages/protocol/src/os/linux.ts'
import { darwin as darwinKeys } from '../../packages/protocol/src/os/darwin.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const c of cleanup.splice(0).reverse()) await c()
})

/** `cargo build` of the debug helper with nothing to rebuild: what every test file and every concurrent suite runs. */
async function freshCargoBuild(): Promise<void> {
  const cargo = resolveCargo()!
  const r = await runProcess(cargo, ['build', '--quiet', '--manifest-path', path.join(REPO_ROOT, 'native/kea-helper/Cargo.toml')], {
    pool: 'other',
    env: { ...process.env, PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ''}` },
    timeoutMs: BUILD_TIMEOUT_MS,
    maxBytes: BUILD_OUTPUT_MAX_BYTES,
  })
  expect(r.code, r.stderr).toBe(0)
}

describe('holder harness', () => {
  // A `cargo build` on macOS replaces `target/debug/kea-helper` with a new file even when nothing changed, so for a
  // moment the path does not exist, and a test in another file or suite that copies or starts its helper from there
  // fails with "kea-helper not found". The harness hands out a copy no build ever replaces.
  it('I-HARN-2 · the helper the harness hands out is never replaced by a concurrent cargo build', async () => {
    const helper = await helperBinary()
    const before = fs.statSync(helper).ino
    const cargoBefore = fs.statSync(DEBUG_HELPER).ino
    await freshCargoBuild()
    // macOS's cargo writes its own output anew on every build; Linux's can leave the same file in place
    if (kitOs.system === 'darwin') expect(fs.statSync(DEBUG_HELPER).ino, "cargo's own output is a new file after every build").not.toBe(cargoBefore)
    expect(fs.statSync(helper).ino, 'the harness copy is untouched').toBe(before)
    expect(await helperBinary(), 'and stays the one handed out').toBe(helper)
  })
})

describe('the environment Kea is launched with', () => {
  // When core's login-shell probe fails, its fallback environment appends `~/.local/bin`, where the real CLI lives. A
  // harness launch therefore never keeps the real HOME: with it, detection could run the real `claude --version` and
  // `auth status` outside the recorder's sandbox.
  it.runIf(LAUNCHES_KEA)('I-HARN-3 · a harness launch whose login-shell probe fails: core’s fallback PATH finds the run’s fake `claude`, or none for a launch without it, never one in the owner’s ~/.local/bin', async () => {
    // a stand-in for the real home, as every harness process inherits it, with a `claude` in ~/.local/bin (never run)
    const owner = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-harn-owner-')))
    cleanup.push(() => fs.rmSync(owner, { recursive: true, force: true }))
    const ownerBin = path.join(owner, '.local', 'bin')
    fs.mkdirSync(ownerBin, { recursive: true })
    fs.writeFileSync(path.join(ownerBin, 'claude'), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
    vi.stubEnv('HOME', owner)
    const run = KeaRun.create()
    cleanup.push(() => run.dispose())
    // os-ok: in /usr/bin on both systems
    const probeFails = { SHELL: '/usr/bin/false' } // exits at once: no environment from `-l -i`, nor from `-l`
    const child = path.join(import.meta.dirname, 'harness-env-child.ts')
    const cases: [string, Record<string, string>, string | null][] = [
      ['KeaRun: the fake agent first on PATH', run.launchEnv(probeFails), path.join(run.agentBin, 'claude')],
      ['no agent on PATH (E-AGT-1)', run.launchEnv({ ...probeFails, PATH: pathWithoutAgents() }), null],
    ]
    const got: Record<string, { source: string; claude: string | null; ownerBinOnPath: boolean }> = {}
    for (const [what, env] of cases) {
      const r = await runProcess(process.execPath, [child], { pool: 'other', env, timeoutMs: STEP_MS })
      expect(r.code, `${what}: ${r.stderr}`).toBe(0)
      const o = JSON.parse(r.stdout!.toString('utf8')) as { source: string; claude: string | null; path: string | null }
      got[what] = { source: o.source, claude: o.claude, ownerBinOnPath: (o.path ?? '').split(':').includes(ownerBin) }
    }
    expect(got).toEqual(Object.fromEntries(cases.map(([what, , claude]) => [what, { source: 'fallback', claude, ownerBinOnPath: false }])))
  })

  // macOS's path_helper (/etc/zprofile) puts /etc/paths and /etc/paths.d ahead of the inherited PATH, so a `claude`
  // installed with Homebrew or npm under /usr/local/bin or /opt/homebrew/bin would be found before the run's fake
  // agent. The test checks against a stand-in folder the login shell puts first.
  it.runIf(LAUNCHES_KEA)('I-HARN-4 · the run’s login shell, after path_helper, has the fake agent’s folder first on PATH and finds the fake `claude`; a run whose login shell finds another `claude` is refused', () => {
    const run = KeaRun.create()
    cleanup.push(() => run.dispose())
    const env = run.launchEnv()
    const seen = loginShellLookup(env)
    expect({ first: seen.path[0], claude: seen.agents.claude }).toEqual({ first: run.agentBin, claude: path.join(run.agentBin, 'claude') })
    expect(() => assertLoginShellAgents(env, run.agentBin)).not.toThrow()
    // a launch whose PATH lacks the run's folder is refused on any machine: its login shell still finds the fakes (the
    // rc puts the folder first on any PATH, I-HARN-9) while the fallback environment would not, so the two disagree
    const bare = run.launchEnv({ PATH: pathWithoutAgents() })
    expect(loginShellLookup(bare).agents.claude).toBe(path.join(run.agentBin, 'claude'))
    expect(fallbackLookup(bare).claude).toBeNull()
    expect(() => assertLoginShellAgents(bare, null)).toThrow(/refusing to start/)
    expect(() => assertLoginShellAgents(bare, run.agentBin)).toThrow(/refusing to start/)
    // a `claude` the login shell finds first (as one under /usr/local/bin would be): refused, naming where it is
    const other = path.join(run.home, 'elsewhere')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'claude'), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
    fs.appendFileSync(path.join(run.zdotdir, '.zshrc'), `path=(${other} $path)\n`)
    expect(() => assertLoginShellAgents(env, run.agentBin)).toThrow(`finds \`claude\` at ${path.join(other, 'claude')}`)
    expect(() => assertLoginShellAgents(run.launchEnv({ PATH: pathWithoutAgents() }), null)).toThrow(`finds \`claude\` at ${path.join(other, 'claude')}`)
  })

  // Ubuntu's /etc/zsh/zshrc runs compinit unless skip_global_compinit is set. On a machine whose zsh function folders
  // are group-writable (GitHub's runners), compinit stops at "Ignore insecure directories and continue [y] or abort
  // compinit [n]?" and the test shell never shows its prompt. Of the files the run's ZDOTDIR holds, only `.zshenv` is
  // read before that one.
  it.runIf(LAUNCHES_KEA)('I-HARN-18 · the test shells of KeaRun and of the survival harness skip Ubuntu’s global compinit: skip_global_compinit is set before any zshrc is read', async () => {
    const run = KeaRun.create()
    cleanup.push(() => run.dispose())
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-harn-survival-')))
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }))
    const seen: Record<string, string> = {}
    for (const [what, env] of [['KeaRun', run.launchEnv()], ['survival harness', harnessEnv(home, '')]] as const) {
      // `zsh -c` reads /etc/zshenv and $ZDOTDIR/.zshenv and no other rc file
      const r = await runProcess(env.SHELL!, ['-c', 'print -r -- ${skip_global_compinit-unset}'], { pool: 'other', env, timeoutMs: STEP_MS })
      expect(r.code, `${what}: ${r.stderr}`).toBe(0)
      seen[what] = r.stdout!.toString('utf8').trim()
    }
    expect(seen).toEqual({ KeaRun: '1', 'survival harness': '1' })
  })
})

describe('the agent commands a harness run can reach', () => {
  // Command Code's four commands are installed by npm in /opt/homebrew/bin, which macOS's path_helper puts on every
  // login shell's PATH and core's fallback environment appends by itself, so no ZDOTDIR or HOME of the run's
  // own takes them off: detection at every start of Kea would run the real CLI.
  it.runIf(LAUNCHES_KEA)('I-HARN-7 · every command of every adapter is the run’s fake agent in both environments core can end up with, the login shell’s and the fallback one; a command the shim folder does not hold must be found nowhere: a CLI in a folder the fallback adds by itself is refused, naming it, until the run shadows it', () => {
    const run = KeaRun.create()
    cleanup.push(() => run.dispose())
    const names = agentCommands().flatMap((a) => a.names)
    expect(names).toEqual(expect.arrayContaining(['claude']))
    const env = run.launchEnv()
    const fake = Object.fromEntries(names.map((n) => [n, path.join(run.agentBin, n)]))
    expect(loginShellLookup(env).agents).toEqual(fake)
    expect(fallbackLookup(env)).toEqual(fake)
    expect(() => assertLoginShellAgents(env, run.agentBin)).not.toThrow()
    // a run without one command's shim (E-AGT-1): that command is found nowhere, the others stay the fake
    fs.rmSync(path.join(run.agentBin, 'claude'))
    expect(loginShellLookup(env).agents).toEqual({ ...fake, claude: null })
    expect(fallbackLookup(env)).toEqual({ ...fake, claude: null })
    expect(() => assertLoginShellAgents(env, run.agentBin)).not.toThrow()
    // a CLI where only the fallback looks (the run's ~/.local/bin stands in for /opt/homebrew/bin; never run): the
    // login shell does not see it, the fallback would, and the run is refused before Kea starts
    const local = path.join(env.HOME!, '.local', 'bin')
    fs.mkdirSync(local, { recursive: true })
    fs.writeFileSync(path.join(local, 'claude'), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
    expect(loginShellLookup(env).agents.claude).toBeNull()
    expect(() => assertLoginShellAgents(env, run.agentBin)).toThrow(`core's fallback environment (a failed login-shell probe) finds \`claude\` at ${path.join(local, 'claude')}, not nothing`)
    // shadowed by the run's own fake again: accepted
    writeAgentShims(run.agentBin, { only: ['claude'] })
    expect(() => assertLoginShellAgents(env, run.agentBin)).not.toThrow()
  })

  it('I-HARN-8 · a core that runs inside a test process is refused a PATH that finds an agent command outside the temp directory, also through a symlink, before anything starts; a test’s own stand-in in the temp directory is accepted', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-harn-path-')))
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const names = agentCommands().flatMap((a) => a.names)
    for (const name of names) {
      const standIn = path.join(dir, 'own', name)
      fs.mkdirSync(path.dirname(standIn), { recursive: true })
      fs.writeFileSync(standIn, '#!/bin/sh\nexit 97\n', { mode: 0o755 })
      expect(() => assertNoRealAgentOnPath(`${path.dirname(standIn)}:/usr/bin:/bin`), name).not.toThrow()
      // an executable outside the temp directory under an agent's name (a link to /bin/echo stands in; never run)
      const linked = path.join(dir, `linked-${name}`)
      fs.mkdirSync(linked)
      fs.symlinkSync('/bin/echo', path.join(linked, name))
      expect(() => assertNoRealAgentOnPath(`/usr/bin:${linked}`), name).toThrow(`finds \`${name}\` at ${path.join(linked, name)}, outside the temp directory`)
      // the harness checks it first: no core, no ptyhost harness, is touched
      expect(() => startFullCore(null as never, { env: { PATH: linked } }), name).toThrow(/refusing to start/)
    }
    expect(() => assertNoRealAgentOnPath(undefined)).not.toThrow()
    expect(() => assertNoRealAgentOnPath('/usr/bin:/bin')).not.toThrow()
  })

  // Each guard must hold on its own, not because every caller does its part: this test and the next two check one each.
  it.runIf(LAUNCHES_KEA)('I-HARN-10 · launchKea checks by itself, before anything is started, that the shell core would use finds each agent command as the run’s declared fake or not at all: a launch that declares no fake-agent folder, one whose fallback PATH finds another `claude`, and one with a login shell that cannot be checked are refused; the check runs $SHELL, as core does', async () => {
    const run = KeaRun.create()
    cleanup.push(() => run.dispose())
    // no Kea is started in this row: `onSpawn` is called once the checks are through, right before Electron would be
    // started, and here it stops the launch there
    const base = { dist: path.join(run.home, 'no-such-app'), home: run.home, timeoutMs: STEP_MS }
    let spawning = 0
    const stop = (): never => {
      spawning++
      throw new Error('the checks are through')
    }

    // the run's own environment, its fake agents declared: the checks pass (`onSpawn` comes once the run's display is
    // ready, after the synchronous checks: on Linux that is the harness's Xvfb)
    await expect(launchKea({ ...base, env: run.env(), agents: run.agentBin, onSpawn: stop })).rejects.toThrow('the checks are through')
    expect(spawning).toBe(1)

    // no folder declared: no agent command may be found at all, and the run's shell finds its fake `claude`
    expect(() => launchKea({ ...base, env: run.env(), onSpawn: stop })).toThrow(`the run's login shell finds \`claude\` at ${path.join(run.agentBin, 'claude')}, not nothing`)
    // declared, but core's fallback environment (a failed probe) would find another one: a link to /bin/echo stands in, never run
    const local = path.join(harnessUserHome(run.home), '.local', 'bin')
    fs.mkdirSync(local, { recursive: true })
    fs.rmSync(path.join(run.agentBin, 'claude'))
    fs.symlinkSync('/bin/echo', path.join(local, 'claude'))
    expect(() => launchKea({ ...base, env: run.env(), agents: run.agentBin, onSpawn: stop })).toThrow(`core's fallback environment (a failed login-shell probe) finds \`claude\` at ${path.join(local, 'claude')}, not nothing`)
    fs.rmSync(path.join(local, 'claude'))
    writeAgentShims(run.agentBin, { only: ['claude'] })

    // a login shell the check cannot read is refused, whatever it would find: core runs its probe and every agent through $SHELL
    for (const shell of ['/bin/bash', '/bin/sh', 'zsh']) {
      expect(() => launchKea({ ...base, env: run.env({ SHELL: shell }), agents: run.agentBin, onSpawn: stop }), shell).toThrow(`SHELL is ${shell}`)
      expect(() => assertLoginShellAgents(run.launchEnv({ SHELL: shell }), run.agentBin), shell).toThrow(/refusing to start/)
    }
    // a zsh at another place is the one asked (a wrapper that says so stands in for it)
    const asked = path.join(run.home, 'zsh-was-asked')
    const other = path.join(run.home, 'other-shell', 'zsh')
    fs.mkdirSync(path.dirname(other))
    fs.writeFileSync(other, `#!/bin/sh\n: > '${asked}'\nexec /bin/zsh "$@"\n`, { mode: 0o755 })
    expect(loginShellLookup(run.launchEnv({ SHELL: other })).agents.claude).toBe(path.join(run.agentBin, 'claude'))
    expect(fs.existsSync(asked)).toBe(true)
    expect(() => assertLoginShellAgents(run.launchEnv({ SHELL: other }), run.agentBin)).not.toThrow()

    // no refused launch came as far as starting anything, and no Kea was started by this row at all
    expect(spawning).toBe(1)
    expect(runAppProcesses(run.home)).toEqual([])
  })

  it.runIf(LAUNCHES_KEA)('I-HARN-11 · KeaRun.launch checks every launch, also one that changes nothing in the environment: a run whose fake `claude` went after it was made, with another `claude` where core’s fallback PATH looks, is refused before Kea starts', async () => {
    const run = KeaRun.create()
    cleanup.push(() => run.dispose())
    // after `create` checked the run: its own fake goes, and a `claude` stands where the fallback looks (a link to /bin/echo, never run)
    const local = path.join(harnessUserHome(run.home), '.local', 'bin')
    fs.mkdirSync(local, { recursive: true })
    fs.rmSync(path.join(run.agentBin, 'claude'))
    fs.symlinkSync('/bin/echo', path.join(local, 'claude'))
    await expect(run.launch()).rejects.toThrow(`core's fallback environment (a failed login-shell probe) finds \`claude\` at ${path.join(local, 'claude')}, not nothing`)
    expect(runAppProcesses(run.home)).toEqual([])
  })

  it('I-HARN-12 · a core that runs inside a test process gets no PATH unchecked: an environment source handed over in `opts.shellEnv` is checked each time core asks it, so a PATH that finds an agent command outside the temp directory never reaches detection', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-harn-env-')))
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    // an executable outside the temp directory under an agent's name (a link to /bin/echo stands in; never run)
    fs.symlinkSync('/bin/echo', path.join(dir, 'claude'))
    const h = await ptyhostHarness()
    cleanup.push(() => h.dispose())
    let asked = 0
    const c = startFullCore(h, {
      opts: {
        shellEnv: {
          get: async () => {
            asked++
            return { PATH: dir }
          },
        },
      },
    })
    cleanup.push(() => c.dispose())
    await c.call('agents.refresh', {})
    expect(asked).toBeGreaterThan(0)
    // detection never saw that PATH: nothing was found on it, and so nothing was run
    expect(c.core.agents.store.get('claude')).toMatchObject({ state: 'missing', path: null })
    await expect(c.shellEnv.get()).rejects.toThrow(`finds \`claude\` at ${path.join(dir, 'claude')}, outside the temp directory`)
    c.dispose()
    // a source whose PATH holds only a test's own stand-in is handed on as it is
    const own = path.join(dir, 'own')
    fs.mkdirSync(own)
    fs.writeFileSync(path.join(own, 'claude'), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
    const ok = startFullCore(h, { opts: { shellEnv: { get: async () => ({ PATH: own }) } } })
    cleanup.push(() => ok.dispose())
    expect(await ok.shellEnv.get()).toEqual({ PATH: own })
  })

  // A Kea typed into a shell of another run's Kea inherits that run's PATH, with the other run's fake agents on it. Its
  // rc must still put its own fake agents first; otherwise path_helper puts /opt/homebrew/bin, and a real agent CLI,
  // ahead of them.
  it.runIf(LAUNCHES_KEA)('I-HARN-9 · a Kea typed into a shell of another run’s Kea finds its own run’s fake agents and nothing else: the run’s rc puts its fake-agent folder first whether or not the inherited PATH holds it, and `handStartWords` checks both environments before a word is typed and gives it its own run’s HOME', () => {
    const a = KeaRun.create()
    cleanup.push(() => a.dispose())
    const b = KeaRun.create()
    cleanup.push(() => b.dispose())
    const names = agentCommands().flatMap((n) => n.names)
    const own = Object.fromEntries(names.map((n) => [n, path.join(b.agentBin, n)]))
    // what a shell of A's Kea hands to a program started from it: A's environment with its login shell's PATH
    const fromA = { ...a.launchEnv(), PATH: loginShellLookup(a.launchEnv()).path.join(':') }
    expect(fromA.PATH.split(':')).not.toContain(b.agentBin)
    // with nothing but B's ZDOTDIR: B's login shell still finds B's fake agents
    expect(loginShellLookup({ ...fromA, SHELL: '/bin/zsh', ZDOTDIR: b.zdotdir }).agents).toEqual(own)
    // the words a test types before the command put B's folder first for the fallback environment too, and are checked
    const words = b.handStartWords(a)
    // … and B's own run's HOME, so nothing B keeps in a person's home lands in A's (Electron's userData on Linux)
    expect(words).toBe(`HOME='${harnessUserHome(b.home)}' PATH='${b.agentBin}':"$PATH" SHELL=/bin/zsh ZDOTDIR='${b.zdotdir}'`)
    expect(fallbackLookup({ ...fromA, PATH: `${b.agentBin}:${fromA.PATH}` })).toEqual(own)
    // a command B's folder does not hold would be A's (or a real one): refused before anything is typed
    fs.rmSync(path.join(b.agentBin, 'claude'))
    expect(() => b.handStartWords(a)).toThrow(/finds `claude` at .*refusing to start/)
  })
})

describe('the leak harness', () => {
  it('I-HARN-5 · a count that a reading does not list is a count of none, never an unknown: a handle type seen at one of a checkpoint’s three readings has the median 0 and at two of them 1; a type that is no longer listed at a later checkpoint reads 0 there, so a count whose baseline is 0 has not moved, a timer that fired has only fallen, and a handle that went is reported with its numbers', () => {
    const reading = (counts: Record<string, number>): Reading => ({ counts, bytes: { 'core.heap': 1000 } })
    // active handles come by type, and a type with none at that moment is not listed: a timer caught by one reading of three
    const once = medianReading([reading({ 'core.handles.Timeout': 1, 'core.handles.PipeWrap': 2 }), reading({ 'core.handles.PipeWrap': 2 }), reading({ 'core.handles.PipeWrap': 2 })])
    expect(once).toEqual({ counts: { 'core.handles.Timeout': 0, 'core.handles.PipeWrap': 2 }, bytes: { 'core.heap': 1000 } })
    // by two of three: it is there
    expect(medianReading([reading({ 'core.handles.Timeout': 1 }), reading({}), reading({ 'core.handles.Timeout': 1 })]).counts).toEqual({ 'core.handles.Timeout': 1 })
    expect(Object.values(once.counts).every(Number.isFinite)).toBe(true)

    const run = (...points: Record<string, number>[]): LeakRun => ({ cycles: points.map((_, i) => i), points: points.map(reading) })
    const all = (): boolean => true
    expect(() => expectCountsFlat(run({ 'core.kit.scopes': 4 }, { 'core.kit.scopes': 4 }), all)).not.toThrow()
    // a baseline of none (that timer's median) and no such type listed afterwards: nothing moved
    expect(() => expectCountsFlat(run(once.counts, { 'core.handles.PipeWrap': 2 }, { 'core.handles.PipeWrap': 2 }), all)).not.toThrow()
    expect(() => expectCountsFlat(run({ 'core.handles.FSEventWrap': 0 }, {}), all)).not.toThrow()
    // a timer in the baseline that has fired since: it may fall, and does not rise
    expect(() => expectCountsFlat(run({ 'core.handles.Timeout': 1 }, {}, { 'core.handles.Timeout': 1 }), all)).not.toThrow()
    expect(() => expectCountsFlat(run({ 'core.handles.Timeout': 1 }, { 'core.handles.Timeout': 2 }), all)).toThrow(/core\.handles\.Timeout/)
    // so does ptyhost's checkpoint timer, a row of its report (armed while a checkpoint is due after output)
    const checkpointTimer = 'ptyhost.kit.ptyhost.checkpoints.timer'
    expect(() => expectCountsFlat(run({ [checkpointTimer]: 1 }, { [checkpointTimer]: 0 }, { [checkpointTimer]: 0 }), all)).not.toThrow()
    let rose: unknown = null
    try {
      expectCountsFlat(run({ [checkpointTimer]: 0 }, { [checkpointTimer]: 1 }), all)
    } catch (e) {
      rose = (e as { actual?: unknown }).actual
    }
    expect(rose, 'risen: moved, by name').toEqual({ [checkpointTimer]: [0, 1] })
    // a handle that went: a difference, said in numbers
    let said = ''
    try {
      expectCountsFlat(run({ 'core.handles.PipeWrap': 2 }, { 'core.handles.PipeWrap': 2 }, {}), all)
    } catch (e) {
      said = e instanceof Error ? e.message : String(e)
    }
    expect(said).toMatch(/core\.handles\.PipeWrap/)
    expect(said).not.toMatch(/NaN/)
  })

  it('I-HARN-6 · an event count is held to nothing and no level hides behind one: the reports’ eviction, refusal and dropped-line counts may rise at every checkpoint and start again at 0, under either name a reading gives a report’s rows; a level of the same report, a row that only ends like a listed one and an event count nobody has listed still fail, by name; the watcher’s high-water mark is held to the rescan threshold instead of its baseline', () => {
    const run = (...points: Record<string, number>[]): LeakRun => ({ cycles: points.map((_, i) => i), points: points.map((counts) => ({ counts, bytes: {} })) })
    const all = (): boolean => true
    /** The counts `expectCountsFlat` reports as moved (the failure's own list: its message shortens a long one). */
    const moved = (r: LeakRun): string[] => {
      try {
        expectCountsFlat(r, all)
        return []
      } catch (e) {
        return Object.keys((e as { actual?: Record<string, number[]> }).actual ?? { 'no list': [] })
      }
    }
    // the rows as the leak suite's readings name them (the child hook's report) and as main's resources line does
    const rows = [...EVENT_ROWS]
    expect(rows).toEqual(expect.arrayContaining(['core.files.evictions', 'core.watch.evictions', 'kit.log.dropped']))
    const events = [...rows.filter((r) => r.startsWith('core.')).flatMap((r) => [`core.kit.${r}`, `core.report.${r}`]), ...['core', 'ptyhost'].map((p) => `${p}.kit.kit.log.dropped`), 'main.report.kit.log.dropped']
    const at = (n: number): Record<string, number> => Object.fromEntries(events.map((k) => [k, n]))
    // one more of each at every switch (21, 71, 121, … in L-TERM-6), then a restarted process counting from 0 (L-MEM-8)
    expect(moved(run(at(21), at(71), at(121), at(0), at(5)))).toEqual([])

    // a level beside them moves: it fails, and it alone is reported
    const levels = ['core.kit.core.files.sessions', 'core.kit.core.files.cached', 'core.kit.core.files.fsmonitorWrites', 'core.kit.core.watch.worktrees', 'core.kit.core.watch.streams', 'core.kit.core.watch.restarts', 'core.kit.kit.listeners', 'ptyhost.kit.kit.timers', 'renderer.storeListeners']
    for (const level of levels) expect(moved(run({ ...at(21), [level]: 4 }, { ...at(71), [level]: 5 }, { ...at(121), [level]: 6 })), level).toEqual([level])
    // … also a level that only falls back to where it was (a listener there at some checkpoints only, L-TERM-6)
    expect(moved(run({ 'renderer.storeListeners': 37 }, { 'renderer.storeListeners': 38 }, { 'renderer.storeListeners': 37 }))).toEqual(['renderer.storeListeners'])

    // a name is a listed row or it is not: the same last name in another row, a longer name, a count that is no
    // report row at all, and an event count that nobody has listed yet are each held to their baseline
    const near = ['core.kit.core.viewer.evictions', 'core.kit.core.files.evictionsPending', 'core.kit.core.watch.refusedNow', 'ptyhost.kit.ptyhost.dropped', 'renderer.evictions', 'renderer.core.files.evictions', 'core.handles.core.watch.evictions', 'main.kit.log.dropped']
    for (const k of near) expect(moved(run({ [k]: 1 }, { [k]: 2 })), k).toEqual([k])

    // the most events ever pending: it may rise to L.watchRescanThreshold and be gone with its worktree, never above it
    const peak = 'core.kit.core.watch.peakPendingEvents'
    expect(moved(run({ [peak]: 0 }, { [peak]: 120 }, { [peak]: L.watchRescanThreshold }, {}))).toEqual([])
    expect(moved(run({ [peak]: 0 }, { [peak]: L.watchRescanThreshold + 1 }))).toEqual([peak])
    // … while the events pending now are a level like any other
    expect(moved(run({ 'core.kit.core.watch.pendingEvents': 0 }, { 'core.kit.core.watch.pendingEvents': 3 }))).toEqual(['core.kit.core.watch.pendingEvents'])
  })

  it('I-HARN-15 · every count seen at any checkpoint is judged, not only the baseline’s: one that first appears after the baseline (a new handle type, a new report row, a timer type) and stays fails by name, as does one that comes and goes; only a request in flight that the harness names (TRANSIENT_HANDLES, by its whole type) may come and go, and it fails once it stays above where it rests at two checkpoints in a row; the filter, the event rows and the capped levels apply to the new keys as to the baseline’s', () => {
    const run = (...points: Record<string, number>[]): LeakRun => ({ cycles: points.map((_, i) => i), points: points.map((counts) => ({ counts, bytes: {} })) })
    const all = (): boolean => true
    const moved = (r: LeakRun, keys: (k: string) => boolean = all): string[] => {
      try {
        expectCountsFlat(r, keys)
        return []
      } catch (e) {
        return Object.keys((e as { actual?: Record<string, number[]> }).actual ?? { 'no list': [] })
      }
    }
    const base = { 'core.kit.kit.scopes': 4, 'renderer.nodes': 900 }
    // first seen after the baseline, and there from then on: a holder socket, a child, a report row, a renderer row, a
    // listener of main, a timer type (timers may fall, never rise: none at the baseline is 0)
    const late = ['core.handles.PipeWrap', 'ptyhost.handles.ProcessWrap', 'main.handle:TCPWrap', 'core.kit.core.sessions.launching', 'renderer.paletteRows', 'main.ipc:kea:palette', 'core.handles.Timeout', 'main.handle:Timeout']
    for (const k of late) expect(moved(run(base, base, { ...base, [k]: 1 }, { ...base, [k]: 1 })), k).toEqual([k])
    // … also one that appears once and goes: a level is held to its baseline, and absent is none
    for (const k of late) expect(moved(run(base, { ...base, [k]: 1 }, base, base)), k).toEqual([k])
    // … and one that keeps rising, its series said with the absent ones as 0
    let said: Record<string, number[]> = {}
    try {
      expectCountsFlat(run(base, { ...base, 'core.handles.PipeWrap': 1 }, base, { ...base, 'core.handles.PipeWrap': 2 }), all)
    } catch (e) {
      said = (e as { actual?: Record<string, number[]> }).actual ?? {}
    }
    expect(said).toEqual({ 'core.handles.PipeWrap': [0, 1, 0, 2] })

    // a request in flight, by its whole handle type in each process's naming: caught by a checkpoint now and then
    // (at the baseline too), back where it rests by the next
    const transients = [...TRANSIENT_HANDLES]
    expect(transients.length).toBeGreaterThan(0)
    for (const t of transients) {
      for (const k of [`core.handles.${t}`, `ptyhost.handles.${t}`, `main.handle:${t}`]) {
        expect(moved(run(base, { ...base, [k]: 1 }, base, { ...base, [k]: 2 }, base, { ...base, [k]: 1 })), k).toEqual([])
        expect(moved(run({ ...base, [k]: 1 }, base, base, { ...base, [k]: 1 })), `${k} caught at the baseline`).toEqual([])
        // … that stays: not in flight but held, and fails
        expect(moved(run(base, { ...base, [k]: 1 }, { ...base, [k]: 1 }, base)), `${k} held over two checkpoints`).toEqual([k])
        expect(moved(run(base, base, { ...base, [k]: 1 }, { ...base, [k]: 2 })), `${k} rising`).toEqual([k])
      }
    }
    // a name is listed whole or it is not: the same type under another prefix, a longer name, a report row of that name
    const t0 = transients[0]!
    for (const k of [`renderer.${t0}`, `core.kit.${t0}`, `core.handles.${t0}Extra`, `core.handles.X${t0}`, `main.ipc:${t0}`]) {
      expect(moved(run(base, { ...base, [k]: 1 }, base)), k).toEqual([k])
    }

    // the filter decides for a late key as for any other; a late event row is held to nothing; a late capped level to its cap
    expect(moved(run(base, { ...base, 'core.handles.PipeWrap': 1 }), (k) => !k.includes('PipeWrap'))).toEqual([])
    expect(moved(run(base, { ...base, 'core.kit.core.watch.evictions': 3 }, { ...base, 'core.kit.core.watch.evictions': 9 }))).toEqual([])
    const peak = 'core.kit.core.watch.peakPendingEvents'
    expect(moved(run(base, { ...base, [peak]: L.watchRescanThreshold }))).toEqual([])
    expect(moved(run(base, { ...base, [peak]: L.watchRescanThreshold + 1 }))).toEqual([peak])
  })
})

describe.runIf(LAUNCHES_KEA)('no run triggers the memory watchdog', () => {
  it('I-HARN-13 · a run whose logs hold a watchdog trigger fails when it is disposed, after everything of it is removed: a soft limit as much as an action, in main.log, a rotated main.log or resources.ndjson; other lines that mention the watchdog are none; the watchdog’s own rows say so first and pass', async () => {
    const line = (o: Record<string, unknown>): string => `${JSON.stringify({ t: new Date().toISOString(), proc: 'main', ...o })}\n`
    const trigger = { process: 'gpu', pid: 7, bytes: L.watchdogSoftGpuBytes + 1, limit: 'soft', limitBytes: L.watchdogSoftGpuBytes, action: 'none' }
    const quiet =
      line({ level: 'info', msg: 'starting' }) +
      line({ level: 'info', msg: 'watchdog: action finished', process: 'core', action: 'restart', ms: 1 }) +
      line({ level: 'warn', msg: 'watchdog: idle time not read' }) +
      'not json, with the word watchdog\n'
    const logs = (run: KeaRun, files: Record<string, string>): void => {
      fs.mkdirSync(path.join(run.home, 'logs'), { recursive: true })
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(run.home, 'logs', name), text)
    }
    // nothing but lines that are no trigger: the run passes
    const clean = KeaRun.create()
    logs(clean, { 'main.log': quiet, 'resources.ndjson': line({ level: 'info', msg: 'resources', trigger: 'hourly', reports: {}, missing: {}, footprint: null }) })
    expect(watchdogTriggers(clean.home)).toEqual([])
    await clean.dispose()
    expect(fs.existsSync(clean.home)).toBe(false)

    // a trigger in each place the watchdog writes one
    const places: Record<string, string>[] = [
      { 'main.log': quiet + line({ level: 'error', msg: WATCHDOG_LOG, ...trigger }) },
      { 'main.log': quiet, 'main.log.1': line({ level: 'error', msg: WATCHDOG_LOG, ...trigger, limit: 'hard', action: 'restart' }) },
      { 'main.log': quiet, 'resources.ndjson': line({ level: 'info', msg: 'resources', trigger: 'watchdog', watchdog: [trigger], reports: {}, missing: {}, footprint: null }) },
    ]
    for (const files of places) {
      const run = KeaRun.create()
      logs(run, files)
      expect(watchdogTriggers(run.home), Object.keys(files).join(' + ')).toHaveLength(1)
      await expect(run.dispose(), Object.keys(files).join(' + ')).rejects.toThrow(/the memory watchdog triggered during this run/)
      expect(fs.existsSync(run.home), 'removed all the same').toBe(false)
    }

    // the watchdog's own rows trigger it on purpose
    const own = KeaRun.create()
    own.expectWatchdog()
    logs(own, places[0] as Record<string, string>)
    await own.dispose()
    expect(fs.existsSync(own.home)).toBe(false)
  })
})

describe.runIf(LAUNCHES_KEA)('no run’s Kea stays the frontmost app', () => {
  it('I-HARN-14 · a run whose main.log says Kea was made the frontmost app and stepped back fails when it is disposed, after everything of it is removed: in main.log or a rotated one; other lines that mention the front are none; the line the harness looks for is the one main writes', async () => {
    expect(FRONT_LOG, 'tests/support/app.ts and app/main/src/frontGuard.ts').toBe(MAIN_FRONT_LOG)
    const line = (o: Record<string, unknown>): string => `${JSON.stringify({ t: new Date().toISOString(), proc: 'main', ...o })}\n`
    const step = line({ level: 'error', msg: FRONT_LOG, on: 'active', lastWake: 'display', sinceWakeMs: 1200 })
    const quiet = line({ level: 'info', msg: 'starting' }) + line({ level: 'warn', msg: 'renderer gone', reason: 'the frontmost window' }) + 'not json, with the word frontmost\n'
    const logs = (run: KeaRun, files: Record<string, string>): void => {
      fs.mkdirSync(path.join(run.home, 'logs'), { recursive: true })
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(run.home, 'logs', name), text)
    }
    // nothing but lines that are no step back, and another process's log that holds one by name only: the run passes
    const clean = KeaRun.create()
    logs(clean, { 'main.log': quiet, 'core.log': step })
    expect(frontSteps(clean.home)).toEqual([])
    await clean.dispose()
    expect(fs.existsSync(clean.home)).toBe(false)

    for (const files of [{ 'main.log': quiet + step }, { 'main.log': quiet, 'main.log.1': step }] as Record<string, string>[]) {
      const run = KeaRun.create()
      logs(run, files)
      expect(frontSteps(run.home), Object.keys(files).join(' + ')).toHaveLength(1)
      await expect(run.dispose(), Object.keys(files).join(' + ')).rejects.toThrow(/Kea was made the frontmost app during this run/)
      expect(fs.existsSync(run.home), 'removed all the same').toBe(false)
    }
  })
})

describe('long tests asked for by their own length', () => {
  it('I-HARN-16 · the long-test guard fails a test past LONG_GUARD_MS outside KEA_LONG, but not P-GPU-2 run with KEA_GPU_SOAK_DURATION_MS nor an idle soak run with KEA_IDLE_SOAK_MS: a length asked for is no long test slipped in; the variable makes only its own test long', () => {
    const past = LONG_GUARD_MS + 60_000
    const gpu = 'P-GPU-2 · the Claude Code cassette loop with truecolor shimmer for 2 h (KEA_GPU_SOAK_DURATION_MS overrides)'
    expect(overLong(gpu, LONG_GUARD_MS, { long: false, env: {} }), 'within the guard').toBeNull()
    expect(overLong(gpu, past, { long: true, env: {} }), 'KEA_LONG').toBeNull()
    expect(overLong(gpu, past, { long: false, env: {} }), 'no length asked for').toMatch(/is a long test/)
    expect(overLong(gpu, past, { long: false, env: { KEA_GPU_SOAK_DURATION_MS: String(20 * 60_000) } }), 'the 2 h run shortened to 20 min').toBeNull()
    for (const soak of ['C-SOAK-2 · 50 idle sessions left for 12 h', 'L-MEM-17 · 50 idle sessions left for 12 h'])
      expect(overLong(soak, past, { long: false, env: { KEA_IDLE_SOAK_MS: String(30 * 60_000) } }), soak).toBeNull()
    expect(overLong('L-TERM-5 · the window closed and reopened', past, { long: false, env: { KEA_GPU_SOAK_DURATION_MS: '1', KEA_IDLE_SOAK_MS: '1' } }), 'another test with both set').toMatch(/is a long test/)
  })
})

describe('the keys an app-level test presses (tests/support/keys.ts)', () => {
  it('I-HARN-17 · a test’s Mac key is pressed as the system’s: a command’s binding as its Linux column says, at the same place in its list; a key no command binds by the Linux rule (⌘ alone → Ctrl+Shift); a text field’s editing keys as the system’s own; a label a test expects as the system shows it, and the keydown a page probe waits for; on macOS every key as written; a ⌘⇧ key no command binds, or one several commands bind differently, refused', () => {
    expect(sysKey('Meta+t', linuxKeys)).toBe('Control+Shift+t')
    expect(sysKey('Meta+3', linuxKeys), 'jumpTo’s third').toBe('Control+Shift+3')
    expect(sysKey('Meta+Shift+BracketRight', linuxKeys), 'by key code').toBe('Control+Shift+BracketRight')
    expect(sysKey('Alt+Meta+j', linuxKeys)).toBe('Control+Shift+Alt+j')
    expect(sysKey('Meta+Enter', linuxKeys), 'the composer’s ⌘↵, no command’s').toBe('Control+Shift+Enter')
    expect(sysKey('Escape', linuxKeys), 'no modifier: itself').toBe('Escape')
    expect(() => sysKey('Meta+Shift+F12', linuxKeys)).toThrow(/no Linux rule/)
    for (const k of ['Meta+t', 'Meta+3', 'Alt+Meta+j', 'Meta+Enter', 'Meta+Shift+F12']) expect(sysKey(k, darwinKeys), k).toBe(k)
    expect(textKey('Meta+a', 'linux')).toBe('Control+a')
    expect(textKey('Meta+ArrowDown', 'linux')).toBe('Control+End')
    expect(textKey('Meta+a', 'darwin')).toBe('Meta+a')
    expect(() => textKey('Meta+q', 'linux')).toThrow(/no Linux text-editing key/)
    expect(pressOf(chordOf('Control+Shift+Alt+KeyJ'))).toBe('Control+Shift+Alt+j')
    // a label a test expects: written as a Mac shows it, read as the system shows it
    expect(sysLabel('⌘R', linuxKeys)).toBe('Ctrl+Shift+R')
    expect(sysLabel('⌘,', linuxKeys)).toBe('Ctrl+Shift+,')
    expect(sysLabel('↵', linuxKeys)).toBe('Enter')
    expect(sysLabel('⌘↵', linuxKeys), 'no command’s').toBe('Ctrl+Shift+Enter')
    for (const k of ['⌘R', '⌘⇧N', '⇧⌘Y', '↵']) expect(sysLabel(k, darwinKeys), k).toBe(k)
    expect(sysAccel('⌘,', linuxKeys)).toBe('Ctrl+Shift+,')
    expect(sysAccel('⇧⌘R', linuxKeys), 'Restart Dev Server’s').toBe('Ctrl+Shift+F5')
    expect(sysAccel('⌘,', darwinKeys)).toBe('Cmd+,')
    // what a probe in the page waits for: ⌘N's keydown as this system's
    expect(pageKey('Meta+n', linuxKeys)).toEqual({ meta: false, ctrl: true, alt: false, shift: true, key: 'n' })
    expect(pageKey('Meta+Enter', linuxKeys)).toEqual({ meta: false, ctrl: true, alt: false, shift: true, key: 'enter' })
    expect(pageKey('Meta+n', darwinKeys)).toEqual({ meta: true, ctrl: false, alt: false, shift: false, key: 'n' })
  })
})
