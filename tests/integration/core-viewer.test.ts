// Saving from the file view through core's viewer service, beside the files service of core-files-support.ts (wired as
// core.ts wires them): reads and saves for a session the window shows only, an editable read of an unchanged file, a
// save and a tree operation never at once, and a session in poll mode reading its status again after a save. Real
// git, a temp repository, and a watcher that cannot start (poll mode) whose clock the test never moves.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileReadResult, FileRead, SaveResult } from '@kea/protocol'
import type { FsModule } from '@kea/core/src/files/fsImpl.ts'
import type { NativeWatcher } from '@kea/core/src/platform/watch/native.ts'
import { versionOf } from '@kea/core/src/viewer/read.ts'
import { SaveJournal } from '@kea/core/src/viewer/save.ts'
import { ViewerService } from '@kea/core/src/viewer/service.ts'
import { ManualClock } from '../../app/ptyhost/src/test-support.ts'
import { until } from '../support/holders.ts'
import { cleanup, gitEnv, repo, startFiles, tempDir, write, type FilesUnderTest } from './core-files-support.ts'

let t: FilesUnderTest | null = null
let viewer: ViewerService | null = null
afterEach(async () => {
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
