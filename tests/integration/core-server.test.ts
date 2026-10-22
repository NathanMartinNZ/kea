// The dev server in core against real holders: core assembled as main.ts assembles it, on a temp KEA_HOME, wired to a
// real ptyhost, sessions made in repos from tools/repo-factory. The servers are the process zoo's (`server`,
// `stubborn`, `forker`), run as a session's `start.sh`; every one listens on loopback only, on ports of a test
// session's own block, and is gone when its test ends (the harness ends every holder, and each test checks its ports
// are free).

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Clock, runProcess } from '@kea/kit'
import { StubWatchService } from '@kea/core/src/platform/watch/stub.ts'
import type { Watcher } from '@kea/core/src/platform/watch/watcher.ts'
import { isAvailable, L, SERVER_ROW, sessionStoreName, serverHintText, type ProjectSettings, type ServerResult, type ServerView, type SessionView } from '@kea/protocol'
import { coreOs } from '../../app/core/src/os/index.ts'
import { installTool, readCalls, type FakeCall } from '@kea-tools/fake-editor/src/index.ts'
import { parseForkerOutput, zooCommand } from '@kea-tools/process-zoo/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { helperBinary, testEnv, until } from '../support/holders.ts'
import { ownBlocks } from '../support/server-ports.ts'
import { createArgs, gitIn, repo, startSessions, type SessionsUnderTest } from './core-sessions-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function sessions(o: Parameters<typeof startSessions>[0] = {}): Promise<SessionsUnderTest> {
  const s = await startSessions({ ...o, opts: { helperPath: await helperBinary(), agentIntake: false, portProbe: ownBlocks(), ...o.opts } })
  cleanup.push(() => s.dispose())
  return s
}

function fixture(name = 'demo') {
  const r = repo(name)
  cleanup.push(() => r.dispose())
  return r
}

