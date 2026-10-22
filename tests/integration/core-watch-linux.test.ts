// The watch service against Linux's kernel: `@parcel/watcher`'s inotify backend built from Kea's patch, and the
// prebuild beside it. One test runs the service in this process; the others run it in a child
// (tests/support/watch-child.ts), stopped while the inotify queue fills, or in a user namespace of its own
// (`unshare -Ur`) whose inotify limits it lowers, so neither the system's limits nor this runner's are touched. Where
// unprivileged user namespaces are refused (Ubuntu's AppArmor default, `kernel.apparmor_restrict_unprivileged_userns`),
// those parts are skipped by name.
//
// What the service does with the limits is unit-tested on every system with stand-ins. The patch's fixes of the
// binding's shared code run on both systems: core-watch-patch.test.ts.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import type { Changes } from '@kea/core/src/platform/watch/batcher.ts'
import { isPatched, loadNativeWatcher } from '@kea/core/src/platform/watch/native.ts'
import { Watcher, type WatchMode } from '@kea/core/src/platform/watch/watcher.ts'
import { fixtureGitEnv, tinyRepo } from '@kea-tools/repo-factory/src/index.ts'
import { coreOs } from '../../app/core/src/os/index.ts'
import { REPO_ROOT, until } from '../support/holders.ts'
import type { ChildIn, ChildOut } from '../support/watch-child.ts'

const linux = coreOs.system === 'linux'
const CHILD = path.join(REPO_ROOT, 'tests/support/watch-child.ts')

