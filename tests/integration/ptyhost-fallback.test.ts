// When holders cannot detach, or the helper cannot run, with the real helper: the same binary runs non-detached as
// ptyhost's child and the terminal works; without a usable helper, terminals are unavailable with a diagnostic banner
// and nothing crashes. And the real helper started at a resource limit: that one launch fails saying which limit, and
// nothing else changes.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { constants } from 'node:os'
import path from 'node:path'
import { ptyId as newPtyId, runDir, runProcess } from '@kea/kit'
import { L } from '@kea/protocol'
import { kitOs } from '../../packages/kit/src/os/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { launchArgs, parseLaunchOutput, prepareLaunch, type LaunchRequest } from '../../app/ptyhost/src/holder/launch.ts'
import { parentPid } from '../../tools/perf/src/holders.ts'
import { helperBinary, holderAlive, holderState, killHolder, ptyhostHarness, rawTty, shortKeaHome, testEnv, until, type Harness } from '../support/holders.ts'
import { childArgv } from './ptyhost-child.ts'
import { TestRenderer, viewportText } from './ptyhost-support.ts'

const cleanups: (() => unknown)[] = []
let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
  for (const c of cleanups.splice(0).reverse()) await c()
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The banner notes ptyhost sent. Its other notes (the activity and keystroke notes a typed line brings) say nothing
 * about the fallback.
 */
/** ptyhost's banners; on Linux not the session-mode note, as a test holder has no user manager (testEnv, I-PLT-6). */
const banners = (harness: Harness) => harness.notes.filter((n) => n.m === 'pty.banner' && !(kitOs.system === 'linux' && n.a.kind === 'sessionMode'))

/** A typed line comes back through a non-detached holder: same protocol, the terminal works. */
async function echoes(harness: Harness, ptyId: string): Promise<void> {
  const r = new TestRenderer(harness.manager, ptyId)
  await until('the snapshot', () => r.snapshots === 1)
  r.input('ping-through-the-fallback')
  await until('the echo', () => viewportText(r.term).join('\n').includes('ping-through-the-fallback'))
  r.close()
}

/** After ptyhost goes, a non-detached holder ends its child's tree and itself: nothing outlives it. */
async function endsWithPtyhost(harness: Harness, ptyId: string): Promise<void> {
  const j = holderState(harness.home, ptyId)!
  expect(parentPid(j.pid!)).toBe(process.pid) // ptyhost's own child, not daemonised
  harness.stop()
  await until('the holder to end with ptyhost', () => !holderAlive(harness.home, ptyId))
  await until('its child to be gone', () => !alive(j.childPid!))
  expect(fs.existsSync(path.join(harness.home, 'run', `${ptyId}.sock`))).toBe(false)
}

