// Processes and instances that need the real app (tests/support/app.ts); `pnpm verify` runs them all. A dev build
// started from inside a running Kea never touches its holders: one test starts it from a shell tab with the
// session variables exported by hand, another from a session's Agent tab, whose variables core injected, each with a
// temporary home of its own. That such a build uses its own ~/.kea-dev is keaHome's rule (U-FAIL-7): no test ever runs
// on the real ~/.kea-dev.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@kea/kit'
import { OBSOLETE_SESSION_ENV_VARS, SESSION_ENV_VARS } from '@kea/protocol'
import { electronBinary, frontmostPid, harnessUserHome, runAppProcesses } from '../../tools/perf/src/launch.ts'
import { KeaRun, PROMPT, shq, STEP_MS, testAppDist, until, type Kea } from '../support/app.ts'
import { holdersUnharmed } from '../support/app-chaos.ts'
import { addProject, agentTerminal, demoRepo, startSession, waitLive } from '../support/app-sessions.ts'

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

/**
 * What the first instance's ptyhost logs when a holder's connection goes (another client was admitted: a holder serves
 * one client at a time).
 */
const CONNECTION_LOST = ['holder connection closed; re-adopting', 'holder connection lost', 'holder error']

/**
 * Electron processes of `kea`'s run that are not that instance's own: anything but its main and the live processes
 * main itself reports (renderer, GPU, network, core, ptyhost). A stray core or ptyhost that failed to exit is one of
 * main's children, so it counts too.
 */
async function strangers(run: KeaRun, kea: Kea): Promise<string[]> {
  const own = new Set((await kea.appMetrics()).filter((m) => !/^stray /.test(m.serviceName ?? '')).map((m) => m.pid))
  return run
    .leftovers()
    .filter((p) => /Electron/.test(p.comm) && !own.has(p.pid))
    .map((p) => `${p.pid} ${p.args.slice(0, 120)}`)
}

/** Every path under `dir`, relative to it. */
function tree(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).map(String).sort()
}

