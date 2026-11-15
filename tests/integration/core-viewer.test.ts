// Saving from the file view through core's viewer service, beside the files service of core-files-support.ts (wired as
// core.ts wires them): reads and saves for a session the window shows only, an editable read of an unchanged file, a
// save and a tree operation never at once, and a session in poll mode reading its status again after a save. Real
// git, a temp repository, and a watcher that cannot start (poll mode) whose clock the test never moves. File references
// (`viewer.resolveRefs`): the service over one set of path checks with a stand-in file system, the terminal's beside it.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { noopLogger } from '@kea/kit'
import { L, type FileReadResult, type FileRead, type FileRef, type RefAnswer, type SaveResult } from '@kea/protocol'
import { PathChecks, type PathFs } from '@kea/core/src/editor/paths.ts'
import { StubGitFacts } from '@kea/core/src/files/facts.ts'
import type { FsModule } from '@kea/core/src/files/fsImpl.ts'
import { VisibleSet } from '@kea/core/src/platform/visible.ts'
import { StubWatchService } from '@kea/core/src/platform/watch/stub.ts'
import type { NativeWatcher } from '@kea/core/src/platform/watch/native.ts'
import { versionOf } from '@kea/core/src/viewer/read.ts'
import { SaveJournal } from '@kea/core/src/viewer/save.ts'
import { ViewerService } from '@kea/core/src/viewer/service.ts'
import { ManualClock } from '../../app/ptyhost/src/test-support.ts'
import { until } from '../support/holders.ts'
import { skipWhere } from '../support/skip.ts'
import { cleanup, gitEnv, repo, startFiles, tempDir, write, type FilesUnderTest } from './core-files-support.ts'

let t: FilesUnderTest | null = null
let viewer: ViewerService | null = null
const releases: (() => void)[] = []
afterEach(async () => {
  for (const r of releases.splice(0)) r()
  viewer?.dispose()
  viewer = null
  await t?.dispose()
  t = null
  cleanup()
})

/**
 * A stand-in for the system's trash tool that says it has started, then waits for the test to write to its FIFO before
 * it moves its arguments into a folder of the test's own (either system's arguments, as core-files-discard's).
 */
function heldTrash(): { tool: string; started: string; release(): void } {
  const home = tempDir('kea-trash-')
  const dir = path.join(home, 'moved')
  fs.mkdirSync(dir)
  const started = path.join(home, 'started')
  const go = path.join(home, 'go')
  execFileSync('/usr/bin/mkfifo', [go]) // os-ok: in /usr/bin on both systems
  const tool = path.join(home, 'trash')
  fs.writeFileSync(tool, `#!/bin/sh\n: > '${started}'\nread line < '${go}'\n[ "$1" = "-s" ] && shift\n[ "$1" = "trash" ] && shift\n[ "$1" = "--" ] && shift\nexec /bin/mv -- "$@" '${dir}/'\n`, { mode: 0o755 })
  return { tool, started, release: () => fs.writeFileSync(go, 'go\n') }
}

