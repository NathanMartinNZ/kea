import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SingleFileWatches } from './single.ts'

/** How long to wait for an onChange before calling it missing: generous, it only turns a missing call into a failure. */
const CHANGE_WAIT_MS = 10_000

const dirs: string[] = []
const watches: SingleFileWatches[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const w of watches.splice(0)) w.dispose()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-watch-')))
  dirs.push(d)
  return d
}

/**
 * fs.watch as macOS delivers it, with the events in the test's hands: a file's watch hears that file; a directory's
 * watch hears its direct children only, unless it is recursive (FSEvents reports every descendant, and a non-recursive
 * watch filters the rest out). Nothing is heard that the test does not `emit`, which is how a lost event looks.
 */
function fakeWatch(before?: (target: string) => void, known: () => string[] = () => []): { emit: (file: string, ev: 'rename' | 'change') => void; targets: () => string[]; recursive: () => string[] } {
  const live: { target: string; recursive: boolean; cb: (ev: string, name: string) => void; closed: boolean }[] = []
  vi.spyOn(fs, 'watch').mockImplementation(((path0: string, opts: fs.WatchOptions, cb: (ev: string, name: string) => void) => {
    // a file is watched through the descriptor it was checked on (`/dev/fd/<n>`): name it by the known file it is
    const fd = /^\/dev\/fd\/(\d+)$/.exec(path0)
    const ino = fd ? fs.fstatSync(Number(fd[1])).ino : null
    const target = ino === null ? path0 : (known().find((f) => fs.existsSync(f) && fs.statSync(f).ino === ino) ?? path0)
    before?.(target)
    const w = { target, recursive: opts?.recursive === true, cb, closed: false }
    live.push(w)
    return Object.assign(new EventEmitter(), { close: () => void (w.closed = true) }) as unknown as fs.FSWatcher
  }) as unknown as typeof fs.watch)
  return {
    emit: (file, ev) => {
      for (const w of live.filter((x) => !x.closed)) {
        const rel = path.relative(w.target, file)
        if (rel === '') w.cb(ev, path.basename(file))
        else if (!rel.startsWith('..') && (w.recursive || !rel.includes(path.sep))) w.cb(ev, rel)
      }
    },
    targets: () => live.filter((x) => !x.closed).map((x) => x.target),
    recursive: () => live.filter((x) => !x.closed && x.recursive).map((x) => x.target),
  }
}

/** onChange calls, awaited in order; the bound only turns a missing call into a failure. */
function changes(): { onChange: () => void; next: (what: string) => Promise<void> } {
  let waiting: (() => void) | null = null
  let pending = 0
  return {
    onChange: () => {
      if (!waiting) return void pending++
      const w = waiting
      waiting = null
      w()
    },
    next: (what) =>
      new Promise<void>((resolve, reject) => {
        if (pending > 0) {
          pending--
          return resolve()
        }
        const t = setTimeout(() => reject(new Error(`no change: ${what}`)), CHANGE_WAIT_MS)
        waiting = () => {
          clearTimeout(t)
          resolve()
        }
      }),
  }
}