describe('holder fallback', () => {
  it('I-PTY-11 · detaching refused (policy, then a failing posix_spawn): the same helper runs non-detached and works; then no usable helper: a diagnostic banner, no crash', async () => {
    // 1. the detach policy says holders may not detach
    h = await ptyhostHarness({ detach: false })
    expect(banners(h)).toEqual([{ m: 'pty.banner', a: { kind: 'notDetached', message: expect.stringMatching(/^Sessions won't survive a crash or an update of Kea — /) } }])
    const a = await h.spawn({ argv: rawTty(childArgv('echo')) })
    expect(a.info().detached).toBe(false)
    await echoes(h, a.ptyId)
    await endsWithPtyhost(h, a.ptyId)
    await h.dispose()
    h = null

    // 2. the launcher's posix_spawn fails (a stand-in that refuses unless run with --no-detach, when it is the helper)
    const real = await helperBinary()
    const dir = shortKeaHome()
    cleanups.push(() => dir.dispose())
    const stub = path.join(dir.home, 'kea-helper-stub')
    fs.writeFileSync(
      stub,
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = --no-detach ] && exec '${real}' "$@"; done\necho '{"error":"posix_spawn ${real}: Operation not permitted"}'\nexit 1\n`,
      { mode: 0o755 },
    )
    h = await ptyhostHarness({ helperSource: stub })
    expect(banners(h)).toEqual([])
    const b = await h.spawn({ argv: rawTty(childArgv('echo')) })
    expect(b.info().detached).toBe(false)
    expect(h.manager.list().map((p) => p.detached)).toEqual([false])
    expect(banners(h)).toEqual([{ m: 'pty.banner', a: { kind: 'notDetached', message: expect.stringContaining('Operation not permitted') } }])
    await echoes(h, b.ptyId)
    // later terminals go straight to the fallback
    const c = await h.spawn({ argv: rawTty(childArgv('echo')) })
    expect(c.info().detached).toBe(false)
    expect(banners(h), 'no second banner').toHaveLength(1)
    await endsWithPtyhost(h, b.ptyId)
    expect(holderAlive(h.home, c.ptyId)).toBe(false)
    await h.dispose()
    h = null

    // 3. no helper at all, then one that is not a program: terminals are unavailable, ptyhost keeps serving
    for (const broken of ['missing', 'garbage']) {
      const source = path.join(dir.home, `kea-helper-${broken}`)
      if (broken === 'garbage') fs.writeFileSync(source, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0, 1, 2, 3]), { mode: 0o755 })
      h = await ptyhostHarness({ helperSource: source })
      await expect(h.spawn({ argv: ['/bin/sh'] })).rejects.toMatchObject({ kind: 'helper' })
      expect(banners(h)).toEqual([{ m: 'pty.banner', a: { kind: 'helperMissing', message: expect.stringMatching(/^Terminals are unavailable: .*kea-helper.*pnpm helper:build/) } }])
      expect(h.manager.list()).toEqual([])
      expect(h.manager.size).toBe(0)
      await h.dispose()
      h = null
    }
  })
})

describe('a launch at a resource limit, with the real helper', () => {
  /** The largest limit on open files tried: the helper starts with far fewer (the sweep ends at the first start). */
  const FILES_TRIED_MAX = 32
  /** `ulimit`'s limit on processes: `-u` in macOS's sh (bash), `-p` in dash (Linux's /bin/sh). */
  const PROCESSES = spawnSync('/bin/sh', ['-c', 'ulimit -u'], { stdio: 'ignore' }).status === 0 ? '-u' : '-p'
  const EAGAIN = constants.errno.EAGAIN // 35 on macOS, 11 on Linux

  it('I-PTY-34 · the real helper under a limit on open files, at every step of its start (the launcher’s pipe and posix_spawn, then inside the holder: the ring, the terminal device, the state file), and under a limit on processes: each result line is read as the limit and what frees it; through ptyhost that one launch fails with those words, no banner, detaching stays on, and the next launch works', async () => {
    const real = await helperBinary()
    const dir = shortKeaHome()
    cleanups.push(() => dir.dispose())
    // a stand-in that lowers its own limit (this one process and what it starts, nothing else), then is the helper
    const stub = path.join(dir.home, 'kea-helper-limited')
    fs.writeFileSync(stub, `#!/bin/sh\n[ -n "$KEA_TEST_ULIMIT" ] && ulimit $KEA_TEST_ULIMIT\nexec '${real}' "$@"\n`, { mode: 0o755 })
    h = await ptyhostHarness({ helperSource: stub })
    const home = h.home
    const client = h.client
    const started: string[] = []
    cleanups.push(() => {
      for (const id of started) if (holderAlive(home, id)) killHolder(home, id)
    })
    /** One run of the launcher under `limit`: its result line's error as the helper printed it, or null when it started. */
    const launch = async (limit: string, noDetach = false): Promise<string | null> => {
      const ptyId = newPtyId()
      const r: LaunchRequest = {
        helper: stub,
        ptyId,
        sessionId: 's1',
        kind: 'shell',
        stateDir: path.join(home, 'sessions', 's1'),
        sock: path.join(runDir(home), `${ptyId}.sock`),
        cols: 80,
        rows: 24,
        client,
        ringBytes: L.ringBytesDefault,
        keaVersion: 'test',
        noDetach,
        spec: { file: '/usr/bin/true', args: [], env: testEnv({ KEA_TEST_ULIMIT: limit }), cwd: home }, // os-ok: in /usr/bin on both systems
      }
      prepareLaunch(r)
      const res = await runProcess(stub, launchArgs(r), { pool: 'other', env: r.spec.env, timeoutMs: L.holderLaunchTimeoutMs, maxBytes: L.holderLaunchOutputMaxBytes })
      const line = (res.stdout?.toString('utf8') ?? '').split('\n').find((l) => l.startsWith('{'))
      expect(line, `a result line under ulimit ${limit} (exit ${res.code}, signal ${res.signal}, stderr ${res.stderr})`).toBeDefined()
      const o = JSON.parse(line!) as { error?: string }
      if (o.error === undefined) started.push(ptyId)
      return o.error ?? null
    }
    const read = (error: string) => {
      try {
        parseLaunchOutput(`${JSON.stringify({ error })}\n`)
        return null
      } catch (e) {
        return { kind: (e as { kind?: string }).kind, message: (e as Error).message }
      }
    }
    const files = { kind: 'resource', message: "Couldn't start the terminal: too many open files (EMFILE). Close some sessions or terminals, then try again." }
    const processes = { kind: 'resource', message: "Couldn't start the terminal: too many processes (EAGAIN). Close some sessions, terminals or other apps, then try again." }

    // 1. open files: one more allowed each time, so each step of the start that opens one is where some run stops
    const lines: string[] = []
    for (let n = 4; n <= FILES_TRIED_MAX; n++) {
      const error = await launch(`-n ${n}`)
      if (error === null) break
      lines.push(error)
      expect(read(error), error).toEqual(files)
    }
    expect(started, 'the sweep ends with a holder that started').toHaveLength(1)
    killHolder(home, started[0]!)
    const steps = lines.map((l) => /^(pipe|posix_spawn|cannot create|cannot start the child: openpty|cannot write the state json)\b/.exec(l)?.[1])
    // macOS's posix_spawn meets the limit itself; glibc's opens nothing, so on Linux the ring is the next step after the pipe
    const spawnStep = kitOs.system === 'darwin' ? ['posix_spawn'] : []
    expect(new Set(steps), lines.join(' | ')).toEqual(new Set(['pipe', ...spawnStep, 'cannot create', 'cannot start the child: openpty', 'cannot write the state json']))
    for (const l of lines) expect(l, 'the system’s own words, with the errno').toMatch(new RegExp(`: Too many open files \\(os error ${constants.errno.EMFILE}\\)$`))

    // 2. processes: the launcher's posix_spawn of the daemon, and the non-detached holder's first fork
    const spawnRefused = await launch(`${PROCESSES} 1`)
    expect(spawnRefused).toMatch(new RegExp(`^posix_spawn .*: Resource temporarily unavailable \\(os error ${EAGAIN}\\)$`))
    expect(read(spawnRefused!)).toEqual(processes)
    const forkRefused = await launch(`${PROCESSES} 1`, true)
    expect(forkRefused).toMatch(new RegExp(`: fork: Resource temporarily unavailable \\(os error ${EAGAIN}\\)$`))
    expect(read(forkRefused!)).toEqual(processes)

    // 3. through ptyhost: the launch fails in place with those words; nothing else changes, and the next one works
    await expect(h.spawn({ argv: ['/usr/bin/true'], env: testEnv({ KEA_TEST_ULIMIT: '-n 4' }) })).rejects.toMatchObject(files) // os-ok: in /usr/bin on both systems
    await expect(h.spawn({ argv: ['/usr/bin/true'], env: testEnv({ KEA_TEST_ULIMIT: `${PROCESSES} 1` }) })).rejects.toMatchObject(processes) // os-ok: in /usr/bin on both systems
    expect(banners(h), 'no banner: the helper is fine, and so is detaching').toEqual([])
    expect(h.manager.list()).toEqual([])
    const ok = await h.spawn({ argv: rawTty(childArgv('echo')) })
    expect(ok.info().detached).toBe(true)
    await echoes(h, ok.ptyId)
    expect(banners(h)).toEqual([])
  })
})