describe('saving from the file view in core', () => {
  it('I-FV-1 · `viewer.save` through the viewer service: refused for a session the window does not show; an editable read of an unchanged file answers `same`; a save and a tree operation in the same session refuse each other `busy`; in poll mode the git store follows a save', async () => {
    const r = repo()
    const other = tempDir('kea-other-')
    const broken: NativeWatcher = { subscribe: () => Promise.reject(new Error('FSEvents is not available')), unsubscribe: () => Promise.resolve() }
    const trash = heldTrash()
    t = await startFiles({ watcher: { native: broken, clock: new ManualClock() }, files: { trashTool: trash.tool } })
    t.session('s1', r.root)
    t.session('s2', other)

    // a save can be held at its rename, to see what runs beside it
    let gate: Promise<void> | null = null
    let reached: (() => void) | null = null
    const gated = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from: fs.PathLike, to: fs.PathLike) => {
          if (gate) {
            reached?.()
            await gate
          }
          return fs.promises.rename(from, to)
        },
      },
    } as FsModule
    const journalFile = path.join(tempDir('kea-viewer-home-'), 'save-journal.json')
    const files = t.files
    viewer = new ViewerService({
      log: t.log,
      cwd: (id) => t?.sessions.get(id)?.cwd ?? null,
      visible: t.visible,
      watch: t.watcher!,
      git: files,
      gitEnv: async () => gitEnv(),
      openTool: null,
      saves: { journal: new SaveJournal({ file: journalFile, log: t.log, fs, uid: process.getuid?.() ?? -1 }), slot: (id) => files.takeSlot(id), saved: (id) => files.saved(id), fs: gated },
    })
    const h = viewer.handlers() as Record<string, (a: object, ctx: never) => unknown>
    const call = <T>(method: string, args: object, w = 0): Promise<T> => Promise.resolve().then(() => h[method]!(args, { peer: t!.windows[w], signal: new AbortController().signal } as never)) as Promise<T>
    const file = (rel: string): string => fs.readFileSync(path.join(r.root, rel), 'utf8')

    t.show('s1')
    await t.ready('s1')
    expect(t.treeHead('s1')?.live).toBe(false) // poll mode: nothing tells core of a write
    expect(t.codes('s1')).toEqual({})

    // ── an editable read: the version of the bytes sent, whether a save could write it, the mode; `same` while unchanged ──
    const math = 'src/math.js'
    const read = await call<FileRead>('viewer.read', { sessionId: 's1', path: math, edit: {} })
    const v1 = versionOf(fs.readFileSync(path.join(r.root, math)))
    expect(read).toMatchObject({ kind: 'text', version: v1, writable: 'yes', mode: fs.statSync(path.join(r.root, math)).mode & 0o7777 })
    expect(await call<FileReadResult>('viewer.read', { sessionId: 's1', path: math, edit: { ifNotVersion: v1 } })).toEqual({ kind: 'same', writable: 'yes', mode: read.mode })
    // a read that is not a file tab's (the diff's sides) is not hashed
    expect((await call<FileRead>('viewer.read', { sessionId: 's1', path: math })).version).toBeUndefined()

    // ── refused for a session the window does not show: one showing nothing, one showing another session ──
    const text = file(math).replace('a + b', 'b + a')
    const saveArgs = { sessionId: 's1', path: math, text, base: v1, eol: 'lf' }
    await expect(call('viewer.save', saveArgs, 1)).rejects.toMatchObject({ code: 'not_visible' })
    t.show('s2', 1)
    await expect(call('viewer.save', saveArgs, 1)).rejects.toMatchObject({ code: 'not_visible' })
    await expect(call('viewer.read', { sessionId: 's1', path: math, edit: {} }, 1)).rejects.toMatchObject({ code: 'not_visible' })
    expect(file(math)).not.toBe(text)

    // ── saved in poll mode: the session reads its status again, and the Changes list shows the file ──
    const saved = await call<SaveResult>('viewer.save', saveArgs)
    const v2 = versionOf(Buffer.from(text))
    expect(saved).toEqual({ kind: 'saved', version: v2, size: Buffer.byteLength(text) })
    expect(file(math)).toBe(text)
    await until('the git store to show the saved file', () => t!.codes('s1')[math] === 'M')
    // the window's version is the old one: the file is read; at the new one, `same`
    expect(await call<FileRead>('viewer.read', { sessionId: 's1', path: math, edit: { ifNotVersion: v1 } })).toMatchObject({ kind: 'text', version: v2 })
    expect(await call<FileReadResult>('viewer.read', { sessionId: 's1', path: math, edit: { ifNotVersion: v2 } })).toEqual({ kind: 'same', writable: 'yes', mode: read.mode })

    // ── a save holds the session's slot: a tree operation meanwhile is refused `busy` ──
    const hello = 'src/hello.js'
    let open: () => void = () => undefined
    gate = new Promise<void>((resolve) => (open = resolve))
    const at = new Promise<void>((resolve) => (reached = resolve))
    const held = call<SaveResult>('viewer.save', { sessionId: 's1', path: hello, text: file(hello).replace('Helo', 'Hello'), base: versionOf(fs.readFileSync(path.join(r.root, hello))), eol: 'lf' })
    await at
    expect(await t.call('files.rename', { sessionId: 's1', path: 'README.md', name: 'READ.md' })).toEqual({ ok: false, refused: 'busy' })
    gate = null
    open()
    expect(await held).toMatchObject({ kind: 'saved' })
    expect(file(hello)).toContain('Hello, ')
    expect(fs.existsSync(path.join(r.root, 'README.md'))).toBe(true)

    // ── a tree operation holds it: a save meanwhile is refused `busy`, and writes nothing ──
    write(r.root, 'notes.txt', 'to the Trash\n')
    const trashing = t.call('files.trash', { sessionId: 's1', path: 'notes.txt', dir: false })
    await until('the trash tool to start', () => fs.existsSync(trash.started))
    const counter = 'src/counter.js'
    const counterArgs = { sessionId: 's1', path: counter, text: file(counter).replace('x += 1', 'x += 2'), base: versionOf(fs.readFileSync(path.join(r.root, counter))), eol: 'lf' }
    expect(await call<SaveResult>('viewer.save', counterArgs)).toEqual({ kind: 'refused', reason: 'busy' })
    expect(file(counter)).toContain('x += 1')
    trash.release()
    expect(await trashing).toMatchObject({ ok: true })
    expect(await call<SaveResult>('viewer.save', counterArgs)).toMatchObject({ kind: 'saved' })
    expect(file(counter)).toContain('x += 2')

    // nothing is left: no save in flight, no new file beside the saved ones, the journal empty
    expect(viewer.resourceCounts.saves).toBe(0)
    expect(fs.readdirSync(path.join(r.root, 'src')).filter((n) => n.startsWith('.kea-save-'))).toEqual([])
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toEqual([])
  })
})