describe('SingleFileWatches (the watch service’s single files, platform/watch)', () => {
  it('U-AGT-20 · a file whose directories appear with no event to say so (created as its ancestor’s watch starts, or while the directory stream drops events) is still followed: the next in-place rewrite reports a change and moves the watch onto the file', async () => {
    // 1. created between resolving the nearest existing ancestor and that ancestor's watch starting
    const root1 = tmp()
    const file1 = path.join(root1, 'sessions', '1.json')
    let file2 = ''
    const os1 = fakeWatch(
      (target) => {
        if (target !== root1 || fs.existsSync(file1)) return
        fs.mkdirSync(path.dirname(file1))
        fs.writeFileSync(file1, '{"registered":true}') // before the watch listens: nobody hears it
      },
      () => [file1, file2],
    )
    const w1 = new SingleFileWatches({ max: 4, recursive: true })
    watches.push(w1)
    const c1 = changes()
    w1.watch(file1, c1.onChange, [root1])
    os1.emit(file1, 'change') // rewritten in place
    await c1.next('a rewrite after a creation the ancestor’s watch never saw')
    expect(os1.targets()).toEqual([file1])

    // 2. created while the directory stream drops events (another directory watch restarting it)
    const root2 = tmp()
    file2 = path.join(root2, 'sessions', '2.json')
    const w2 = new SingleFileWatches({ max: 4, recursive: true })
    watches.push(w2)
    const c2 = changes()
    w2.watch(file2, c2.onChange, [root2])
    expect(os1.targets()).toContain(root2)
    fs.mkdirSync(path.dirname(file2))
    fs.writeFileSync(file2, '{"registered":true}') // its events lost: nothing emitted
    os1.emit(file2, 'change') // the next in-place rewrite, three levels down
    await c2.next('a rewrite after a creation whose events were lost')
    expect(os1.targets()).toContain(file2)
    expect(os1.targets()).not.toContain(root2)
    os1.emit(file2, 'change')
    await c2.next('the next rewrite, from the file’s own watch')
  })

  it('U-AGT-30 · an ancestor is watched recursively only inside the roots the watch names (the agent’s config folder): a path an agent chose elsewhere never makes core hear a whole volume; a special file in the file’s place is never watched itself', () => {
    const os1 = fakeWatch()
    const w = new SingleFileWatches({ max: 8, recursive: true })
    watches.push(w)
    const base = tmp()
    const cfg = path.join(base, 'cfg')
    // the config folder not there yet: its nearest ancestor is outside it, watched without recursion
    w.watch(path.join(cfg, 'projects', 'x', 't.jsonl'), () => undefined, [cfg])
    expect(os1.targets()).toEqual([base])
    expect(os1.recursive()).toEqual([])
    // inside the root: recursive (the directories on the way may appear unheard, U-AGT-20)
    fs.mkdirSync(cfg)
    w.watch(path.join(cfg, 'sessions', '1.json'), () => undefined, [cfg])
    expect(os1.recursive()).toEqual([cfg])
    // no root named, or a path outside every root (a forged transcript_path): never recursive
    const elsewhere = path.join(base, 'elsewhere')
    fs.mkdirSync(elsewhere)
    w.watch(path.join(elsewhere, 'deep', 'x.jsonl'), () => undefined)
    w.watch(path.join(elsewhere, 'deeper', 'y.jsonl'), () => undefined, [cfg])
    expect(os1.recursive()).toEqual([cfg])
    // a FIFO where the file should be: its folder is watched, never the FIFO (opening it would block the thread)
    const fifo = path.join(cfg, 'sessions', 'f.json')
    fs.mkdirSync(path.dirname(fifo), { recursive: true })
    execFileSync('mkfifo', [fifo])
    w.watch(fifo, () => undefined, [cfg])
    expect(os1.targets()).not.toContain(fifo)
    expect(os1.targets()).toContain(path.dirname(fifo))
  })

  it('U-PLT-29 · Linux’s way (no recursive fs.watch): no ancestor is ever watched recursively, inside the named roots too; a file waited for three levels down steps down through each folder’s own entries as they appear, then onto the file, and its next write is reported', async () => {
    const os1 = fakeWatch(undefined, () => [file])
    const w = new SingleFileWatches({ max: 8, recursive: false })
    watches.push(w)
    const cfg = tmp()
    const file = path.join(cfg, 'projects', 'x', 't.jsonl')
    const c = changes()
    w.watch(file, c.onChange, [cfg])
    expect(os1.targets()).toEqual([cfg])
    expect(os1.recursive(), 'inside the agent’s config folder too').toEqual([])
    // each level heard on its parent's own entries (inotify reports a direct child's creation)
    fs.mkdirSync(path.join(cfg, 'projects'))
    os1.emit(path.join(cfg, 'projects'), 'rename')
    await vi.waitFor(() => expect(os1.targets()).toEqual([path.join(cfg, 'projects')]))
    fs.mkdirSync(path.join(cfg, 'projects', 'x'))
    os1.emit(path.join(cfg, 'projects', 'x'), 'rename')
    await vi.waitFor(() => expect(os1.targets()).toEqual([path.join(cfg, 'projects', 'x')]))
    fs.writeFileSync(file, '{"type":"user"}\n')
    os1.emit(file, 'rename')
    await c.next('the file’s creation')
    expect(os1.targets()).toEqual([file])
    os1.emit(file, 'change')
    await c.next('a write to it, on its own watch')
    expect(os1.recursive()).toEqual([])
  })

  it('U-AGT-33 · a write that lands while core is still handling the previous change is reported too (the real fs.watch: libuv re-arms a file’s one-shot kqueue watch only once the event’s callback has returned)', async () => {
    const file = path.join(tmp(), '1.json')
    fs.writeFileSync(file, 'v0')
    const w = new SingleFileWatches({ max: 4 })
    watches.push(w)
    const seen = contents(file, (v) => {
      // the agent writes again while core is still handling this change (I-AGT-6: busy, then waiting 0.5 ms later)
      if (v === 'v1') fs.writeFileSync(file, 'v2')
    })
    w.watch(file, seen.onChange)
    await loopTurns() // the watch listens from the event loop's next poll
    fs.writeFileSync(file, 'v1')
    await seen.reach('v2', 'the write made while the change to v1 was handled')
  })

  it('U-AGT-34 · a write that lands before a new watch listens is reported (the real fs.watch: libuv registers a new watch only at the event loop’s next poll)', async () => {
    const file = path.join(tmp(), '1.json')
    fs.writeFileSync(file, 'v0')
    const w = new SingleFileWatches({ max: 4 })
    watches.push(w)
    const seen = contents(file)
    w.watch(file, seen.onChange)
    fs.writeFileSync(file, 'v1') // no turn of the event loop since the watch began
    await seen.reach('v1', 'the write made before the watch listened')
  })

  it('U-FT-8 · a file replaced by a rename (an editor’s atomic save) is still followed: each later save is reported, and so is an in-place write to the file that replaced it', async () => {
    const file = path.join(tmp(), 'settings.json')
    fs.writeFileSync(file, 'v0')
    const w = new SingleFileWatches({ max: 4 })
    watches.push(w)
    const seen = contents(file)
    w.watch(file, seen.onChange)
    await loopTurns()
    for (const v of ['v1', 'v2', 'v3']) {
      fs.writeFileSync(`${file}.tmp`, v)
      fs.renameSync(`${file}.tmp`, file)
      await seen.reach(v, `the atomic save of ${v}`)
    }
    fs.writeFileSync(file, 'v4') // in place, on the inode the last rename brought
    await seen.reach('v4', 'the in-place write after the saves')
  })

  it('U-FT-19 · a file that is not there yet and appears with no event to say so, while the directory stream restarts (its own watch just begun, another watch added, the file removed and made again): found at the look L.watchDirSettleMs after the stream last changed, reported once, its watch moved onto it; a file still missing reports nothing, and no timer is left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    /** The looks after the loop's next poll have passed; then the one look after the stream has settled. */
    const settled = async (): Promise<void> => {
      await looked()
      vi.advanceTimersByTime(L.watchDirSettleMs)
      await looked()
    }
    const root = tmp()
    const file = path.join(root, 'settings.json')
    const transcript = path.join(tmp(), 'projects', 'demo', 't.jsonl')
    const never = path.join(tmp(), 'keybindings.json')
    const os1 = fakeWatch(undefined, () => [file, transcript])
    const w = new SingleFileWatches({ max: 8 })
    watches.push(w)
    const n = { file: 0, transcript: 0, never: 0 }

    // 1. created in the first moments of its own watch (settings.json saved for the first time as core starts)
    w.watch(file, () => void n.file++)
    await looked() // the watch's own look once it listens: not there yet
    expect(n.file).toBe(0)
    fs.writeFileSync(file, '{ "terminal": { "fontSize": 15 } }') // the stream is still starting: nothing is emitted
    await settled()
    expect(n.file, 'the creation nobody announced').toBe(1)
    expect(os1.targets()).toEqual([file])

    // 2. created while another watch is added (a transcript made as another session's watch begins); its folder is
    // inside the agent's config folder, watched recursively, which hears nothing either while the stream restarts
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    w.watch(transcript, () => void n.transcript++, [path.dirname(path.dirname(transcript))])
    w.watch(never, () => void n.never++)
    await settled()
    expect([n.transcript, n.never], 'nothing is reported for files that are still missing').toEqual([0, 0])
    expect(vi.getTimerCount(), 'no timer runs while the set of directory watches holds still').toBe(0)
    const other = w.dir(tmp(), () => undefined) // the stream restarts
    await looked()
    fs.writeFileSync(transcript, '{"type":"user"}\n{"type":"user","interrupted":true}\n') // lost with the restart
    await settled()
    expect(n.transcript, 'the transcript that appeared during another watch’s start').toBe(1)
    expect(os1.targets()).toContain(transcript)
    other.dispose()

    // 3. removed (its own watch hears that) and made again while the folder's watch starts
    await settled()
    fs.rmSync(file)
    os1.emit(file, 'rename')
    await looked()
    expect(n.file, 'the removal').toBe(2)
    expect(os1.targets()).toContain(root)
    fs.writeFileSync(file, '{}') // lost
    await settled()
    expect(n.file, 'its return, unannounced').toBe(3)
    expect(os1.targets()).toContain(file)
    expect(os1.targets()).not.toContain(root)

    // still missing: never reported, still waited for on its folder, and nothing left ticking
    await settled()
    expect(n).toEqual({ file: 3, transcript: 1, never: 0 })
    expect(os1.targets()).toContain(path.dirname(never))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('U-FT-11 · a directory that does not exist yet is followed from its nearest existing ancestor (the real fs.watch): its appearance, several levels made at once, is reported; then an entry added to it; its removal; its return with what it holds, a file standing in its place waited out; a removal that takes its parent along is found at the next look', async () => {
    const root = tmp()
    const dir = path.join(root, 'worktrees', 'demo', 'wt-1')
    const w = new SingleFileWatches({ max: 4 })
    watches.push(w)
    const seen = listing(dir)
    const watch = w.dir(dir, seen.onChange)
    expect(w.counts.dirs, 'the watch counts against the cap while it waits').toBe(1)
    await loopTurns()
    expect(seen.calls(), 'nothing is reported for a directory that is still missing').toBe(0)

    fs.mkdirSync(dir, { recursive: true }) // three levels in one go: only the first is the ancestor's own entry
    await seen.reach((names) => names !== null, 'the directory appearing')
    fs.writeFileSync(path.join(dir, 'start.sh'), '#!/bin/sh\n')
    await seen.reach((names) => names?.includes('start.sh') === true, 'an entry added once it is there')

    // removed, its parent staying: the parent's watch says its name (on macOS the directory's own watch says nothing)
    fs.rmSync(dir, { recursive: true })
    await seen.reach((names) => names === null, 'its removal')
    fs.writeFileSync(dir, 'a file where the directory should be\n')
    await loopTurns()
    fs.rmSync(dir)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n')
    await seen.reach((names) => names?.includes('package.json') === true, 'its return, with what it holds')

    // removed with its parent: nothing says so; the service finds out when it next looks at its directories (any
    // directory watch added or ended), and waits for it again
    await loopTurns()
    fs.rmSync(path.join(root, 'worktrees', 'demo'), { recursive: true })
    w.dir(root, () => undefined).dispose()
    await seen.reach((names) => names === null, 'its removal along with its parent, at the next look')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'again.txt'), 'x\n')
    await seen.reach((names) => names?.includes('again.txt') === true, 'its return after that')

    // an end: nothing is heard any more
    watch.dispose()
    expect(w.counts.dirs).toBe(0)
    const before = seen.calls()
    fs.writeFileSync(path.join(dir, 'late.txt'), 'x\n')
    await loopTurns()
    expect(seen.calls()).toBe(before)
  })
})

