import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { scanForGit, walkDisk, type ScanFs, type WalkFs } from './disk-walk.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-walk-')))
  dirs.push(d)
  return d
}
const allocated = (...paths: string[]): number => paths.reduce((n, p) => n + fs.lstatSync(p).blocks * 512, 0)

describe('the size walk', () => {
  it('U-WT-15 · the walk sums allocated blocks: a clone and a hard link count in full (an upper bound), a symlink counts as itself and is never followed, and the rebuildable folders’ share is summed on the way', () => {
    const outside = tmp()
    fs.writeFileSync(path.join(outside, 'huge.bin'), Buffer.alloc(4 << 20, 1))
    const wt = tmp()
    const p = (...s: string[]) => path.join(wt, ...s)
    for (const d of ['src', 'node_modules/dep/lib', 'packages/web/dist', 'packages/web/src', 'empty']) fs.mkdirSync(p(d), { recursive: true })
    const big = Buffer.alloc(1 << 20, 7)
    fs.writeFileSync(p('src/a.bin'), big)
    // a clone (a plain copy where the volume cannot clone) and a hard link: no new blocks on disk, counted in full
    fs.copyFileSync(p('src/a.bin'), p('src/clone.bin'), fs.constants.COPYFILE_FICLONE)
    fs.linkSync(p('src/a.bin'), p('node_modules/dep/lib/hard.bin'))
    fs.writeFileSync(p('node_modules/dep/index.js'), 'x'.repeat(5000))
    fs.writeFileSync(p('packages/web/dist/out.js'), 'y'.repeat(9000))
    fs.writeFileSync(p('packages/web/src/in.ts'), 'z')
    // links out of the worktree, to a file and to a folder, a link back to the worktree (a loop if followed), a dangling one
    fs.symlinkSync(path.join(outside, 'huge.bin'), p('src/link-to-file'))
    fs.symlinkSync(outside, p('node_modules/link-to-dir'))
    fs.symlinkSync(wt, p('packages/loop'))
    fs.symlinkSync(p('nowhere'), p('dangling'))

    const every = ['', 'src', 'src/a.bin', 'src/clone.bin', 'src/link-to-file', 'node_modules', 'node_modules/dep', 'node_modules/dep/lib', 'node_modules/dep/lib/hard.bin', 'node_modules/dep/index.js', 'node_modules/link-to-dir', 'packages', 'packages/web', 'packages/web/dist', 'packages/web/dist/out.js', 'packages/web/src', 'packages/web/src/in.ts', 'packages/loop', 'empty', 'dangling']
    const rebuildable = every.filter((e) => e === 'node_modules' || e.startsWith('node_modules/') || e === 'packages/web/dist' || e.startsWith('packages/web/dist/'))
    const r = walkDisk({ root: wt, rebuildable: ['node_modules', 'packages/web/dist/'], timeoutMs: L.diskWalkTimeoutMs })
    expect(r.capped).toBe(false)
    expect(r.entries).toBe(every.length)
    expect(r.bytes).toBe(allocated(...every.map((e) => p(e))))
    expect(r.rebuildableBytes).toBe(allocated(...rebuildable.map((e) => p(e))))
    // the one megabyte is on disk once and counted three times; the 4 MiB outside, behind two links, not at all
    const one = allocated(p('src/a.bin'))
    expect(one).toBeGreaterThanOrEqual(1 << 20)
    expect(r.bytes).toBeGreaterThanOrEqual(3 * one)
    expect(r.bytes).toBeLessThan(3 * one + (1 << 20))
    expect(r.rebuildableBytes).toBeGreaterThanOrEqual(one)
    expect(r.rebuildableBytes).toBeLessThan(one + (1 << 20))

    // no rebuildable folder given: the same total, no share
    expect(walkDisk({ root: wt, rebuildable: [], timeoutMs: L.diskWalkTimeoutMs })).toMatchObject({ bytes: r.bytes, rebuildableBytes: 0, entries: r.entries })
    // a root that is a file, a link, or not there
    expect(walkDisk({ root: p('src/a.bin'), rebuildable: [], timeoutMs: 1 })).toMatchObject({ bytes: one, entries: 1, capped: false })
    expect(walkDisk({ root: p('packages/loop'), rebuildable: [], timeoutMs: 1 }).entries).toBe(1)
    expect(walkDisk({ root: p('nowhere'), rebuildable: [], timeoutMs: 1 })).toMatchObject({ bytes: 0, entries: 0, capped: false })
  })

  it('U-WT-16 · the walk is cancelled at L.diskWalkTimeoutMs on its clock (a stub: nothing waits): what it had counted comes back marked capped; an entry that cannot be read and another volume are passed over', () => {
    // a tree of 1 + 3 + 9 folders, each with 2 files of one block; reading a folder takes a second on the stub clock
    let t = 0
    const reads: string[] = []
    const dirsOf = (p: string): string[] => (p.split('/').length <= 3 ? ['d0', 'd1', 'd2', 'f0', 'f1'] : ['f0', 'f1'])
    const io: WalkFs = {
      lstatSync: (p) => ({ blocks: 1, dev: 1, isDirectory: () => !/\/f\d$/.test(p) }),
      readdirSync: (p) => {
        reads.push(p)
        t += 1000
        return dirsOf(p)
      },
    }
    const whole = walkDisk({ root: '/wt', rebuildable: ['d1'], timeoutMs: L.diskWalkTimeoutMs }, () => t, io)
    expect(whole).toEqual({ bytes: 512 * (1 + 3 + 9 + 2 * 13), rebuildableBytes: 512 * (1 + 3 + 2 * 4), capped: false, entries: 39, ms: 13_000 })
    expect(reads).toHaveLength(13)

    // the cap: the folders read before it passed are counted, the rest never opened
    t = 0
    reads.length = 0
    const capped = walkDisk({ root: '/wt', rebuildable: [], timeoutMs: 4000 }, () => t, io)
    expect(capped.capped).toBe(true)
    expect(reads).toHaveLength(4)
    expect(capped.ms).toBe(4000)
    expect(capped.bytes).toBeGreaterThan(0)
    expect(capped.bytes).toBeLessThan(whole.bytes)
    // L.diskWalkTimeoutMs, the walk's own cap, reached on the stub clock in two reads
    t = 0
    reads.length = 0
    const slow: WalkFs = { ...io, readdirSync: (p) => ((t += L.diskWalkTimeoutMs / 2), reads.push(p), dirsOf(p)) }
    expect(walkDisk({ root: '/wt', rebuildable: [], timeoutMs: L.diskWalkTimeoutMs }, () => t, slow)).toMatchObject({ capped: true, ms: L.diskWalkTimeoutMs })
    expect(reads).toHaveLength(2)

    // a folder that cannot be listed, an entry that went, a folder on another volume
    const holes: WalkFs = {
      lstatSync: (p) => {
        if (p === '/wt/gone') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { blocks: 2, dev: p.startsWith('/wt/mount') ? 2 : 1, isDirectory: () => !p.endsWith('.txt') }
      },
      readdirSync: (p) => {
        if (p === '/wt') return ['locked', 'gone', 'mount', 'a.txt']
        if (p === '/wt/locked') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        throw new Error(`not to be read: ${p}`)
      },
    }
    expect(walkDisk({ root: '/wt', rebuildable: [], timeoutMs: 1000 }, () => 0, holes)).toEqual({ bytes: 4 * 1024, rebuildableBytes: 0, capped: false, entries: 4, ms: 0 })
  })

  it('U-WT-24 · a folder that holds a `.git` entry at any depth is not rebuildable: the look finds a directory or a file of that name (a clone, a linked worktree), follows no link, and says “not checked” at its time cap, at a folder it cannot read and at another volume; the walk leaves such a folder out of the rebuildable share', () => {
    const outside = tmp()
    fs.mkdirSync(path.join(outside, 'repo/.git'), { recursive: true })
    const wt = tmp()
    const p = (...s: string[]) => path.join(wt, ...s)
    for (const d of ['build/.git/objects', 'build/src', '.venv/src/pkg', '.venv/lib', 'target/debug', 'node_modules/dep/lib', 'out/gen', 'dist']) fs.mkdirSync(p(d), { recursive: true })
    for (const f of ['build/src/a.c', '.venv/lib/x.py', 'target/debug/app', 'node_modules/dep/lib/index.js', 'node_modules/dep/gitignore', 'node_modules/dep/.gitattributes', 'out/gen/o.js', 'dist/x.js']) fs.writeFileSync(p(f), 'x'.repeat(5000))
    // three levels down, a file named `.git` (what a linked worktree or a submodule has)
    fs.writeFileSync(p('.venv/src/pkg/.git'), 'gitdir: /somewhere/else\n')
    // a link to a repository elsewhere is a link: never followed
    fs.symlinkSync(path.join(outside, 'repo'), p('out/gen/linked'))
    const look = (dir: string) => scanForGit({ dir: p(dir), timeoutMs: L.diskWalkTimeoutMs })

    expect(look('build')).toMatchObject({ git: '.git', unchecked: null })
    expect(look('.venv')).toMatchObject({ git: 'src/pkg/.git', unchecked: null })
    // names that only begin like it are not it
    expect(look('node_modules')).toMatchObject({ git: null, unchecked: null })
    expect(look('node_modules').entries).toBe(5)
    expect(look('out')).toMatchObject({ git: null, unchecked: null })
    expect(look('target')).toMatchObject({ git: null, unchecked: null })
    // a link named `.git` counts as one (it is not followed, and it is not Kea's to judge)
    fs.symlinkSync(path.join(outside, 'repo/.git'), p('target/debug/.git'))
    expect(look('target')).toMatchObject({ git: 'debug/.git', unchecked: null })
    // the folder itself: not there, or a link (the removal moves only a real folder): nothing found, nothing to keep
    expect(look('nowhere')).toEqual({ git: null, unchecked: null, entries: 0, ms: expect.any(Number) })
    fs.symlinkSync(p('build'), p('linked-build'))
    expect(look('linked-build')).toMatchObject({ git: null, unchecked: null, entries: 0 })

    // the same walk that sizes the worktree leaves what holds a repository out of the rebuildable share
    const share = (...dirs: string[]) => walkDisk({ root: wt, rebuildable: dirs, timeoutMs: L.diskWalkTimeoutMs }).rebuildableBytes
    const clean = share('node_modules', 'out', 'dist')
    expect(clean).toBeGreaterThan(0)
    expect(share('.venv', 'build', 'dist', 'node_modules', 'out', 'target')).toBe(clean)
    expect(share('build')).toBe(0)

    // bounded like the walk: at the cap, on its clock, the look stops and the folder is not known to hold none
    let t = 0
    const reads: string[] = []
    const tree: ScanFs = {
      lstatSync: () => ({ dev: 1, isDirectory: () => true }),
      readdirSync: (dir) => {
        reads.push(dir)
        t += L.diskWalkTimeoutMs / 2
        return dir.split('/').length <= 4 ? ['d0', 'd1'].map((name) => ({ name, isDirectory: () => true })) : [{ name: '.git', isDirectory: () => true }]
      },
    }
    expect(scanForGit({ dir: '/wt/build', timeoutMs: L.diskWalkTimeoutMs }, () => t, tree)).toEqual({ git: null, unchecked: 'cap', entries: 4, ms: L.diskWalkTimeoutMs })
    expect(reads).toHaveLength(2)
    // no time left at all: nothing is read
    reads.length = 0
    expect(scanForGit({ dir: '/wt/build', timeoutMs: 0 }, () => t, tree)).toMatchObject({ git: null, unchecked: 'cap', entries: 0 })
    expect(reads).toHaveLength(0)
    // with time, the same tree is found to hold one
    t = 0
    expect(scanForGit({ dir: '/wt/build', timeoutMs: 100 * L.diskWalkTimeoutMs }, () => t, tree)).toMatchObject({ git: expect.stringMatching(/\/\.git$/), unchecked: null })

    // a folder that cannot be listed, and another volume mounted inside, are not looked into: not checked
    const holes = (locked: boolean, mount: boolean): ScanFs => ({
      lstatSync: (x) => {
        if (x.endsWith('/gone')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { dev: mount && x.endsWith('/mount') ? 2 : 1, isDirectory: () => true }
      },
      readdirSync: (x) => {
        if (x === '/wt/build') return ['locked', 'gone', 'mount', 'a.txt'].map((name) => ({ name, isDirectory: () => name !== 'a.txt' }))
        if (x.endsWith('/locked') && locked) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        if (x.endsWith('/mount') && mount) throw new Error(`not to be read: ${x}`)
        return []
      },
    })
    const at = (io: ScanFs) => scanForGit({ dir: '/wt/build', timeoutMs: 1000 }, () => 0, io)
    expect(at(holes(false, false))).toMatchObject({ git: null, unchecked: null, entries: 4 })
    expect(at(holes(true, false))).toMatchObject({ git: null, unchecked: 'unreadable' })
    expect(at(holes(false, true))).toMatchObject({ git: null, unchecked: 'volume' })
    // the folder itself cannot be looked at
    expect(scanForGit({ dir: '/wt/build', timeoutMs: 1000 }, () => 0, { ...holes(false, false), lstatSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } })).toMatchObject({ git: null, unchecked: 'unreadable' })
  })
})