/**
 * The checks' file system: the real one, except under `hung` (a mount that never answers until released) and under
 * `slow` or for `root` itself (answered after their delay). `reached` resolves when a call matching it arrives.
 */
function standIn(o: { hung?: string; slow?: string; slowMs?: number; root?: string; rootMs?: number }) {
  const held: (() => void)[] = []
  const waits: { match: (p: string) => boolean; resolve: () => void }[] = []
  const under = (dir: string | undefined, p: string): boolean => dir !== undefined && (p === dir || p.startsWith(`${dir}/`))
  const gate = <T>(p: string, real: () => Promise<T>): Promise<T> => {
    for (const w of waits.filter((x) => x.match(p))) {
      waits.splice(waits.indexOf(w), 1)
      w.resolve()
    }
    if (under(o.hung, p)) return new Promise<T>((resolve, reject) => held.push(() => void real().then(resolve, reject)))
    const delay = under(o.slow, p) ? (o.slowMs ?? 0) : p === o.root ? (o.rootMs ?? 0) : 0
    return delay > 0 ? new Promise<void>((r) => setTimeout(r, delay)).then(real) : real()
  }
  const disk: PathFs = { realpath: (p) => gate(p, () => fsp.realpath(p)), stat: (p) => gate(p, () => fsp.stat(p)) }
  const release = (): void => {
    for (const h of held.splice(0)) h()
  }
  releases.push(release)
  return { disk, release, reached: (match: (p: string) => boolean) => new Promise<void>((resolve) => waits.push({ match, resolve })) }
}

/** The viewer service over `checks`, for session S in `cwd`, which three windows show. */
function viewerOver(checks: PathChecks, cwd: string) {
  const visible = new VisibleSet()
  const service = new ViewerService({ log: noopLogger, cwd: (id) => (id === 'S' || id === 'T' ? cwd : null), visible, watch: new StubWatchService(), git: new StubGitFacts(), gitEnv: async () => ({}), openTool: null, paths: checks })
  viewer = service
  const windows = [{}, {}, {}]
  for (const w of windows) visible.set(w, 'S')
  const h = service.handlers()
  const resolve = (refs: FileRef[], w = 0, sessionId = 'S'): Promise<RefAnswer[]> =>
    Promise.resolve()
      .then(() => h['viewer.resolveRefs']!({ sessionId, from: 'src/app.ts', refs }, { peer: windows[w], signal: new AbortController().signal } as never))
      .then((r) => r.refs)
  return { service, visible, windows, resolve }
}

/** A worktree for the references: its path as named. */
function refsTree(): string {
  const wt = tempDir('kea-refs-')
  const outside = tempDir('kea-refs-out-')
  write(outside, 'secret.ts', 'x\n')
  for (const f of ['src/app.ts', 'src/util.ts', 'src/util/index.ts', 'src/out.tsx', 'src/pipe/index.ts', 'src/button.ts', 'slow/real.ts', 'lib/c.ts']) write(wt, f, 'x\n')
  for (let i = 0; i < L.viewerLinkRefsMax; i++) write(wt, `src/f${i}.ts`, 'x\n')
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(wt, 'src/out.ts'))
  execFileSync('/usr/bin/mkfifo', [path.join(wt, 'tsconfig.json')]) // os-ok: in /usr/bin on both systems
  execFileSync('/usr/bin/mkfifo', [path.join(wt, 'src/pipe/package.json')]) // os-ok: in /usr/bin on both systems
  return wt
}

const imp = (spec: string): FileRef => ({ family: 'import', spec })

