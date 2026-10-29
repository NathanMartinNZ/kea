import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { L } from '@kea/protocol'
import { ChangeBatcher, coalesce, type ChangeKind, type Changes } from './batcher.ts'
import { pickExclusions, plainExclusions, WORKTREE_EXCLUSIONS, type EntryKind } from './exclusions.ts'

describe('the change batcher', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  function batcher(): { b: ChangeBatcher; chunks: Changes[]; rescans: () => number; deferred: (() => void)[] } {
    const chunks: Changes[] = []
    let rescans = 0
    const deferred: (() => void)[] = []
    const b = new ChangeBatcher({ onChanges: (c) => chunks.push(c), onRescan: () => void rescans++, defer: (fn) => deferred.push(fn) })
    return { b, chunks, rescans: () => rescans, deferred }
  }

  it('U-FT-3 · events are collected for one window and coalesced by path: a create then delete is a delete (whoever read the tree between the two still holds the path), a delete then create is one update, the rest keep the later kind', () => {
    const { b, chunks } = batcher()
    b.add('a.txt', 'create')
    b.add('a.txt', 'update')
    b.add('tmp', 'create')
    b.add('tmp', 'delete') // made and removed: the two come in different batches of the watcher's, and the tree may have been read between them
    b.add('saved', 'delete')
    b.add('saved', 'create') // replaced (an atomic save)
    b.add('gone', 'update')
    b.add('gone', 'delete')
    vi.advanceTimersByTime(L.watchBatchMs - 1)
    expect(chunks).toHaveLength(0) // still collecting
    b.add('late', 'update') // inside the window: the same batch
    vi.advanceTimersByTime(1)
    expect(chunks).toHaveLength(1)
    expect(Object.fromEntries(chunks[0] as Changes)).toEqual({ 'a.txt': 'create', tmp: 'delete', saved: 'update', gone: 'delete', late: 'update' })
    expect(b.size).toBe(0)
    // every pair of kinds, as the table in batcher.ts says
    const kinds: ChangeKind[] = ['create', 'update', 'delete']
    const table = Object.fromEntries(kinds.flatMap((a) => kinds.map((z) => [`${a}→${z}`, coalesce(a, z)])))
    expect(table).toEqual({ 'create→create': 'create', 'create→update': 'create', 'create→delete': 'delete', 'update→create': 'update', 'update→update': 'update', 'update→delete': 'delete', 'delete→create': 'update', 'delete→update': 'update', 'delete→delete': 'delete' })
  })

  it('U-FT-3 · a flush is handed on in chunks of a set size with a yield between them; more than the threshold pending collapses into one rescan', () => {
    const { b, chunks, rescans, deferred } = batcher()
    const n = L.watchChunk * 2 + 7
    for (let i = 0; i < n; i++) b.add(`f${i}`, 'create')
    vi.advanceTimersByTime(L.watchBatchMs)
    expect(chunks.map((c) => c.size)).toEqual([L.watchChunk]) // one chunk, then a yield
    expect(deferred).toHaveLength(1)
    deferred.shift()?.()
    deferred.shift()?.()
    expect(chunks.map((c) => c.size)).toEqual([L.watchChunk, L.watchChunk, 7])
    expect(deferred).toHaveLength(0)
    expect(new Set(chunks.flatMap((c) => [...c.keys()])).size).toBe(n) // every path once

    // one more than the threshold: nothing is tracked path by path any more
    for (let i = 0; i <= L.watchRescanThreshold; i++) b.add(`g${i}`, 'update')
    expect(b.size).toBe(0)
    expect(b.peak).toBeLessThanOrEqual(L.watchRescanThreshold)
    b.add('after', 'create') // joins the rescan
    vi.advanceTimersByTime(L.watchBatchMs)
    expect(rescans()).toBe(1)
    expect(chunks).toHaveLength(3)

    // a rescan asked for (the watcher dropped events) is delivered once at the window's end, and clear() drops
    // what is pending
    b.add('x', 'create')
    b.rescan()
    b.rescan()
    vi.advanceTimersByTime(L.watchBatchMs)
    expect(rescans()).toBe(2)
    b.add('y', 'create')
    b.clear()
    vi.advanceTimersByTime(L.watchBatchMs * 2)
    expect(chunks).toHaveLength(3)
    expect(b.armed).toBe(false)
  })
})

describe('kernel-side exclusions', () => {
  it('U-FT-9 · at most the exclusion cap is passed (macOS’s, FSEvents; Linux has none, U-PLT-50), candidates that are directories first and those that do not exist yet after them, in priority order; a candidate that is a file is never excluded', () => {
    const kinds = (m: Record<string, EntryKind>) => (p: string) => m[p.slice('/w/'.length)] ?? 'none'
    // every candidate is a directory: the first L.watchExclusionsMax, in order
    const all = Object.fromEntries(WORKTREE_EXCLUSIONS.map((n) => [n, 'dir' as EntryKind]))
    expect(pickExclusions('/w', WORKTREE_EXCLUSIONS, kinds(all), L.watchExclusionsMax)).toEqual(WORKTREE_EXCLUSIONS.slice(0, L.watchExclusionsMax).map((n) => `/w/${n}`))
    // a fresh linked worktree: `.git` is a file, nothing is built yet: every other name is a candidate, and
    // L.watchExclusionsMax are passed
    const fresh = pickExclusions('/w', WORKTREE_EXCLUSIONS, kinds({ '.git': 'file' }), L.watchExclusionsMax)
    expect(fresh).toHaveLength(L.watchExclusionsMax)
    expect(fresh).not.toContain('/w/.git')
    expect(fresh[0]).toBe('/w/node_modules')
    // directories that exist come before those that do not, whatever their priority
    const some = pickExclusions('/w', WORKTREE_EXCLUSIONS, kinds({ '.venv': 'dir', out: 'dir', '.git': 'dir' }), L.watchExclusionsMax)
    expect(some.slice(0, 3)).toEqual(['/w/.git', '/w/.venv', '/w/out'])
    expect(some).toHaveLength(L.watchExclusionsMax)
    expect(some.slice(3)).toEqual(['/w/node_modules', '/w/dist', '/w/build', '/w/.next', '/w/target'])
  })

  it('U-FT-23 · a folder that is not a repository leaves out a `.git` only while it is a directory there: one not made yet is heard when it is made, and its slot goes to the next candidate; the rest are left out by name as in a work tree', () => {
    const kinds = (m: Record<string, EntryKind>) => (p: string) => m[p.slice('/w/'.length)] ?? 'none'
    const rest = WORKTREE_EXCLUSIONS.filter((n) => n !== '.git').map((n) => `/w/${n}`)
    // nothing there yet: every candidate but `.git`, cut to the cap
    expect(plainExclusions('/w', WORKTREE_EXCLUSIONS, kinds({}), L.watchExclusionsMax)).toEqual(rest.slice(0, L.watchExclusionsMax))
    expect(plainExclusions('/w', WORKTREE_EXCLUSIONS, kinds({}), null)).toEqual(rest)
    // a `.git` directory (made, or no repository): left out, first among the directories that exist
    expect(plainExclusions('/w', WORKTREE_EXCLUSIONS, kinds({ '.git': 'dir', out: 'dir' }), L.watchExclusionsMax).slice(0, 3)).toEqual(['/w/.git', '/w/out', '/w/node_modules'])
    // a `.git` file (`--separate-git-dir`): never left out, as in a work tree
    expect(plainExclusions('/w', WORKTREE_EXCLUSIONS, kinds({ '.git': 'file' }), null)).toEqual(rest)
  })
})