/** The entries of `dir` at each onChange (null: not a directory); `reach` resolves once a reading passes, failing after CHANGE_WAIT_MS. */
function listing(dir: string): { onChange: () => void; reach: (pred: (names: string[] | null) => boolean, what: string) => Promise<void>; calls: () => number } {
  let n = 0
  let last: string[] | null = null
  let wake: (() => void) | null = null
  const read = (): string[] | null => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return null
    }
  }
  return {
    onChange: () => {
      n++
      last = read()
      wake?.()
    },
    calls: () => n,
    reach: (pred, what) =>
      new Promise<void>((resolve, reject) => {
        // only what an onChange showed counts: the watch must have said so
        if (n > 0 && pred(last)) return resolve()
        const t = setTimeout(() => reject(new Error(`no change: ${what} (last reading after ${n} calls: ${JSON.stringify(last)})`)), CHANGE_WAIT_MS)
        wake = () => {
          if (!pred(last)) return
          clearTimeout(t)
          wake = null
          resolve()
        }
      }),
  }
}

/** Two turns of the event loop, so a poll phase has passed (no time is waited for). */
function loopTurns(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

/** Every look that waits only for the loop's next poll has been made, its re-resolve included (no time is waited for). */
async function looked(): Promise<void> {
  await loopTurns()
  await loopTurns()
}

/** What `file` holds at each onChange; `reach` resolves once it read `want`, failing after CHANGE_WAIT_MS. */
function contents(file: string, also: (v: string) => void = () => undefined): { onChange: () => void; reach: (want: string, what: string) => Promise<void> } {
  const read: string[] = []
  let wake: (() => void) | null = null
  return {
    onChange: () => {
      const v = fs.readFileSync(file, 'utf8')
      read.push(v)
      also(v)
      wake?.()
    },
    reach: (want, what) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (!read.includes(want)) return
          clearTimeout(t)
          wake = null
          resolve()
        }
        const t = setTimeout(() => reject(new Error(`never read ${want}: ${what} (read ${JSON.stringify(read)})`)), CHANGE_WAIT_MS)
        wake = check
        check()
      }),
  }
}