/** This user may make a user namespace and be its root (`unshare -Ur`). */
function usernsWorks(): boolean {
  if (!linux) return false
  try {
    execFileSync('unshare', ['-Ur', 'true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const userns = usernsWorks()

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function tempDir(prefix = 'kea-inotify-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A folder holding `dirs` folders (one watch each, and one for itself), with a file in each. */
function tree(dirs: number): string {
  const root = tempDir()
  for (let i = 0; i < dirs; i++) {
    fs.mkdirSync(path.join(root, `d${i}`))
    fs.writeFileSync(path.join(root, `d${i}`, 'f.txt'), `${i}`)
  }
  return root
}

/** The watch service in a child: what it says, in order. */
class Child {
  readonly p: ChildProcessWithoutNullStreams
  readonly seen: ChildOut[] = []

  constructor(inNamespace: boolean) {
    const node = [process.execPath, CHILD]
    this.p = inNamespace ? spawn('unshare', ['-Ur', ...node], { cwd: REPO_ROOT }) : spawn(node[0] as string, node.slice(1), { cwd: REPO_ROOT })
    readline.createInterface({ input: this.p.stdout }).on('line', (l) => this.seen.push(JSON.parse(l) as ChildOut))
    let err = ''
    this.p.stderr.on('data', (d: Buffer) => void (err += d.toString()))
    cleanups.push(() => {
      // the test's own child: let it go on if a failure left it stopped, then end it
      this.p.kill('SIGCONT')
      this.p.kill('SIGKILL')
      if (err) console.log(`watch child stderr:\n${err}`)
    })
  }

  send(m: ChildIn): void {
    this.p.stdin.write(`${JSON.stringify(m)}\n`)
  }

  count(pred: (o: ChildOut) => boolean): number {
    return this.seen.filter(pred).length
  }

  /** The first line from index `from` on that `pred` takes. */
  async next<T extends ChildOut>(what: string, pred: (o: ChildOut) => o is T, from = 0, ms?: number): Promise<T> {
    let found: T | undefined
    await until(
      what,
      () => {
        const e = this.seen.find((o, i) => i >= from && o.ev === 'error')
        if (e) throw new Error(`the watch child failed: ${JSON.stringify(e)}`)
        found = this.seen.slice(from).find(pred)
        return found !== undefined
      },
      ms,
    )
    return found as T
  }

  async counts(): Promise<Extract<ChildOut, { ev: 'counts' }>> {
    const from = this.seen.length
    this.send({ op: 'counts' })
    return this.next('counts', (o): o is Extract<ChildOut, { ev: 'counts' }> => o.ev === 'counts', from)
  }
}

const isMode =
  (root: string, mode: WatchMode) =>
  (o: ChildOut): o is Extract<ChildOut, { ev: 'mode' }> =>
    o.ev === 'mode' && o.root === root && o.mode === mode
const isBanner = (o: ChildOut): o is Extract<ChildOut, { ev: 'banner' }> => o.ev === 'banner'
const isCleared = (o: ChildOut): o is Extract<ChildOut, { ev: 'cleared' }> => o.ev === 'cleared'
const isReady = (o: ChildOut): o is Extract<ChildOut, { ev: 'ready' }> => o.ev === 'ready'
const isTick = (o: ChildOut): o is Extract<ChildOut, { ev: 'tick' }> => o.ev === 'tick'

describe.runIf(linux)('the watch service on Linux’s inotify', () => {
  it.runIf(userns)('I-PLT-3 · inotify: a worktree past max_user_watches (lowered in a user namespace) falls back to refresh-on-focus with its banner, the watches its failed subscription left are freed (by the patch, or by the streams’ restart with the prebuild), and no subscription is tried again until the limit is raised', async () => {
    for (const binding of ['patched', 'prebuilt'] as const) {
      const small = tree(4)
      const big = tree(60)
      const c = new Child(true)
      c.send({ op: 'setup', binding, watches: 30 })
      expect((await c.next(`${binding}: ready`, isReady)).patched).toBe(binding === 'patched')
      c.send({ op: 'follow', root: small })
      await c.next(`${binding}: the small tree live`, isMode(small, 'live'))
      const alone = (await c.counts()).own
      expect(alone, 'one watch per directory').toBe(5)

      const from = c.seen.length
      c.send({ op: 'follow', root: big })
      await c.next(`${binding}: the big tree polls`, isMode(big, 'poll'), from)
      const banner = await c.next(`${binding}: the banner`, isBanner)
      expect(banner.message).toContain('inotify watch limit (fs.inotify.max_user_watches = 30)')
      expect(banner.message).toMatch(/Kea holds \d+ watches/)
      expect(banner.fix).toContain(`fs.inotify.max_user_watches=${L.inotifyWatchesSuggested}`)
      if (binding === 'prebuilt') {
        // every stream ended and the followed one started again, which took the failed subscription's watches along
        await c.next('the small tree polled for the drain', isMode(small, 'poll'), from)
        await c.next('…and is live again', isMode(small, 'live'), c.seen.findIndex((o, i) => i >= from && isMode(small, 'poll')(o)))
      }
      await until(`${binding}: only the small tree’s watches are held`, async () => (await c.counts()).own === alone)

      // the limit still holds: a focus reads it, and nothing is tried
      const held = c.seen.length
      c.send({ op: 'focus' })
      const counts = await c.counts()
      expect(counts.counts.limitHeld).toBe(1)
      expect(c.count((o) => o.ev === 'mode' && o.root === big && c.seen.indexOf(o) >= held)).toBe(0)

      // raised: the next refresh trigger starts it, and the banner goes
      c.send({ op: 'limits', watches: 1000 })
      c.send({ op: 'focus' })
      await c.next(`${binding}: the big tree live`, isMode(big, 'live'), held)
      await c.next(`${binding}: the banner cleared`, isCleared, held)
      expect((await c.counts()).own).toBe(alone + 61)
    }
  })

  it('I-PLT-3 · an inotify queue overflow (core stopped while a tree changes past the queue) is reported as "must rescan": one full refresh, the stream goes on and later changes are heard', async () => {
    const root = tree(1)
    const c = new Child(false)
    c.send({ op: 'setup', binding: 'patched' })
    expect((await c.next('ready', isReady)).patched).toBe(true)
    c.send({ op: 'follow', root })
    await c.next('live', isMode(root, 'live'))
    // os-ok: a Linux-only test reads inotify's queue length, to fill it
    const max = Number(fs.readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8'))
    c.p.kill('SIGSTOP')
    // a creation and a write each: twice the files are queued, past the queue (and under L.watchRescanThreshold)
    const files = Math.ceil(max * 0.75)
    expect(files).toBeLessThan(L.watchRescanThreshold)
    for (let i = 0; i < files; i++) fs.writeFileSync(path.join(root, `f${i}`), 'x')
    const from = c.seen.length
    c.p.kill('SIGCONT')
    await c.next('one rescan for the overflow', (o): o is ChildOut => o.ev === 'rescan' && o.root === root && o.why === 'dropped', from)
    fs.writeFileSync(path.join(root, 'after.txt'), 'y')
    await c.next('a later change', (o): o is ChildOut => o.ev === 'changes' && o.paths.includes('after.txt'), from)
    expect(c.count((o) => o.ev === 'mode' && o.root === root && c.seen.indexOf(o) >= from), 'the stream never ended').toBe(0)
  })

  it('I-PLT-7 · the patched watcher (the prebuild never walks a folder made or moved in): inside a followed worktree, mkdir -p three levels deep with a file at each level, a tree moved in, cp -r and a git checkout that adds nested folders are all heard, file by file, and so is a later write deep inside each', async () => {
    const native = loadNativeWatcher()
    expect(isPatched(native), 'core loads the binding built from Kea’s patch').toBe(true)
    const repo = tinyRepo()
    cleanups.push(() => repo.dispose())
    const root = repo.root
    const env = fixtureGitEnv()
    const git = (...args: string[]): void => void execFileSync('git', ['-C', root, ...args], { env, stdio: 'ignore' })
    // a branch with nested folders, then back to main: the checkout below adds them
    git('switch', '-q', '-c', 'nested')
    fs.mkdirSync(path.join(root, 'n1', 'n2', 'n3'), { recursive: true })
    fs.writeFileSync(path.join(root, 'n1', 'n2', 'n3', 'deep.txt'), 'n')
    fs.writeFileSync(path.join(root, 'n1', 'top.txt'), 'n')
    git('add', '-A')
    git('commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'nested')
    git('switch', '-q', 'main')
    expect(fs.existsSync(path.join(root, 'n1'))).toBe(false)

    const w = new Watcher({ native })
    cleanups.push(() => w.dispose())
    const seen = new Map<string, string>()
    let mode: WatchMode = 'starting'
    const h = w.worktree(
      { root, gitDir: null, commonDir: null },
      {
        onChanges: (ch: Changes) => {
          for (const [p, k] of ch) seen.set(p, k)
        },
        onRescan: () => undefined,
        onGit: () => undefined,
        onMode: (m) => void (mode = m),
        onReleased: () => undefined,
      },
    )
    h.setActive(true)
    await until('live', () => mode === 'live')
    const heard = (what: string, files: string[]): Promise<void> => until(what, () => files.every((f) => seen.has(f)))

    // mkdir -p three levels, a file at each level, made at once
    const p1 = ['a/1.txt', 'a/b/2.txt', 'a/b/c/3.txt']
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true })
    for (const f of p1) fs.writeFileSync(path.join(root, f), f)
    await heard('mkdir -p and its files', p1)

    // a tree moved in from outside the worktree (same file system)
    const outside = tempDir()
    fs.mkdirSync(path.join(outside, 't', 'x', 'y'), { recursive: true })
    fs.writeFileSync(path.join(outside, 't', 'x', 'y', 'z.txt'), 'z')
    fs.writeFileSync(path.join(outside, 't', 'top.txt'), 't')
    fs.renameSync(path.join(outside, 't'), path.join(root, 'moved'))
    const p2 = ['moved/top.txt', 'moved/x/y/z.txt']
    await heard('the tree moved in', p2)

    // cp -r
    fs.mkdirSync(path.join(outside, 's', 'q', 'r'), { recursive: true })
    fs.writeFileSync(path.join(outside, 's', 'q', 'r', 'w.txt'), 'w')
    execFileSync('cp', ['-r', path.join(outside, 's'), path.join(root, 'copied')])
    const p3 = ['copied/q/r/w.txt']
    await heard('cp -r', p3)

    // a checkout that adds nested folders
    git('switch', '-q', 'nested')
    const p4 = ['n1/top.txt', 'n1/n2/n3/deep.txt']
    await heard('git checkout', p4)

    // later writes deep inside each: heard on the watches the walks added
    seen.clear()
    const later = [p1[2], p2[1], p3[0], p4[1]] as string[]
    for (const f of later) fs.appendFileSync(path.join(root, f), '+')
    await heard('later writes deep inside', later)
  })

  it.runIf(userns)('I-PLT-8 · the backend that cannot start (the prebuild’s subscribe then waits forever): with the user’s inotify instances used up (a user namespace’s max_inotify_instances at 0), no first subscription is tried with the prebuild (the interim guard) and the patched one rejects within L.watchStartTimeoutMs; core’s thread never blocks (a timer keeps firing), the worktree refreshes on focus with its banner, and starts once an instance is free', async () => {
    for (const binding of ['prebuilt', 'patched'] as const) {
      const root = tree(2)
      const c = new Child(true)
      c.send({ op: 'setup', binding, instances: 0 })
      await c.next(`${binding}: ready`, isReady)
      const from = c.seen.length
      const t0 = performance.now()
      c.send({ op: 'follow', root })
      await c.next(`${binding}: refresh on focus`, isMode(root, 'poll'), from, L.watchStartTimeoutMs)
      expect(performance.now() - t0).toBeLessThan(L.watchStartTimeoutMs)
      const banner = await c.next(`${binding}: the banner`, isBanner, from)
      expect(banner.message).toContain('inotify instances are at the system’s limit (fs.inotify.max_user_instances = 0)')
      // core's thread goes on: the child's timer keeps firing after the subscription
      const ticks = c.count(isTick)
      await until(`${binding}: ticks after the follow`, () => c.count(isTick) >= ticks + 3)
      expect((await c.counts()).counts.limitHeld).toBe(1)

      const raised = c.seen.length
      c.send({ op: 'limits', instances: 128 })
      c.send({ op: 'focus' })
      await c.next(`${binding}: live once an instance is free`, isMode(root, 'live'), raised)
      await c.next(`${binding}: the banner cleared`, isCleared, raised)
    }
  })
})