describe('instances (app)', () => {
  it('I-HLD-25 · a second launch on the same KEA_HOME hands over to the first and exits; a stray core or ptyhost exits on its lock; the first instance is untouched', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    const holders = run.holders()
    const before = await kea.processes()

    // a second launch: Electron's single-instance lock (per userData, which main derives from KEA_HOME) sends it home;
    // the first opens its window (unfocused under --kea-perf, as the harness requires; "focuses the first" otherwise)
    const second = await runProcess(electronBinary(), [testAppDist(), `--kea-home=${run.home}`, '--kea-perf'], {
      pool: 'other',
      timeoutMs: STEP_MS,
      // the run's whole launch environment (its HOME, ZDOTDIR and fake agents): were the hand-over ever to fail, this
      // second Kea would start a core, and its agent detection must find the run's fake CLIs, never a real one
      env: run.launchEnv(),
    })
    expect([second.code, second.timedOut], 'the second launch exits by itself, cleanly').toEqual([0, false])
    await until('the first instance to take the hand-over', () => kea.logLines('main').some((l) => l.msg === 'second instance') || undefined)
    expect((await kea.mainCounts()).windows, 'no second window').toBe(1)
    await kea.assertUnfocused()

    // a stray core and a stray ptyhost for the same home: each finds the lock taken, says so, and exits (code 3)
    for (const name of ['core', 'ptyhost'] as const) {
      const stray = await kea.forkStray(name)
      expect(stray.code, `stray ${name} exit code: ${JSON.stringify(stray.messages)}`).toBe(3)
      expect(stray.messages, `stray ${name} reports the lock`).toEqual([{ k: 'locked', path: path.join(run.home, 'run', `${name}.lock`) }])
    }

    const after = await kea.processes()
    for (const k of ['main', 'core', 'ptyhost', 'renderer'] as const) expect(after[k]?.pid, `${k} untouched`).toBe(before[k]?.pid)
    await kea.echo('ihld25')
    holdersUnharmed(run, holders)
    expect(await strangers(run, kea), 'nothing of the second launch or the strays left, among main’s children too').toEqual([])
  })

  it('I-HLD-31 · a dev build started from a shell tab of a running Kea, with that shell’s session variables set, scrubs them, keeps all its state under its own home and never connects to the first instance’s holders', async () => {
    const a = KeaRun.create()
    runs.push(a)
    const b = KeaRun.create()
    runs.push(b)
    // B is typed into a shell of A, not launched by KeaRun: its own fake agents first, and the same check as a launch
    // before anything of it exists (`handStartWords`; without it B's detection would find the real Command Code in
    // /opt/homebrew/bin, I-HARN-9). Checked here, before B's rc starts recording the environments of its shells
    const bWords = b.handStartWords(a)
    const kea = await a.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    const shell = (await kea.shown()) as string
    const other = await kea.newTab()
    await kea.select(shell)
    const holders = a.holders()
    const tabs = await kea.tabIds()
    const before = await kea.processes()
    const ptyhostLines = kea.logLines('ptyhost').length

    // B's shells (and core's login-shell probe) record the environment they start with
    fs.appendFileSync(path.join(b.zdotdir, '.zshrc'), `{ print -- '--- env'; env } >> "$ZDOTDIR/env.log"\n`)
    // A's "session": every session variable core injects and the obsolete ones, pointing at A's home and A's holder
    // socket, as if B were started from an agent's terminal in A
    const target = a.holder(other)
    const vars: Record<string, string> = Object.fromEntries([...SESSION_ENV_VARS, ...OBSOLETE_SESSION_ENV_VARS].map((k) => [k, `${a.home}/${k.toLowerCase()}`]))
    vars.KEA_SOCK = target.socket
    vars.KEA_SESSION_ID = target.sessionId
    vars.KEA_PORT = '4100'
    vars.KEA_PORT_COUNT = '10'
    await kea.enter(`export ${Object.entries(vars).map(([k, v]) => `${k}=${shq(v)}`).join(' ')}`)
    const aFiles = tree(a.home)
    await kea.enter(`${bWords} ${shq(electronBinary())} ${shq(testAppDist())} ${shq(`--kea-home=${b.home}`)} --kea-perf; echo b-exited-$((40+2))`)

    // B is up: its main started on its own home, and its first shell is running under it
    const bLog = (name: 'main' | 'core' | 'ptyhost') => {
      const f = path.join(b.home, 'logs', `${name}.log`)
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    }
    const starting = await until('B’s main to start', () => {
      const l = bLog('main')
        .split('\n')
        .find((x) => x.includes('"msg":"starting"'))
      return l ? (JSON.parse(l) as { home: string; dev: boolean; scrubbed: string[] }) : undefined
    })
    expect([starting.home, starting.dev], 'B runs on its own home, as a dev build').toEqual([b.home, true])
    expect([...starting.scrubbed].sort(), 'B removed every session variable it inherited').toEqual(Object.keys(vars).sort())
    const bHolder = await until('B’s first shell', () => b.holders().find((h) => b.holderAlive(h)))
    const envLog = path.join(b.zdotdir, 'env.log')
    await until('B’s shell to record its environment', () => (fs.existsSync(envLog) && fs.readFileSync(envLog, 'utf8').includes('--- env')) || undefined)

    // nothing of A's "session" reached any of B's processes or shells
    const seenEnv = fs.readFileSync(envLog, 'utf8').split('\n')
    expect(
      seenEnv.filter((l) => Object.keys(vars).some((k) => l.startsWith(`${k}=`))),
      'session variables in an environment B’s shells started with',
    ).toEqual([])
    // B's state only under B: its holders, sockets and processes name B's home, never A's
    for (const h of b.holders()) {
      expect(h.socket.startsWith(`${b.runDir}/`), `B's holder ${h.ptyId} socket under B's home`).toBe(true)
      expect(a.holders().map((x) => x.ptyId), 'no B holder among A’s').not.toContain(h.ptyId)
    }
    const bProcs = runAppProcesses(b.home)
    expect(bProcs.length, 'B’s Electron processes').toBeGreaterThan(0)
    // (HOME is the shell's, and the harness keeps the person's home inside A's: Chromium's userData under it is B's own,
    // and on Linux every helper's command line names it, `--user-data-dir`)
    const userHome = harnessUserHome(a.home)
    expect(
      bProcs.filter((p) => p.args.replaceAll(userHome, '').includes(a.home)),
      'B processes naming A’s home',
    ).toEqual([])
    for (const name of ['main', 'core', 'ptyhost'] as const) {
      const text = bLog(name)
      expect(text.includes(a.home), `B's ${name} log names A's home`).toBe(false)
      for (const h of holders) expect(text.includes(h.ptyId), `B's ${name} log names A's PTY ${h.ptyId}`).toBe(false)
    }
    // B's window is unfocused too (--kea-perf), and B is not the frontmost app
    const front = frontmostPid()
    expect(
      front !== null && b.leftovers().some((p) => p.pid === front),
      'B is the frontmost app',
    ).toBe(false)

    // A is untouched: same holders, none refused a client or lost its connection, same processes, same tabs
    holdersUnharmed(a, holders)
    expect(
      kea
        .logLines('ptyhost')
        .slice(ptyhostLines)
        .filter((l) => CONNECTION_LOST.includes(l.msg)),
      'A’s ptyhost saw a holder connection go',
    ).toEqual([])
    const after = await kea.processes()
    for (const k of ['main', 'core', 'ptyhost', 'renderer'] as const) expect(after[k]?.pid, `A's ${k} untouched`).toBe(before[k]?.pid)
    expect(await kea.tabIds(), 'A’s tabs').toEqual(tabs)

    // B quits from A's shell (^C to its main); A's shell gets its prompt back, and A's home holds nothing new
    await kea.press('Control+c')
    await kea.waitScreen('B to exit', (s) => s.includes('b-exited-42'))
    expect(b.holderAlive(bHolder), 'B’s holders outlive B, as any Kea’s do').toBe(true)
    runs.splice(runs.indexOf(b), 1)
    await b.dispose()
    expect(
      tree(a.home).filter((f) => !aFiles.includes(f) && f !== path.relative(a.home, path.join(a.zdotdir, '.zsh_history'))),
      'files B (or anything) added under A’s home',
    ).toEqual([])
    await kea.echo('ihld31')
    holdersUnharmed(a, holders)
    expect(await strangers(a, kea), 'nothing of B left among A’s processes').toEqual([])
    await kea.assertUnfocused()
  })

  it('I-HLD-30 · a dev build started from a session’s Agent tab of a running Kea, with the variables core injected there, scrubs every one of them and never connects to the first instance’s holders', async () => {
    const a = KeaRun.create()
    runs.push(a)
    const b = KeaRun.create()
    runs.push(b)
    // B is typed into a shell of A, not launched by KeaRun: its own fake agents first, and the same check as a launch
    // before anything of it exists (`handStartWords`; without it B's detection would find the real Command Code in
    // /opt/homebrew/bin, I-HARN-9). Checked here, before B's rc starts recording the environments of its shells
    const bWords = b.handStartWords(a)
    const kea = await a.launch()
    const repo = demoRepo(a)
    await addProject(kea, repo.root)
    const id = await startSession(kea, 'start another kea')
    await waitLive(kea, id)
    await agentTerminal(kea, id)
    const holders = await until('A’s holders', () => {
      const live = a.holders().filter((h) => a.holderAlive(h))
      return live.some((h) => h.sessionId === id) ? live : undefined
    })
    const before = await kea.processes()
    const ptyhostLines = kea.logLines('ptyhost').length

    // the session's own variables, as core injected them into its Agent tab
    const injected = path.join(b.zdotdir, 'a-session.env')
    await kea.enter(`env | grep '^KEA_' > ${shq(injected)}; echo env-saved-$((40+2))`)
    await kea.waitScreen('the session’s variables saved', (s) => s.includes('env-saved-42'))
    const known = new Set<string>([...SESSION_ENV_VARS, ...OBSOLETE_SESSION_ENV_VARS])
    const vars = fs
      .readFileSync(injected, 'utf8')
      .split('\n')
      .map((l) => l.slice(0, l.indexOf('=')))
      .filter((k) => known.has(k))
    expect(vars, 'core injected the session’s variables (KEA_SESSION_ID among them)').toContain('KEA_SESSION_ID')
    // B's shells (and core's login-shell probe) record the environment they start with
    fs.appendFileSync(path.join(b.zdotdir, '.zshrc'), `{ print -- '--- env'; env } >> "$ZDOTDIR/env.log"\n`)
    await kea.enter(`${bWords} ${shq(electronBinary())} ${shq(testAppDist())} ${shq(`--kea-home=${b.home}`)} --kea-perf; echo b-exited-$((40+2))`)

    const bLog = (name: 'main' | 'core' | 'ptyhost') => {
      const f = path.join(b.home, 'logs', `${name}.log`)
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    }
    const starting = await until('B’s main to start', () => {
      const l = bLog('main')
        .split('\n')
        .find((x) => x.includes('"msg":"starting"'))
      return l ? (JSON.parse(l) as { home: string; dev: boolean; scrubbed: string[] }) : undefined
    })
    expect([starting.home, starting.dev], 'B runs on its own home, as a dev build').toEqual([b.home, true])
    expect([...starting.scrubbed].sort(), 'B removed every session variable core had injected (main’s scrubbed line)').toEqual([...vars].sort())
    const bHolder = await until('B’s first shell', () => b.holders().find((h) => b.holderAlive(h)))
    const envLog = path.join(b.zdotdir, 'env.log')
    await until('B’s shell to record its environment', () => (fs.existsSync(envLog) && fs.readFileSync(envLog, 'utf8').includes('--- env')) || undefined)
    expect(
      fs
        .readFileSync(envLog, 'utf8')
        .split('\n')
        .filter((l) => vars.some((k) => l.startsWith(`${k}=`))),
      'session variables in an environment B’s shells started with',
    ).toEqual([])
    // B's holders are B's: never one of A's, sockets under B's home; B's logs never name A's home or PTYs
    for (const h of b.holders()) {
      expect(h.socket.startsWith(`${b.runDir}/`), `B's holder ${h.ptyId} socket under B's home`).toBe(true)
      expect(a.holders().map((x) => x.ptyId), 'no B holder among A’s').not.toContain(h.ptyId)
    }
    for (const name of ['main', 'core', 'ptyhost'] as const) {
      const text = bLog(name)
      expect(text.includes(a.home), `B's ${name} log names A's home`).toBe(false)
      for (const h of holders) expect(text.includes(h.ptyId), `B's ${name} log names A's PTY ${h.ptyId}`).toBe(false)
    }
    // A is untouched: same holders, none refused a client or lost its connection, same processes
    holdersUnharmed(a, holders)
    expect(
      kea
        .logLines('ptyhost')
        .slice(ptyhostLines)
        .filter((l) => CONNECTION_LOST.includes(l.msg)),
      'A’s ptyhost saw a holder connection go',
    ).toEqual([])
    const after = await kea.processes()
    for (const k of ['main', 'core', 'ptyhost', 'renderer'] as const) expect(after[k]?.pid, `A's ${k} untouched`).toBe(before[k]?.pid)

    // B quits from the Agent tab (^C to its main); the agent's shell gets its prompt back
    await kea.press('Control+c')
    await kea.waitScreen('B to exit', (s) => s.includes('b-exited-42'))
    expect(b.holderAlive(bHolder), 'B’s holders outlive B, as any Kea’s do').toBe(true)
    runs.splice(runs.indexOf(b), 1)
    await b.dispose()
    await kea.echo('ihld30')
    holdersUnharmed(a, holders)
    expect(await strangers(a, kea), 'nothing of B left among A’s processes').toEqual([])
    await kea.assertUnfocused()
  })
})