describe('file references in core', () => {
  it('I-FV-2 · `viewer.resolveRefs` on a worktree: the first candidate in order wins, a link out moves on, a FIFO as tsconfig.json or package.json stalls nothing, a session the window does not show is refused, and a reference the waiting share refuses answers unknown', async () => {
    const wt = refsTree()
    // the worktree's own check answers after a moment, so three windows' lines queue up behind one another
    const s = standIn({ root: wt, rootMs: 100 })
    const checks = new PathChecks({ fs: s.disk })
    const v = viewerOver(checks, wt)
    expect(await v.resolve([imp('./util'), imp('./out'), imp('./pipe'), imp('@/x'), imp('./gone')])).toEqual([{ path: 'src/util.ts' }, { path: 'src/out.tsx' }, { path: 'src/pipe/index.ts' }, null, null])
    // a window that shows another session is refused
    v.visible.set(v.windows[2]!, 'T')
    await expect(v.resolve([imp('./util')], 2)).rejects.toMatchObject({ code: 'not_visible' })
    await expect(v.resolve([imp('./util')], 0, 'T')).rejects.toMatchObject({ code: 'not_visible' })
    v.visible.set(v.windows[2]!, 'S')
    // three windows' lines at once: the first two wait in full; the third's past the viewer's waiting share answer unknown
    const line = Array.from({ length: L.viewerLinkRefsMax }, (_, i): FileRef => ({ family: 'path', spec: `f${i}.ts` }))
    const [a, b, c] = await Promise.all([v.resolve(line, 0), v.resolve(line, 1), v.resolve(line, 2)])
    expect(a).toEqual(line.map((_, i) => ({ path: `src/f${i}.ts` })))
    expect(b).toEqual(a)
    expect(c, 'the third line overflows the waiting share').toContain('unknown')
    expect(checks.counts).toEqual({ inFlight: 0, waiting: 0, hung: 0 })
  })

  it('I-FV-2 · on a volume that ignores case, ./Button answers button.ts, the file’s own name', async (ctx) => {
    const wt = refsTree()
    skipWhere(ctx, fs.existsSync(path.join(wt, 'src/BUTTON.ts')) ? null : 'the file system tells names apart by case')
    const checks = new PathChecks()
    const v = viewerOver(checks, wt)
    expect(await v.resolve([imp('./Button')])).toEqual([{ path: 'src/button.ts' }])
  })

  it('I-FV-2 · a candidate on a hung mount two levels down answers unknown and holds that place, not the worktree’s: the terminal’s links in the session answer meanwhile, and while the viewer resolves a line of imports', async () => {
    const wt = refsTree()
    const s = standIn({ hung: path.join(wt, 'sub/mnt') })
    const checks = new PathChecks({ fs: s.disk })
    const v = viewerOver(checks, wt)
    const reached = s.reached((p) => p.startsWith(path.join(wt, 'sub/mnt')))
    const hung = v.resolve([{ family: 'path', spec: 'sub/mnt/x.ts' }])
    await reached
    // while it hangs, the terminal answers for a file elsewhere in the worktree
    expect(await checks.resolveLinks(wt, ['src/app.ts', 'lib/c.ts'])).toEqual(['src/app.ts', 'lib/c.ts'])
    expect(await hung).toEqual(['unknown'])
    expect(checks.counts.hung, 'the mount’s place is held').toBe(1)
    expect(await checks.resolveLinks(wt, ['src/app.ts'])).toEqual(['src/app.ts'])
    s.release()
    await until('the mount answered at last', () => checks.counts.inFlight === 0)
  })

  it('I-FV-2 · a slow folder (not hung): a line of imports overruns L.viewerLinkListBudgetMs and answers unknown, no check is given up for it, and the terminal’s check in the same folder still answers its file', async () => {
    const wt = refsTree()
    // three of the slow calls fit in the terminal's own deadline: one ahead of it, and its own two
    const slowMs = Math.floor(L.terminalLinkCheckDeadlineMs / 4)
    const s = standIn({ slow: path.join(wt, 'slow'), slowMs })
    const checks = new PathChecks({ fs: s.disk })
    const v = viewerOver(checks, wt)
    let calls = 0
    // the terminal asks when the list is near its budget
    const near = Math.floor((L.viewerLinkListBudgetMs - 2 * slowMs) / slowMs)
    const nearBudget = new Promise<void>((resolve) => {
      const next = (): void => {
        void s.reached((p) => p.startsWith(path.join(wt, 'slow/'))).then(() => (++calls >= near ? resolve() : next()))
      }
      next()
    })
    const line = Array.from({ length: L.viewerLinkRefsMax }, (_, i) => imp(`../slow/n${i}`))
    const imports = v.resolve(line)
    let viewerDone = false
    void imports.then(() => (viewerDone = true))
    // while the viewer resolves the line, the terminal answers elsewhere at once
    expect(await checks.resolveLinks(wt, ['src/app.ts'])).toEqual(['src/app.ts'])
    expect(viewerDone).toBe(false)
    await nearBudget
    expect(await checks.resolveLinks(wt, ['slow/real.ts']), 'the terminal’s check in the slow folder').toEqual(['slow/real.ts'])
    expect(await imports).toEqual(line.map(() => 'unknown'))
    expect(checks.counts.hung, 'no check was given up for the budget').toBe(0)
    await until('the last slow call answered', () => checks.counts.inFlight === 0)
  })
})