async function create(s: SessionsUnderTest, projectId: string, prompt: string): Promise<SessionView> {
  const r = await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt))
  const v = await s.until(r.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

const q = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`
/** A zoo program as one shell command line. */
const zooLine = (name: Parameters<typeof zooCommand>[0], args: readonly string[] = []) => {
  const c = zooCommand(name, args)
  return [c.file, ...c.args].map(q).join(' ')
}

function writeStart(cwd: string, body: string, mode = 0o755): void {
  const f = path.join(cwd, 'start.sh')
  fs.writeFileSync(f, body)
  fs.chmodSync(f, mode)
}

const view = (s: SessionsUnderTest, id: string): ServerView => s.c.core.servers.view(id)
const run = (s: SessionsUnderTest, id: string) => s.call<ServerResult>('server.run', { sessionId: id })
const stop = (s: SessionsUnderTest, id: string) => s.call<ServerResult>('server.stop', { sessionId: id })

async function state(s: SessionsUnderTest, id: string, what: string, pred: (v: ServerView) => boolean, ms?: number): Promise<ServerView> {
  let last = view(s, id)
  try {
    await until(`dev server of ${id}: ${what}`, () => pred((last = view(s, id))), ms)
  } catch (e) {
    throw new Error(`${(e as Error).message} (last: ${JSON.stringify(last)})`)
  }
  return last
}

/** Whether something accepts TCP connections on 127.0.0.1:port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect({ host: '127.0.0.1', port })
    c.once('connect', () => {
      c.destroy()
      resolve(true)
    })
    c.once('error', () => resolve(false))
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const jsonLines = (file: string): Record<string, unknown>[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : []

describe('the dev server', () => {
  it('I-SRV-1 · start.sh serving on $PORT: running in its own `server` PTY, the port found within the fast interval of its URL line, the URL as printed; its store exists only while a window shows the session', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'serve')
    writeStart(v.cwd, `#!/bin/sh\nexec ${zooLine('server', ['--color'])}\n`)
    const core = s.c.core
    const name = sessionStoreName('server', v.id)
    // no store until a window shows the session; then one row, from inside `visible.set`
    expect(core.stores.get(name)).toBeUndefined()
    const window = {}
    core.visible.set(window, v.id)
    expect(core.stores.get(name)?.get(SERVER_ROW)).toMatchObject({ state: 'stopped', source: 'startScript', ptyId: null, ports: [], url: null })

    const t0 = performance.now()
    expect(await run(s, v.id)).toEqual({ ok: true, state: 'running', reason: null })
    const up = await state(s, v.id, 'its port found', (x) => x.ports.length > 0)
    expect(performance.now() - t0).toBeLessThan(L.portScanFastMs + L.portScanExtraMs)
    expect(up).toMatchObject({ state: 'running', source: 'startScript', ports: [v.portBase], url: `http://localhost:${v.portBase}/`, exit: null, hint: null })
    expect(core.stores.get(name)?.get(SERVER_ROW)).toEqual(up)
    // Its own PTY of kind `server`, which is the Server tab; the sidebar's dot follows it
    const rec = core.terminals.record(up.ptyId as string)
    expect(rec).toMatchObject({ kind: 'server', sessionId: v.id, state: 'running', cwd: v.cwd, argv: ['./start.sh'] })
    expect(up.pid).toBe(rec?.childPid)
    expect(s.view(v.id)?.serverRunning).toBe(true)
    // PORT is the session's KEA_PORT, colours are on
    const body = await fetch(`http://127.0.0.1:${v.portBase}/`).then((res) => res.text())
    expect(body).toBe(`ok ${up.pid} ${v.portBase} PORT=${v.portBase} FORCE_COLOR=1\n`)
    // One per session. Run again changes nothing
    expect(await run(s, v.id)).toEqual({ ok: true, state: 'running', reason: null })
    expect(core.terminals.sessionRecords(v.id).filter((x) => x.kind === 'server')).toHaveLength(1)

    // hidden: the store goes, the server and what is known of it stay
    core.visible.set(window, null)
    expect(core.stores.get(name)).toBeUndefined()
    expect(view(s, v.id)).toMatchObject({ state: 'running', ports: [v.portBase] })
    core.visible.set(window, v.id)
    expect(core.stores.get(name)?.get(SERVER_ROW)).toMatchObject({ state: 'running', ports: [v.portBase], url: `http://localhost:${v.portBase}/` })

    expect(await stop(s, v.id)).toEqual({ ok: true, state: 'stopped', reason: null })
    expect(await listening(v.portBase as number)).toBe(false)
    expect(view(s, v.id)).toMatchObject({ state: 'stopped', ports: [], url: null, pid: null, ptyId: up.ptyId })
    expect(s.view(v.id)?.serverRunning).toBe(false)
    expect(core.servers.resourceCounts).toMatchObject({ live: 0, scanTimers: 0, scans: 0 })
  })

  it('I-SRV-2 · Stop escalates INT → TERM → KILL a step apart on a tree that ignores both, forks, double-forks and changes process group: no survivors, every port free, `stopped`; a second click skips to KILL', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'stubborn tree')
    const base = v.portBase as number
    const logs = { plain: path.join(s.h.home, 'forker-plain.jsonl'), orphan: path.join(s.h.home, 'forker-orphan.jsonl'), own: path.join(s.h.home, 'stubborn.jsonl') }
    // two forked children in the script's own group; an orphaned, stubborn grandchild in a group of its own; and the
    // server's own process, which ignores INT and TERM. Every one of them listens.
    writeStart(
      v.cwd,
      [
        '#!/bin/sh',
        `${zooLine('forker', ['--fork', '--children', '2', '--listen', String(base + 1), '--log', logs.plain, '--sleep', '120'])} &`,
        `${zooLine('forker', ['--double-fork', '--setpgid', '--stubborn', '--listen', String(base + 5), '--log', logs.orphan, '--sleep', '120'])} &`,
        `exec ${zooLine('stubborn', ['--log', logs.own, '--lifetime', '120'])}`,
        '',
      ].join('\n'),
    )
    const ports = [base + 1, base + 2, base + 3, base + 5, base + 6]
    // the orphan was reparented to init, so the holder's STAT does not list it: its port is not one a scan finds
    const scanned = ports.slice(0, -1)
    const pids = (): number[] => [
      ...(parseForkerOutput(fs.existsSync(logs.plain) ? fs.readFileSync(logs.plain, 'utf8') : '').ready ?? []),
      ...(parseForkerOutput(fs.existsSync(logs.orphan) ? fs.readFileSync(logs.orphan, 'utf8') : '').ready ?? []),
      ...jsonLines(logs.own).filter((l) => l.stubborn === 'ready').map((l) => l.pid as number),
    ]
    const started = async () => {
      expect((await run(s, v.id)).state).toBe('running')
      await until('the whole tree is up', () => pids().length === 6)
      expect((await state(s, v.id, 'its ports found', (x) => x.ports.length === scanned.length, 3 * L.portScanFastMs)).ports).toEqual(scanned)
      expect(await Promise.all(ports.map(listening))).toEqual(ports.map(() => true))
      return pids()
    }

    let tree = await started()
    const t0 = performance.now()
    expect(await stop(s, v.id)).toEqual({ ok: true, state: 'stopped', reason: null })
    const took = performance.now() - t0
    // INT, then TERM a step later, then KILL a step after that: back to Run within two steps and two settles
    expect(took).toBeGreaterThanOrEqual(2 * L.serverStopStepMs)
    expect(took).toBeLessThan(2 * L.serverStopStepMs + 2 * L.serverStopSettleMs)
    const own = jsonLines(logs.own).filter((l) => l.stubborn === 'signal')
    expect(own.map((l) => l.signal)).toEqual(['SIGINT', 'SIGTERM'])
    const gap = (own[1]?.ms as number) - (own[0]?.ms as number)
    expect(gap).toBeGreaterThanOrEqual(L.serverStopStepMs - L.serverStopPollMs)
    expect(gap).toBeLessThan(L.serverStopStepMs + L.serverStopSettleMs)
    // SIGINT went to the foreground group only: the forked children died of it, the orphan in its own group never saw it
    const orphan = parseForkerOutput(fs.readFileSync(logs.orphan, 'utf8'))
    expect(parseForkerOutput(fs.readFileSync(logs.plain, 'utf8')).signals.map((x) => x.signal)).toEqual(['INT', 'INT', 'INT'])
    expect(orphan.signals.filter((x) => x.role === 'grandchild').map((x) => x.signal)).toEqual(['TERM'])
    // Nothing of the tree is left, none of its ports listens
    expect(tree.filter(alive)).toEqual([])
    expect(await Promise.all(ports.map(listening))).toEqual(ports.map(() => false))
    // Killed by Kea is `stopped`, whatever it died of
    const ended = view(s, v.id)
    expect(ended).toMatchObject({ state: 'stopped', ports: [], exit: { code: null, signal: 9 } })
    expect(s.c.core.terminals.record(ended.ptyId as string)).toMatchObject({ state: 'exited', exitSignal: 9 })

    // the second click: straight to SIGKILL
    for (const f of Object.values(logs)) fs.rmSync(f, { force: true })
    tree = await started()
    const t1 = performance.now()
    const first = stop(s, v.id)
    await state(s, v.id, 'Stopping…', (x) => x.state === 'stopping')
    expect(await stop(s, v.id)).toEqual({ ok: true, state: 'stopped', reason: null })
    expect((await first).state).toBe('stopped')
    expect(performance.now() - t1).toBeLessThan(L.serverStopStepMs)
    expect(tree.filter(alive)).toEqual([])
    expect(await Promise.all(ports.map(listening))).toEqual(ports.map(() => false))
    expect(s.c.core.servers.resourceCounts).toMatchObject({ live: 0, scanTimers: 0 })
  })

  it('I-SRV-3 · how start.sh is run: executable, directly; not executable, by the interpreter its shebang names; without a shebang, by /bin/sh; a run command set on the project wins', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'interpreters')
    const mark = path.join(v.cwd, 'ran-by.txt')
    const ranBy = async (): Promise<{ text: string; argv: string[] }> => {
      fs.rmSync(mark, { force: true })
      const res = await run(s, v.id)
      expect(res.reason).toBeNull()
      const done = await state(s, v.id, 'the script has run', (x) => x.state === 'stopped' && fs.existsSync(mark))
      expect(done.exit).toEqual({ code: 0, signal: null })
      return { text: fs.readFileSync(mark, 'utf8').trim(), argv: s.c.core.terminals.record(done.ptyId as string)?.argv ?? [] }
    }
    writeStart(v.cwd, '#!/bin/sh\necho "direct $0" > ran-by.txt\n')
    expect(await ranBy()).toEqual({ text: 'direct ./start.sh', argv: ['./start.sh'] })

    writeStart(v.cwd, `#!/usr/bin/perl -w\nopen(my $f, '>', 'ran-by.txt') or die; print $f "perl $0"; close($f);\n`, 0o644) // os-ok: in /usr/bin on both systems
    expect(await ranBy()).toEqual({ text: 'perl start.sh', argv: ['/usr/bin/perl', '-w', 'start.sh'] }) // os-ok: in /usr/bin on both systems

    writeStart(v.cwd, 'echo "sh $0" > ran-by.txt\n', 0o644)
    expect(await ranBy()).toEqual({ text: 'sh start.sh', argv: ['/bin/sh', 'start.sh'] })

    // the project's run command: the user's text, one argument of `$SHELL -l -c`
    const command = `echo "command $PORT" > ran-by.txt`
    await s.call('projects.updateSettings', { id: p.id, set: { runCommand: command } })
    expect(await ranBy()).toEqual({ text: `command ${v.portBase}`, argv: ['/bin/sh', '-l', '-c', command] })
    // One Server tab, always the last run's
    expect(s.c.core.terminals.sessionRecords(v.id).filter((x) => x.kind === 'server')).toHaveLength(1)
  })

  it('I-SRV-4 · exit 0 is `stopped`, exit 1 is `crashed` with its code, stopped by Kea is `stopped`, killed by anything else is `crashed`; the Server tab keeps each run’s output until the next', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'exits')
    const core = s.c.core
    const servers = () => core.terminals.sessionRecords(v.id).filter((x) => x.kind === 'server')

    writeStart(v.cwd, `#!/bin/sh\nexec ${zooLine('server', ['--exit', '0'])}\n`)
    await run(s, v.id)
    expect(await state(s, v.id, 'exit 0', (x) => x.state !== 'running' && x.state !== 'starting')).toMatchObject({ state: 'stopped', exit: { code: 0, signal: null } })

    // Exits 1 at once
    writeStart(v.cwd, `#!/bin/sh\nexec ${zooLine('server', ['--exit', '1'])}\n`)
    await run(s, v.id)
    const crashed = await state(s, v.id, 'exit 1', (x) => x.state !== 'running' && x.state !== 'starting')
    expect(crashed).toMatchObject({ state: 'crashed', exit: { code: 1, signal: null }, hint: null })
    // the tab keeps the output (its record and its ring), and the session row shows no error
    expect(servers()).toEqual([expect.objectContaining({ ptyId: crashed.ptyId, state: 'exited', exitCode: 1 })])
    expect(fs.existsSync(path.join(s.h.home, 'sessions', v.id, `${crashed.ptyId}.ring`))).toBe(true)
    expect(s.view(v.id)).toMatchObject({ serverRunning: false, phase: 'idle', failureKind: null })

    // stopped by Kea: `stopped`, though the process ended on a signal's account
    writeStart(v.cwd, `#!/bin/sh\nexec ${zooLine('server')}\n`)
    expect((await run(s, v.id)).state).toBe('running')
    const up = await state(s, v.id, 'listening', (x) => x.ports.length > 0)
    // This run replaced the last one's tab and scrollback
    expect(servers().map((x) => x.ptyId)).toEqual([up.ptyId])
    expect(fs.existsSync(path.join(s.h.home, 'sessions', v.id, `${crashed.ptyId}.ring`))).toBe(false)
    expect((await stop(s, v.id)).state).toBe('stopped')

    // killed by something that is not Kea: `crashed`, shown as a shell reports a signal
    expect((await run(s, v.id)).state).toBe('running')
    const again = await state(s, v.id, 'listening again', (x) => x.ports.length > 0)
    process.kill(again.pid as number, 'SIGKILL')
    expect(await state(s, v.id, 'killed from outside', (x) => x.state !== 'running')).toMatchObject({ state: 'crashed', exit: { code: null, signal: 9 }, ports: [] })
    expect(await listening(v.portBase as number)).toBe(false)

    // Archiving stops a running server (stopped by Kea), and nothing of it is left
    expect((await run(s, v.id)).state).toBe('running')
    const last = await state(s, v.id, 'listening before the archive', (x) => x.ports.length > 0)
    expect(await s.call<{ archived: boolean; reasons: { kind: string }[] }>('sessions.archive', { id: v.id, confirmed: false })).toMatchObject({ archived: false, reasons: [{ kind: 'server' }] })
    expect((await s.call<{ archived: boolean }>('sessions.archive', { id: v.id, confirmed: true })).archived).toBe(true)
    expect(alive(last.pid as number)).toBe(false)
    expect(await listening(v.portBase as number)).toBe(false)
    expect(view(s, v.id)).toMatchObject({ state: 'stopped', ports: [] })
    expect(core.servers.resourceCounts).toMatchObject({ live: 0, scanTimers: 0 })
  })

  it('I-SRV-6 · core restarts (cleanly, then killed) while a server runs: it keeps running, and the new core shows `running` with the same port and URL; a server that ended meanwhile reads `crashed`, one Kea was stopping `stopped`', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'survives')
    // a second listener on a lower port: the printed URL, not the lowest port, stays the primary one
    const extra = (v.portBase as number) + 9
    writeStart(v.cwd, `#!/bin/sh\n${zooLine('server', ['--port', String(v.portBase), '--announce', 'none'])} &\nexec ${zooLine('server', ['--port', String(extra)])}\n`)
    expect((await run(s, v.id)).state).toBe('running')
    const before = await state(s, v.id, 'both ports found', (x) => x.ports.length === 2)
    expect(before).toMatchObject({ ports: [v.portBase, extra], url: `http://localhost:${extra}/` })

    for (const how of ['relaunch', 'crashAndRelaunch'] as const) {
      await s[how]()
      await s.c.reconciled()
      const after = await state(s, v.id, `running again after ${how}`, (x) => x.state === 'running' && x.ports.length === 2)
      expect(after).toEqual({ ...before, source: 'startScript' })
      expect(alive(before.pid as number)).toBe(true)
      expect(s.view(v.id)?.serverRunning).toBe(true)
    }

    // it dies while core is away: the next core reads `crashed`, whether its exit reached ptyhost before that core's
    // reconciliation, inside it (U-PTY-66) or after it; its holder is let go either way, never left an orphan
    s.c.crash()
    process.kill(before.pid as number, 'SIGKILL')
    await s.crashAndRelaunch()
    await s.c.reconciled()
    expect(await state(s, v.id, 'crashed while away', (x) => x.state !== 'running')).toMatchObject({ state: 'crashed', exit: { code: null, signal: 9 }, ports: [] })
    expect(alive(before.pid as number)).toBe(false)
    await until('its holder is let go', () => !s.h.manager.list().some((i) => i.ptyId === before.ptyId))
    expect(s.c.core.terminals.orphans.size).toBe(0)
    await until('the orphaned listener is gone too', async () => !(await listening(v.portBase as number)))

    // a Stop that core did not live to finish: the next core finishes it, and it is `stopped`
    const log = path.join(s.h.home, 'stubborn.jsonl')
    writeStart(v.cwd, `#!/bin/sh\nexec ${zooLine('stubborn', ['--log', log, '--lifetime', '120'])}\n`)
    expect((await run(s, v.id)).state).toBe('running')
    const stubborn = view(s, v.id)
    await until('the stubborn server ignores signals', () => jsonLines(log).some((l) => l.stubborn === 'ready'))
    void stop(s, v.id).catch(() => undefined)
    await state(s, v.id, 'Stopping…', (x) => x.state === 'stopping')
    await s.crashAndRelaunch()
    await s.c.reconciled()
    expect(await state(s, v.id, 'the Stop finished by the new core', (x) => x.state !== 'stopping' && x.state !== 'running', 4 * L.serverStopStepMs)).toMatchObject({ state: 'stopped', exit: { code: null, signal: 9 } })
    expect(alive(stubborn.pid as number)).toBe(false)
    // the new core began again at SIGINT (the first core may or may not have sent its own), then escalated
    const seen = jsonLines(log).filter((l) => l.stubborn === 'signal').map((l) => l.signal)
    expect(seen.at(-1)).toBe('SIGTERM')
    expect(seen.slice(0, -1).length).toBeGreaterThanOrEqual(1)
    expect(new Set(seen.slice(0, -1))).toEqual(new Set(['SIGINT']))
  })

  it('I-SRV-7 · start.sh created or deleted while the session is shown: the control appears and disappears on the root directory’s watch, on activation, and with the project’s run command', async () => {
    // the real watch service: everything here comes from the file system's own events
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'detect')
    const core = s.c.core
    const row = () => core.stores.get(sessionStoreName('server', v.id))?.get(SERVER_ROW) as ServerView | undefined
    /** What the service follows for single files and directories inside worktrees: its own watches and those carried by a worktree's stream. */
    const followed = () => {
      const c = (core.watch as Watcher).counts
      return (c.dirs ?? 0) + (c.riders ?? 0)
    }
    const window = {}
    core.visible.set(window, v.id)
    cleanup.push(() => core.visible.drop(window))
    expect(row()).toMatchObject({ state: 'stopped', source: 'none' })
    // Nothing to run, and Run says so
    expect(await run(s, v.id)).toEqual({ ok: false, state: 'stopped', reason: 'nothingToRun' })
    expect(followed(), 'one directory followed: the session’s root').toBe(1)

    // an agent creates start.sh, then removes it
    writeStart(v.cwd, '#!/bin/sh\nexit 0\n')
    await until('start.sh seen', () => row()?.source === 'startScript')
    fs.rmSync(path.join(v.cwd, 'start.sh'))
    await until('start.sh seen gone', () => row()?.source === 'none')

    // re-evaluated on activation whatever the watch saw: hidden, nothing is followed, and the row is right before
    // `visible.set` returns, sooner than any event could arrive
    core.visible.set(window, null)
    expect(followed(), 'the watch goes with the store').toBe(0)
    expect(core.servers.resourceCounts).toMatchObject({ stores: 0, watches: 0 })
    writeStart(v.cwd, '#!/bin/sh\nexit 0\n')
    core.visible.set(window, v.id)
    expect(row()?.source).toBe('startScript')

    // the project's run command counts without any start.sh, as soon as it is set
    fs.rmSync(path.join(v.cwd, 'start.sh'))
    await until('start.sh seen gone again', () => row()?.source === 'none')
    await s.call('projects.updateSettings', { id: p.id, set: { runCommand: 'true' } })
    expect(row()?.source).toBe('runCommand')
    await s.call('projects.updateSettings', { id: p.id, set: {}, unset: ['runCommand'] })
    expect(row()?.source).toBe('none')
    expect(core.servers.resourceCounts).toMatchObject({ stores: 1, watches: 1 })
    expect(followed()).toBe(1)

    // The stand-in service, for the three things the real one cannot show for certain: which directory is asked for
    // (the session's root and nothing below it); that a change is noticed only when the watch says so (no polling: with
    // real events "not yet" cannot be asserted); and that the watch is given back when the session is hidden
    const watch = new StubWatchService()
    const stub = await sessions({ opts: { watch } })
    const r2 = fixture('stubbed')
    const p2 = await stub.project(r2.root)
    const v2 = await create(stub, p2.id, 'detect by hand')
    const row2 = () => stub.c.core.stores.get(sessionStoreName('server', v2.id))?.get(SERVER_ROW) as ServerView | undefined
    stub.c.core.visible.set(window, v2.id)
    expect(row2()?.source).toBe('none')
    expect(watch.watched().filter((w) => w.kind === 'dir').map((w) => w.path)).toEqual([v2.cwd])
    writeStart(v2.cwd, '#!/bin/sh\nexit 0\n')
    expect(row2()?.source).toBe('none')
    watch.fire(path.join(v2.cwd, 'start.sh'))
    expect(row2()?.source).toBe('startScript')
    fs.rmSync(path.join(v2.cwd, 'start.sh'))
    expect(row2()?.source).toBe('startScript')
    watch.fire(path.join(v2.cwd, 'start.sh'))
    expect(row2()?.source).toBe('none')
    stub.c.core.visible.set(window, null)
    expect(watch.watched().filter((w) => w.kind === 'dir')).toEqual([])
  })

  it('I-SRV-11 · a session the window shows while it is still being created (its worktree not there yet): once it is live, a start.sh that appears in the worktree is noticed', async () => {
    let held: Promise<void> | null = null
    let release!: () => void
    let waited = 0
    const s: SessionsUnderTest = await sessions({
      opts: {
        gitEnv: async () => {
          if (held) {
            waited++
            await held
          }
          return s.env
        },
      },
    })
    const r = fixture()
    const p = await s.project(r.root)
    const core = s.c.core
    held = new Promise<void>((res) => (release = res))
    const { sessionId } = await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'shown at once'))
    // the window shows the session it has just started, as the composer's Start does: the creation waits at its git step
    await until('the git step waits', () => waited > 0)
    const window = {}
    core.visible.set(window, sessionId)
    cleanup.push(() => core.visible.drop(window))
    const row = () => core.stores.get(sessionStoreName('server', sessionId))?.get(SERVER_ROW) as ServerView | undefined
    expect(row()).toMatchObject({ state: 'stopped', source: 'none' })
    expect(fs.existsSync(s.view(sessionId)?.cwd ?? ''), 'no worktree yet').toBe(false)
    release()
    held = null
    const v = await s.until(sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
    expect(v.lifecycle).toBe('live')
    expect(row()?.source).toBe('none')
    // an agent writes start.sh: the control appears, from the file system's own events (the real watch service)
    writeStart(v.cwd, '#!/bin/sh\nexit 0\n')
    await until('start.sh seen', () => row()?.source === 'startScript')
    fs.rmSync(path.join(v.cwd, 'start.sh'))
    await until('start.sh seen gone', () => row()?.source === 'none')
    expect(core.servers.resourceCounts).toMatchObject({ stores: 1, watches: 1 })
  })

  // Kea's half of a per-session Compose stack; Docker's half, with real containers and volumes, is checked by hand.
  // Docker is never run here: `docker` and `pnpm` on the sessions' PATH are stand-ins that record how they were run
  // (tools/fake-editor)
  it('I-SRV-12 · a perSession project with the example Compose scripts (setup, start.sh, teardown), `docker` and `pnpm` stood in on the PATH: each session’s setup and start.sh get their own DB_PORT (KEA_PORT + 1) and compose project, and both servers run at once; archiving one runs only its `compose stop`; deleting it runs its `compose down --volumes`; the other session is never touched', async () => {
    const tools = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-i-srv-12-')))
    cleanup.push(() => fs.rmSync(tools, { recursive: true, force: true }))
    const log = path.join(tools, 'calls.ndjson')
    installTool(path.join(tools, 'docker'), { as: 'docker', log })
    // `pnpm` records its run too; `pnpm dev --port N` then becomes the zoo's server on N, so the two sessions' apps really are up side by side
    const recorder = installTool(path.join(tools, 'record', 'pnpm'), { as: 'pnpm', log })
    fs.writeFileSync(path.join(tools, 'pnpm'), `#!/bin/sh\n${q(recorder)} "$@" || exit 1\nif [ "$1" = dev ]; then exec ${zooLine('server')} --port "$3"; fi\n`, { mode: 0o755 })
    const s = await sessions({ env: { PATH: `${tools}:${path.dirname(process.execPath)}:${testEnv().PATH}` } })
    const r = fixture()
    // the three example scripts of a per-session Compose stack: no `#!` line (the holder's `execvp` hands such a file
    // to /bin/sh), committed, so every worktree has them
    const scripts: Record<string, string> = {
      '.kea/setup.sh': '# .kea/setup.sh\nset -eu\npnpm install --frozen-lockfile\nexport DB_PORT=$((KEA_PORT + 1))\ndocker compose up -d --wait\npnpm db:migrate\n',
      'start.sh': '# start.sh\nexport DB_PORT=$((KEA_PORT + 1))\nexec pnpm dev --port "$PORT"\n',
      '.kea/teardown.sh': '# .kea/teardown.sh\ncase "$KEA_TEARDOWN_REASON" in\n  archive) docker compose stop ;;\n  delete)  docker compose down --volumes ;;\nesac\n',
    }
    fs.mkdirSync(path.join(r.root, '.kea'), { recursive: true })
    for (const [file, body] of Object.entries(scripts)) fs.writeFileSync(path.join(r.root, file), body, { mode: 0o755 })
    gitIn(r.root, 'add', '-A')
    gitIn(r.root, 'commit', '-q', '-m', 'per-session services')
    const p = await s.project(r.root)
    await s.call('projects.updateSettings', { id: p.id, set: { services: 'perSession' } })

    /** What a stand-in was asked, as a command line; and the runs made for one session, oldest first. */
    const said = (c: FakeCall) => [c.tool, ...c.argv].join(' ')
    const of = (v: SessionView) => readCalls(log).filter((c) => c.env.KEA_SESSION_ID === v.id)
    const docker = (v: SessionView) => of(v).filter((c) => c.tool === 'docker').map(said)
    const stack = (v: SessionView) => ({ DB_PORT: String((v.portBase as number) + 1), COMPOSE_PROJECT_NAME: `kea-demo-${v.slug}` }) // the fixture project is `demo`

    // two sessions: each setup brings up its own stack
    const a = await create(s, p.id, 'stack one')
    const b = await create(s, p.id, 'stack two')
    for (const v of [a, b]) {
      await s.until(v.id, 'setup done', (x) => x.setup?.state === 'done' || x.setup?.state === 'failed')
      expect(s.view(v.id)?.setup).toMatchObject({ state: 'done', exitCode: 0 })
      const calls = of(v)
      expect(calls.map(said)).toEqual(['pnpm install --frozen-lockfile', 'docker compose up -d --wait', 'pnpm db:migrate'])
      // The stack's port is the block's second, its compose project the session's own; run in the worktree
      for (const c of calls.slice(1)) expect({ DB_PORT: c.env.DB_PORT, COMPOSE_PROJECT_NAME: c.env.COMPOSE_PROJECT_NAME, cwd: fs.realpathSync(c.cwd) }).toEqual({ ...stack(v), cwd: fs.realpathSync(v.cwd) })
      expect(calls[1]?.env.KEA_SETUP_REASON).toBe('create')
    }
    expect(stack(a).DB_PORT).not.toBe(stack(b).DB_PORT)
    expect(stack(a).COMPOSE_PROJECT_NAME).not.toBe(stack(b).COMPOSE_PROJECT_NAME)

    // both apps run at once, each on its own PORT with its own stack's port and name
    for (const v of [a, b]) {
      expect((await run(s, v.id)).ok).toBe(true)
      await state(s, v.id, 'its port found', (x) => x.ports.includes(v.portBase as number))
      const dev = of(v).at(-1) as FakeCall
      expect(said(dev)).toBe(`pnpm dev --port ${v.portBase}`)
      expect({ PORT: dev.env.PORT, DB_PORT: dev.env.DB_PORT, COMPOSE_PROJECT_NAME: dev.env.COMPOSE_PROJECT_NAME }).toEqual({ PORT: String(v.portBase), ...stack(v) })
    }
    expect([await listening(a.portBase as number), await listening(b.portBase as number)]).toEqual([true, true])
    expect(readCalls(log).filter((c) => c.tool === 'docker').map(said), 'nothing was stopped to make room').toEqual(['docker compose up -d --wait', 'docker compose up -d --wait'])

    // archive A: its server stops and only its containers are stopped (`compose stop` under its own project name)
    expect(await s.call('sessions.archive', { id: a.id, confirmed: true })).toMatchObject({ archived: true, teardownFailed: false })
    expect(docker(a)).toEqual(['docker compose up -d --wait', 'docker compose stop'])
    const stopCall = of(a).at(-1) as FakeCall
    expect({ reason: stopCall.env.KEA_TEARDOWN_REASON, COMPOSE_PROJECT_NAME: stopCall.env.COMPOSE_PROJECT_NAME }).toEqual({ reason: 'archive', COMPOSE_PROJECT_NAME: stack(a).COMPOSE_PROJECT_NAME })
    expect(await listening(a.portBase as number)).toBe(false)
    expect(docker(b), 'B’s stack was not touched').toEqual(['docker compose up -d --wait'])
    expect(await listening(b.portBase as number)).toBe(true)
    expect(view(s, b.id).state).toBe('running')

    // delete the archived A: its volumes go (`compose down --volumes`, still under its own project name)
    const [aCwd, bCwd] = [fs.realpathSync(a.cwd), fs.realpathSync(b.cwd)]
    /** A recorded directory that may be gone by now, by its real parent and its name. */
    const was = (dir: string) => path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir))
    expect(await s.call('sessions.delete', { id: a.id, deleteBranch: true })).toMatchObject({ deleted: true, teardownFailed: false })
    const all = readCalls(log)
    const down = all.at(-1) as FakeCall
    expect(said(down)).toBe('docker compose down --volumes')
    // an archived session keeps its worktree, so the teardown still runs there; the worktree is gone by now, hence `was`
    expect({ id: down.env.KEA_SESSION_ID, reason: down.env.KEA_TEARDOWN_REASON, COMPOSE_PROJECT_NAME: down.env.COMPOSE_PROJECT_NAME, cwd: was(down.cwd) }).toEqual({ id: a.id, reason: 'delete', COMPOSE_PROJECT_NAME: stack(a).COMPOSE_PROJECT_NAME, cwd: aCwd })
    expect(all.filter((c) => c.env.KEA_SESSION_ID === a.id && c.tool === 'docker').map(said)).toEqual(['docker compose up -d --wait', 'docker compose stop', 'docker compose down --volumes'])
    expect(docker(b), 'B’s stack was not touched').toEqual(['docker compose up -d --wait'])
    expect(await listening(b.portBase as number)).toBe(true)

    // delete B while it is live: its server stops, and its teardown is the delete one, in its worktree
    expect(await s.call('sessions.delete', { id: b.id, deleteBranch: true })).toMatchObject({ deleted: true, teardownFailed: false })
    expect(docker(b)).toEqual(['docker compose up -d --wait', 'docker compose down --volumes'])
    const bDown = of(b).at(-1) as FakeCall
    expect({ reason: bDown.env.KEA_TEARDOWN_REASON, COMPOSE_PROJECT_NAME: bDown.env.COMPOSE_PROJECT_NAME, cwd: was(bDown.cwd) }).toEqual({ reason: 'delete', COMPOSE_PROJECT_NAME: stack(b).COMPOSE_PROJECT_NAME, cwd: bCwd })
    expect(await listening(b.portBase as number)).toBe(false)
    expect(s.c.core.servers.resourceCounts).toMatchObject({ live: 0, scanTimers: 0 })
  })

  it('I-SRV-8 · a server running 5 minutes with its port found at 10 s: `kea-helper ports` runs at the fast interval until then, at the slow one after, plus once when the Server tab opens; `lsof` never runs; no scan after Stop', async () => {
    // the service's own clock is the test's; the server (a sleep) and its PTY are real
    let now = 1_000_000
    let seq = 1
    const timers = new Map<number, { at: number; fn: () => void }>() // bounded: the timers the service arms
    const clock: Clock = {
      now: () => now,
      setTimeout: (fn, ms) => {
        timers.set(seq, { at: now + Math.max(0, ms), fn })
        return seq++
      },
      clearTimeout: (h) => void timers.delete(h as number),
      setInterval: () => {
        throw new Error('not used')
      },
      clearInterval: () => undefined,
    }
    const t0 = now
    const advanceTo = (ms: number) => {
      const end = t0 + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
      }
      now = end
    }
    const FOUND_AT = 10_000
    const TOTAL = 5 * 60_000
    const TAB_AT = 95_000
    const scans: number[] = []
    const others: string[] = []
    let port = 0
    const runner = (async (file: string, args: readonly string[], o: Parameters<typeof runProcess>[2]) => {
      if (path.basename(file) !== 'kea-helper' || args[0] !== 'ports' || o.pool !== 'ports') {
        others.push(file)
        throw new Error(`unexpected process ${file}`)
      }
      scans.push(now - t0)
      const out = now - t0 >= FOUND_AT ? `${args[1]} tcp4 127.0.0.1 ${port}\n` : ''
      return { code: 0, signal: null, stdout: Buffer.from(out), stderr: '', stdoutBytes: out.length, truncated: false, timedOut: false, cancelled: false, durationMs: 1, queuedMs: 0, pid: 1 }
    }) as typeof runProcess

    const s = await sessions({ opts: { server: { clock, run: runner } } })
    const r = fixture()
    const p = await s.project(r.root)
    const v = await create(s, p.id, 'five minutes')
    port = v.portBase as number
    writeStart(v.cwd, '#!/bin/sh\nexec sleep 600\n')
    expect((await run(s, v.id)).state).toBe('running')

    const F = L.portScanFastMs
    const S = L.portScanSlowMs
    const expected: number[] = []
    for (let t = F; t <= FOUND_AT; t += F) expected.push(t)
    const found = expected.at(-1) as number
    for (let t = found + S; t <= TOTAL; t += S) expected.push(t)
    expected.push(TAB_AT)
    expected.sort((a, b) => a - b)
    expect(expected.filter((t) => t <= FOUND_AT)).toHaveLength(FOUND_AT / F)

    for (const [i, t] of expected.entries()) {
      // nothing runs between two expected scans
      advanceTo(t - 1)
      expect(scans).toHaveLength(i)
      advanceTo(t)
      if (t === TAB_AT) await s.call('server.scan', { sessionId: v.id })
      await until(`scan #${i + 1} at ${t} ms`, () => scans.length === i + 1 && s.c.core.servers.resourceCounts.scans === 0)
    }
    advanceTo(TOTAL)
    expect(scans).toEqual(expected)
    expect(view(s, v.id)).toMatchObject({ state: 'running', ports: [port], url: `http://localhost:${port}` })
    expect(others).toEqual([])
    expect(s.c.core.servers.resourceCounts).toMatchObject({ live: 1, scanTimers: 1 })

    // stopped: the timers are gone and no scan follows, however long
    const stopping = stop(s, v.id)
    await until('the Stop is over', async () => {
      advanceTo(now - t0 + L.serverStopPollMs)
      return view(s, v.id).state === 'stopped'
    })
    await stopping
    expect(s.c.core.servers.resourceCounts).toMatchObject({ live: 0, scanTimers: 0, scans: 0 })
    advanceTo(now - t0 + 10 * S)
    expect(scans).toEqual(expected)
    expect(others).toEqual([])
    expect(timers.size).toBe(0)
  })

  it('I-SRV-10 · a project whose start.sh always listens on one fixed port: Run in B while A serves offers "Stop it and run here" (after B’s failure the first time, before running once the port is learned); accepting stops A and runs B there; a holder that is not a Kea dev server is only named', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const a = await create(s, p.id, 'add billing')
    const b = await create(s, p.id, 'fix login')
    // a port of a third session's block: reserved for this test, and "fixed" for both servers
    const c = await create(s, p.id, 'reserve a block')
    const fixed = (c.portBase as number) + 4
    const script = `#!/bin/sh\nexec ${zooLine('server', ['--port', String(fixed)])}\n`
    writeStart(a.cwd, script)
    writeStart(b.cwd, script)
    const core = s.c.core
    const settings = (): ProjectSettings => core.projects.get(p.id)?.settings ?? {}
    const window = {}
    core.visible.set(window, b.id)
    const row = () => core.stores.get(sessionStoreName('server', b.id))?.get(SERVER_ROW) as ServerView

    expect((await run(s, a.id)).state).toBe('running')
    await state(s, a.id, 'A listens on the fixed port', (x) => x.ports.includes(fixed))
    // The port is learned (it is not one of A's own block)
    await until('the port is remembered', () => (settings().serverPorts ?? []).includes(fixed))
    expect(settings().serverPorts).toEqual([fixed])
    const aPid = view(s, a.id).pid as number

    // the first time (nothing learned yet): B runs, fails on the port, and the hint names A
    await s.call('projects.updateSettings', { id: p.id, set: {}, unset: ['serverPorts'] })
    await run(s, b.id)
    const failed = await state(s, b.id, 'the hint after the failure', (x) => x.hint !== null)
    expect(failed).toMatchObject({ state: 'crashed', exit: { code: 1, signal: null }, hint: { port: fixed, holder: { kind: 'session', sessionId: a.id, title: a.title } } })
    expect(serverHintText(failed.hint!)).toBe(`Port ${fixed} is used by session ${a.title}`)
    expect(row()).toEqual(failed)
    // accepting it: A is stopped by its own Stop, then B runs on the port
    expect(await s.call<ServerResult>('server.takeOver', { sessionId: b.id })).toEqual({ ok: true, state: 'running', reason: null })
    expect(view(s, a.id)).toMatchObject({ state: 'stopped', ports: [] })
    expect(alive(aPid)).toBe(false)
    const bUp = await state(s, b.id, 'B listens on the fixed port', (x) => x.ports.includes(fixed))
    expect(bUp).toMatchObject({ state: 'running', hint: null, url: `http://localhost:${fixed}/` })
    expect(await fetch(`http://127.0.0.1:${fixed}/`).then((res) => res.text())).toContain(`ok ${bUp.pid} ${fixed} `)
    await until('the port is remembered again', () => (settings().serverPorts ?? []).includes(fixed))

    // once learned: Run in A while B serves is refused before anything runs, with the same offer
    const before = core.terminals.sessionRecords(a.id).filter((x) => x.kind === 'server').map((x) => x.ptyId)
    expect(await run(s, a.id)).toEqual({ ok: false, state: 'stopped', reason: 'portHeld' })
    expect(view(s, a.id).hint).toEqual({ port: fixed, holder: { kind: 'session', sessionId: b.id, title: b.title } })
    expect(core.terminals.sessionRecords(a.id).filter((x) => x.kind === 'server').map((x) => x.ptyId)).toEqual(before)
    expect((await s.call<ServerResult>('server.takeOver', { sessionId: a.id })).state).toBe('running')
    expect(view(s, b.id)).toMatchObject({ state: 'stopped' })
    await state(s, a.id, 'A listens again', (x) => x.ports.includes(fixed))
    expect((await stop(s, a.id)).state).toBe('stopped')

    // Servers on their own $PORT never trip the hint, whatever was remembered
    const own = `#!/bin/sh\nexec ${zooLine('server')}\n`
    writeStart(a.cwd, own)
    writeStart(b.cwd, own)
    expect((await run(s, a.id)).state).toBe('running')
    expect((await run(s, b.id)).state).toBe('running')
    await state(s, a.id, 'A on its own port', (x) => x.ports.includes(a.portBase as number))
    await state(s, b.id, 'B on its own port', (x) => x.ports.includes(b.portBase as number))
    expect(settings().serverPorts).toEqual([fixed])
    await stop(s, a.id)
    await stop(s, b.id)

    // the port held by something that is not a Kea dev server: named (macOS lsof; Linux kea-helper ports --all), never stopped
    const stray = net.createServer()
    await new Promise<void>((res) => stray.listen({ port: fixed, host: '127.0.0.1' }, res))
    cleanup.push(() => new Promise<void>((res) => stray.close(() => res())))
    writeStart(b.cwd, script)
    await run(s, b.id)
    const named = await state(s, b.id, 'the stray holder named', (x) => x.hint !== null)
    if (isAvailable(coreOs.portOwner)) {
      expect(named.hint).toEqual({ port: fixed, holder: { kind: 'process', name: expect.stringMatching(/^node/), pid: process.pid } })
      expect(serverHintText(named.hint!)).toMatch(new RegExp(`^Port ${fixed} is used by node.* \\(pid ${process.pid}\\)$`))
    } else expect(named.hint, 'a system that cannot name a port’s holder only says the port is held').toEqual({ port: fixed, holder: { kind: 'unknown' } })
    expect(await s.call<ServerResult>('server.takeOver', { sessionId: b.id })).toEqual({ ok: false, state: 'crashed', reason: 'notHeld' })
    expect(stray.listening).toBe(true)
    await s.call('server.dismissHint', { sessionId: b.id })
    expect(row().hint).toBeNull()
  })
})
