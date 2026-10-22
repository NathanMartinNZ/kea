// The files service inside the whole core (core.ts): its stores follow the visible set, its calls are served, the
// panel's state survives a relaunch in the session's database row, a finished tool refreshes, and archiving a session
// lets go of everything. What the service does is core-files.test.ts and core-git.test.ts; this is the wiring.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitStoreName, L, treeStoreName, type GitHead, type SessionView, type TreeDir } from '@kea/protocol'
import { until } from '../support/holders.ts'
import { createArgs, gitIn, repo, startSessions, type SessionsUnderTest } from './core-sessions-support.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

describe('files and git in the whole core', () => {
  it('I-FT-14 · a session’s tree and git stores exist from inside `visible.set` until it is hidden; the panel’s calls work; expansion, scope and panel state survive a relaunch beside other panel state; a finished tool refreshes; archiving lets go of the watch', async () => {
    const s: SessionsUnderTest = await startSessions()
    cleanup.push(() => s.dispose())
    const r = repo()
    cleanup.push(() => r.dispose())
    const project = await s.project(r.root)
    const created = await s.call<{ sessionId: string }>('sessions.create', createArgs(project.id, 'look at the files'))
    const view: SessionView = await s.until(created.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
    expect(view.lifecycle).toBe('live')
    const id = view.id
    const core = () => s.c.core
    const win = { window: 1 }

    // nothing is held for a session no window shows
    expect(core().stores.get(treeStoreName(id))).toBeUndefined()
    expect(core().files.session(id)).toBeUndefined()
    await expect((async () => s.call('files.open', { sessionId: id }))()).rejects.toThrow(/not shown/)
    // shown: both stores are there when `visible.set` returns
    core().visible.set(win, id)
    const tree = core().stores.get(treeStoreName(id))
    const git = core().stores.get(gitStoreName(id))
    expect(tree && git).toBeTruthy()
    expect(core().git).toBe(core().files) // the files service is also core's git facts
    await until('the first status', () => (git?.get('head') as GitHead | undefined)?.state === 'ok' && tree?.get('/') !== undefined)
    expect((tree?.get('/') as TreeDir).entries.map((e) => e.name)).toContain('src')
    expect(git?.get('head')).toMatchObject({ scope: 'branch', branch: view.branch, baseBranch: view.baseBranch, ahead: 0 })
    expect(await core().git.base(id, 'branch')).toBe(gitIn(view.cwd, 'merge-base', 'HEAD', view.baseBranch as string).trim())
    expect(core().watch).toBeDefined()
    expect(core().files.session(id)?.watch?.root).toBe(fs.realpathSync(view.cwd))

    // the panel's calls; another panel's state in the same database row is left alone
    await s.call('sessions.setUi', { id, state: { terminal: { scroll: 12 } } })
    expect(await s.call('files.open', { sessionId: id })).toEqual({ ok: true, expanded: [], scope: 'branch', ui: {} })
    expect(await s.call('files.expand', { sessionId: id, path: 'src' })).toEqual({ ok: true })
    expect((tree?.get('/src') as TreeDir).entries.map((e) => e.name)).toContain('math.js')
    await s.call('files.setScope', { sessionId: id, scope: 'uncommitted' })
    await s.call('files.saveUi', { sessionId: id, ui: { tab: 'changes', scrollTop: 240, selected: 'src/math.js' } })
    const ui = await s.call<{ state: Record<string, unknown> }>('sessions.getUi', { id })
    expect(ui.state.terminal).toEqual({ scroll: 12 })
    expect(ui.state.files).toMatchObject({ expanded: ['src'], scope: 'uncommitted' })

    // A tool finished in the session (the status engine's input, as the hook intake gives it): one refresh
    await until('quiet', () => core().files.session(id)?.scheduler.idle === true)
    const before = core().files.session(id)?.stats.refreshes as number
    fs.writeFileSync(path.join(view.cwd, 'written-by-the-agent.txt'), 'x\n')
    expect(core().status.ingest({ sessionId: id, source: 'hook', events: [{ t: 'tool.finished', name: 'Write', ok: true }] })).toBe(true)
    await until('the refresh', () => (core().files.session(id)?.stats.refreshes as number) > before && git?.get('/written-by-the-agent.txt') !== undefined)
    // replayed from the spool after a restart, it refreshes nothing (activation already read everything)
    await until('quiet', () => core().files.session(id)?.scheduler.idle === true)
    const mid = core().files.session(id)?.stats.refreshes as number
    core().status.ingest({ sessionId: id, source: 'hook', events: [{ t: 'tool.finished', name: 'Write', ok: true }], spooled: true })
    expect(core().files.session(id)?.scheduler.idle).toBe(true)
    expect(core().files.session(id)?.stats.refreshes).toBe(mid)

    // hidden: the stores go; the session stays one of the recently viewed (its caches and its watch)
    core().visible.set(win, null)
    expect(core().stores.get(treeStoreName(id))).toBeUndefined()
    expect(core().stores.get(gitStoreName(id))).toBeUndefined()
    expect(tree?.isDisposed).toBe(true)
    expect(core().files.counts).toMatchObject({ sessions: 1, visible: 0, cached: 1 })

    // a relaunch: what was expanded, the scope and the panel's state come back from the database
    await s.relaunch()
    core().visible.set(win, id)
    expect(await s.call('files.open', { sessionId: id })).toEqual({ ok: true, expanded: ['src'], scope: 'uncommitted', ui: { tab: 'changes', scrollTop: 240, selected: 'src/math.js' } })
    const tree2 = core().stores.get(treeStoreName(id))
    await until('the expanded folder to be loaded again', () => tree2?.get('/src') !== undefined)
    await until('the status', () => (core().stores.get(gitStoreName(id))?.get('head') as GitHead | undefined)?.state === 'ok')
    expect(core().stores.get(gitStoreName(id))?.get('head')).toMatchObject({ scope: 'uncommitted' })
    expect(core().git.scope(id)).toBe('uncommitted')
    expect((await s.call<{ state: Record<string, unknown> }>('sessions.getUi', { id })).state.terminal).toEqual({ scroll: 12 })

    // archived (while hidden): nothing is held any more, the worktree is no longer followed
    core().visible.set(win, null)
    expect(core().files.session(id)?.watch).toBeTruthy()
    const archived = await s.call<{ archived: boolean }>('sessions.archive', { id, confirmed: true })
    expect(archived.archived).toBe(true)
    await until('the files state to be dropped', () => core().files.session(id) === undefined)
    expect(core().files.counts).toMatchObject({ sessions: 0, timers: 0 })
  })

  it('I-SES-16 · `sessions.setUi` changes only the keys it is given: a caller writing back an older copy of the panel state leaves the other panels’ keys, and the file panel’s, as they are; a key given as null is removed', async () => {
    const s: SessionsUnderTest = await startSessions()
    cleanup.push(() => s.dispose())
    const r = repo()
    cleanup.push(() => r.dispose())
    const project = await s.project(r.root)
    const created = await s.call<{ sessionId: string }>('sessions.create', createArgs(project.id, 'keep the panel state'))
    const view: SessionView = await s.until(created.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
    const id = view.id
    const state = async () => (await s.call<{ state: Record<string, unknown> }>('sessions.getUi', { id })).state

    await s.call('sessions.setUi', { id, state: { terminal: { scroll: 12 }, tabs: { active: 'agent' } } })
    // the copy a slow caller holds: read before the file panel saved anything
    const stale = await state()
    s.c.core.visible.set({ window: 1 }, id)
    expect(await s.call('files.expand', { sessionId: id, path: 'src' })).toEqual({ ok: true })
    await s.call('files.saveUi', { sessionId: id, ui: { mode: 'changes', files: { scrollTop: 240 } } })
    expect((await state()).files).toMatchObject({ expanded: ['src'], ui: { mode: 'changes', files: { scrollTop: 240 } } })

    // one key written: the others stay, the file panel's included
    await s.call('sessions.setUi', { id, state: { terminal: { scroll: 40 } } })
    expect(await state()).toMatchObject({ terminal: { scroll: 40 }, tabs: { active: 'agent' }, files: { expanded: ['src'], ui: { mode: 'changes' } } })
    // the whole older copy written back: its own keys go back, and the file panel's state is not its to lose
    await s.call('sessions.setUi', { id, state: stale })
    expect(await state()).toMatchObject({ terminal: { scroll: 12 }, tabs: { active: 'agent' }, files: { expanded: ['src'], ui: { mode: 'changes', files: { scrollTop: 240 } } } })
    // the file panel's key is written by `files.saveUi` only
    await s.call('sessions.setUi', { id, state: { files: { expanded: [] }, terminal: { scroll: 1 } } })
    expect(await state()).toMatchObject({ terminal: { scroll: 1 }, files: { expanded: ['src'] } })
    expect(await s.call('files.open', { sessionId: id })).toMatchObject({ expanded: ['src'], ui: { mode: 'changes', files: { scrollTop: 240 } } })
    // a key given as null goes
    await s.call('sessions.setUi', { id, state: { tabs: null } })
    expect(Object.keys(await state()).sort()).toEqual(['files', 'terminal'])
    // L.sessionUiMaxBytes holds for what the row would hold after the change, not only for what one call brings
    const half = 'x'.repeat(Math.floor(L.sessionUiMaxBytes * 0.6))
    await s.call('sessions.setUi', { id, state: { a: half } })
    await expect((async () => s.call('sessions.setUi', { id, state: { b: half } }))()).rejects.toThrow(/over \d+ bytes/)
    expect(Object.keys(await state()).sort()).toEqual(['a', 'files', 'terminal'])
  })
})
