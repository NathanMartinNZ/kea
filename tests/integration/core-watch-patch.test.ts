// The watch service over `@parcel/watcher` built from Kea's patch, on both systems: two faults of the binding's shared
// code, which the prebuilt bindings of both systems have. A subscription made while the process's last one is ending
// must not land on the backend that ending empties, and a path made and removed within one of the watcher's batches
// must be reported removed, not left out. Linux's own (inotify, its limits) are core-watch-linux.test.ts; core's own
// batcher is core-watch.test.ts.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isAvailable } from '@kea/protocol'
import type { Changes } from '@kea/core/src/platform/watch/batcher.ts'
import { isPatched, loadNativeWatcher, type NativeWatcher } from '@kea/core/src/platform/watch/native.ts'
import { Watcher, type WatchMode } from '@kea/core/src/platform/watch/watcher.ts'
import { coreOs } from '../../app/core/src/os/index.ts'
import { until } from '../support/holders.ts'

// the native watcher: FSEvents on macOS, inotify on Linux
const watching = isAvailable(coreOs.watcher)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function tempDir(prefix = 'kea-patch-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A folder holding `dirs` folders, with a file in each. */
function tree(dirs: number): string {
  const root = tempDir()
  for (let i = 0; i < dirs; i++) {
    fs.mkdirSync(path.join(root, `d${i}`))
    fs.writeFileSync(path.join(root, `d${i}`, 'f.txt'), `${i}`)
  }
  return root
}

/**
 * Every thread of libuv's pool held on the open of a FIFO of its own (an open for reading waits for a writer), so work
 * queued meanwhile waits, in order. `release(n)` opens the writers of the next `n` (all by default): each thread freed
 * then runs the queued work one item after another. Released at the end of the test whatever happens.
 */
function holdThreadpool(): { release(n?: number): void } {
  const size = Number(process.env.UV_THREADPOOL_SIZE) || 4
  const dir = tempDir('kea-pool-')
  const fifos = Array.from({ length: size }, (_, i) => path.join(dir, `f${i}`))
  execFileSync('mkfifo', fifos)
  const writers = new Map<number, number>()
  fifos.forEach((f, i) =>
    fs.open(f, 'r', (err, fd) => {
      // a reader is let go only once its writer has opened
      if (!err) fs.closeSync(fd)
      const wfd = writers.get(i)
      if (wfd !== undefined) fs.closeSync(wfd)
    }),
  )
  let next = 0
  const release = (n = size): void => {
    // r+: a FIFO opened for reading and writing never waits (Linux and macOS)
    for (; n > 0 && next < size; n--, next++) writers.set(next, fs.openSync(fifos[next] as string, 'r+'))
  }
  cleanups.push(() => release())
  return { release }
}

/**
 * A plain `fs.watch` of `dir`: the names the system has delivered for it so far. Opened before the writes it must hear
 * and proven live on one of them first: on macOS its FSEvents stream starts a moment after `fs.watch` returns, and a
 * write before then is never delivered (a watch opened just before each write misses one under load).
 */
function plainWatch(dir: string): Set<string> {
  const names = new Set<string>()
  const w = fs.watch(dir, (_e, n) => void (n && names.add(String(n))))
  cleanups.push(() => w.close())
  return names
}

describe.runIf(watching)('the patched watcher on both systems', () => {
  it('I-PLT-11 · a worktree followed while the process’s last stream is still ending (its unsubscribe and the next subscribe both queued before a thread runs either, then run in that order) hears its tree: the backend that unsubscribe empties is never the one the new subscription lands on', async () => {
    const real = loadNativeWatcher()
    expect(isPatched(real), 'core loads the binding built from Kea’s patch').toBe(true)
    const calls: string[] = []
    const native: NativeWatcher = {
      keaPatch: real.keaPatch,
      subscribe: (dir, fn, opts) => (calls.push(`subscribe ${dir}`), real.subscribe(dir, fn, opts)),
      unsubscribe: (dir, fn, opts) => (calls.push(`unsubscribe ${dir}`), real.unsubscribe(dir, fn, opts)),
    }
    const w = new Watcher({ native })
    cleanups.push(() => w.dispose())
    const quiet = { onChanges: () => undefined, onRescan: () => undefined, onGit: () => undefined, onReleased: () => undefined }
    for (let round = 0; round < 2; round++) {
      const a = tree(1)
      const b = tree(1)
      let modeA: WatchMode = 'starting'
      const ha = w.worktree({ root: a, gitDir: null, commonDir: null }, { ...quiet, onMode: (m) => void (modeA = m) })
      ha.setActive(true)
      await until(`round ${round}: a live`, () => modeA === 'live')

      // the only stream ends and the next starts while no thread of the pool is free to run either
      const pool = holdThreadpool()
      const from = calls.length
      ha.dispose()
      const seen = new Set<string>()
      let modeB: WatchMode = 'starting'
      const hb = w.worktree({ root: b, gitDir: null, commonDir: null }, { ...quiet, onMode: (m) => void (modeB = m), onChanges: (ch: Changes) => ch.forEach((_k, p) => seen.add(p)) })
      hb.setActive(true)
      expect(calls.slice(from), 'both reached the binding while the pool was held').toEqual([`unsubscribe ${a}`, `subscribe ${b}`])
      // one thread: the unsubscribe runs (the backend is left empty), then the subscribe
      pool.release(1)
      await until(`round ${round}: b live`, () => modeB === 'live')
      pool.release()

      fs.writeFileSync(path.join(b, 'heard.txt'), 'x')
      await until(`round ${round}: b hears its tree`, () => seen.has('heard.txt'))
      hb.dispose()
      await until(`round ${round}: every stream ended`, () => w.counts.streams === 0)
    }
  })

  it('I-PLT-12 · a file made and removed within one of the watcher’s batches (its debounce: the stream heard something under L.watchBatchMs before) is heard as removed: whoever looked at the tree between the two, as a worktree shown does, does not keep a file that is gone', async () => {
    const w = new Watcher({ native: loadNativeWatcher() })
    cleanups.push(() => w.dispose())
    const root = tree(1)
    const seen: { path: string; type: string }[] = []
    let mode: WatchMode = 'starting'
    const quiet = { onRescan: () => undefined, onGit: () => undefined, onReleased: () => undefined }
    const h = w.worktree({ root, gitDir: null, commonDir: null }, { ...quiet, onMode: (m) => void (mode = m), onChanges: (ch: Changes) => ch.forEach((type, p) => seen.push({ path: p, type })) })
    const plain = plainWatch(root)
    h.setActive(true)
    await until('live', () => mode === 'live')
    // something heard just now: the watcher's debounce holds what comes next for a while before it delivers (the plain
    // watch heard it too, so it is live for what follows)
    fs.writeFileSync(path.join(root, 'first.txt'), 'x')
    await until('the first write heard', () => seen.some((e) => e.path === 'first.txt') && plain.has('first.txt'))
    // made, looked at (it is there), and removed while that batch is still open. FSEvents merges a creation and a
    // removal of one path that reach it close together into one event (the watcher reports that as a removal, which
    // hides the fault), so the removal waits for two of the system's deliveries to a plain watch of the folder: the
    // creation's, then a second file's (each about 11 ms on macOS; at once on Linux)
    const brief = path.join(root, 'brief.txt')
    fs.writeFileSync(brief, 'x')
    await until('brief.txt delivered to a plain watch', () => plain.has('brief.txt'))
    fs.writeFileSync(path.join(root, 'mark.txt'), 'm')
    await until('mark.txt delivered to a plain watch', () => plain.has('mark.txt'))
    expect(fs.existsSync(brief)).toBe(true)
    fs.rmSync(brief)
    await until('brief.txt heard as removed', () => seen.some((e) => e.path === 'brief.txt' && e.type === 'delete'))
  })
})
