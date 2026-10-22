// settings.json in core with its real watcher, core assembled as main.ts assembles it and wired to a real ptyhost, so
// "live" includes the mirrors' configuration. And Advanced's list of running background processes, over real holders in
// a home whose database knows nothing of them.

import fs from 'node:fs'
import path from 'node:path'
import { runDir, ulid } from '@kea/kit'
import { DEFAULT_TERMINAL_SETTINGS as DEFAULTS, SETTINGS_STATUS_KEY, type HolderRow, type MirrorConfig, type Project, type SettingsStatus } from '@kea/protocol'
import { insertSession } from '@kea/core/src/sessions/rows.ts'
import { settingsPath } from '@kea/core/src/settings/settings.ts'
import { tinyRepo } from '@kea-tools/repo-factory/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { holderAlive, holderState, ptyhostHarness, testEnv, until, type Harness } from '../support/holders.ts'
import { ownPtyIds, startFullCore, type FullCoreUnderTest } from './core-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function harness(): Promise<Harness> {
  const h = await ptyhostHarness()
  cleanup.push(async () => {
    for (const id of ownPtyIds(h.home)) h.spawned.add(id)
    await h.dispose()
  })
  return h
}

const COMMENTED = `// my Kea settings
{
  "general": { "branchPrefix": "dev/" },   // short branches
  /* the terminal */
  "terminal": {
    "fontFamily": "Berkeley Mono",
    "scrollback": 2000,
  },
  "zzz": { "keep": "me" },
}
`

describe('settings.json', () => {
  it('I-SET-1 · external edits of settings.json (valid, invalid, deleted) apply live; then a UI change to a file with comments keeps them and the key order', async () => {
    const h = await harness()
    const c: FullCoreUnderTest = startFullCore(h, { env: testEnv(), opts: { watchSettings: true } })
    cleanup.push(() => c.dispose())
    await c.reconciled()
    const s = c.core.settings
    const file = settingsPath(h.home)
    const status = () => s.statusStore.get(SETTINGS_STATUS_KEY) as SettingsStatus
    const configured = () => c.calls.filter((x) => x.m === 'pty.configure').map((x) => x.a as unknown as MirrorConfig)
    expect(status()).toMatchObject({ path: file, exists: false, error: null })

    // valid: applied live, the mirrors reconfigured
    fs.writeFileSync(file, '{ "terminal": { "fontSize": 15, "scrollback": 1234 } }\n')
    await until('the edit to apply', () => s.store.get('terminal.fontSize') === 15)
    await until('ptyhost to get the new scrollback', () => configured().at(-1)?.scrollback === 1234)
    expect(status()).toMatchObject({ exists: true, error: null, notices: [] })

    // an invalid value: that key falls back with a notice, its neighbours apply
    fs.writeFileSync(file, '{ "terminal": { "fontSize": "huge", "cursorStyle": "bar", "scrollback": 1234 } }\n')
    await until('the per-key fallback', () => s.store.get('terminal.cursorStyle') === 'bar')
    expect(s.store.get('terminal.fontSize')).toBe(DEFAULTS.fontSize)
    expect(status().notices.map((n) => n.key)).toEqual(['terminal.fontSize'])

    // does not parse: the last good values stay; the error has its line and column
    const broken = '{\n  "terminal": {\n    "cursorStyle": "underline"\n    "fontSize": 20\n  }\n}\n'
    fs.writeFileSync(file, broken)
    await until('the parse error', () => status().error !== null)
    expect(status().error).toMatchObject({ line: 4, column: 5 })
    expect(s.store.get('terminal.cursorStyle'), 'last known good').toBe('bar')
    await expect(c.call('settings.set', { key: 'terminal.fontSize', value: 12 })).rejects.toMatchObject({ code: 'file_invalid' })
    expect(fs.readFileSync(file, 'utf8'), 'a broken file is never edited').toBe(broken)

    // deleted: the defaults, banner gone
    fs.rmSync(file)
    await until('the defaults', () => status().exists === false)
    expect(status().error).toBeNull()
    expect(s.store.get('terminal.cursorStyle')).toBe(DEFAULTS.cursorStyle)
    await until('ptyhost to get the default scrollback', () => configured().at(-1)?.scrollback === DEFAULTS.scrollback)

    // a file with comments, then a change from the UI: one key changes, the rest of the text is as it was
    fs.writeFileSync(file, COMMENTED)
    await until('the commented file to apply', () => s.store.get('terminal.scrollback') === 2000)
    expect(await c.call('settings.set', { key: 'terminal.scrollback', value: 3000 })).toEqual({ ok: true })
    expect(s.store.get('terminal.scrollback')).toBe(3000)
    expect(fs.readFileSync(file, 'utf8')).toBe(COMMENTED.replace('"scrollback": 2000', '"scrollback": 3000'))
    expect(await c.call('settings.set', { key: 'terminal.fontSize', value: 16 })).toEqual({ ok: true })
    const text = fs.readFileSync(file, 'utf8')
    for (const kept of ['// my Kea settings', '// short branches', '/* the terminal */', '"zzz": { "keep": "me" }']) expect(text).toContain(kept)
    expect(text.indexOf('"fontFamily"')).toBeLessThan(text.indexOf('"scrollback"'))
    expect(text.indexOf('"scrollback"')).toBeLessThan(text.indexOf('"fontSize"'))
    await until('ptyhost to get the UI’s scrollback', () => configured().at(-1)?.scrollback === 3000)
    expect(s.values.get('general.branchPrefix')).toBe('dev/')
  })
})

describe('Advanced: running background processes', () => {
  it('I-SET-2 · Advanced › running background processes with an empty database: the list is the holders present in <KEA_HOME>/run, with what their state files say, whatever the database knows; Terminate ends one, and it leaves the list', async () => {
    const h = await harness()
    const repo = tinyRepo({ name: 'demo' })
    cleanup.push(() => repo.dispose())
    const start = (): FullCoreUnderTest => {
      const core = startFullCore(h, { env: testEnv() })
      cleanup.push(() => core.dispose())
      return core
    }
    /** The holders present in the run directory: every socket there whose holder process runs. */
    const present = () =>
      fs
        .readdirSync(runDir(h.home))
        .filter((f) => f.endsWith('.sock'))
        .map((f) => f.slice(0, -'.sock'.length))
        .filter((id) => holderAlive(h.home, id))
        .sort()
    let c = start()
    await c.reconciled()
    const list = async () => (await c.call<{ holders: HolderRow[] }>('terminal.holders', {})).holders
    const ids = async () => (await list()).map((r) => r.ptyId).sort()
    expect(await list(), 'nothing runs yet').toEqual([])

    // a session's agent and shell, and a shell tab of no session: three holders, started through core
    const p = (await c.call<{ project: Project }>('projects.add', { path: repo.root })).project
    const sessionId = ulid()
    c.core.db.tx(() =>
      insertSession(c.core.db, {
        id: sessionId, projectId: p.id, slug: 'bg', title: 'Session', titleSource: 'user', isolation: 'inplace', cwd: repo.root, worktreeRoot: null, branch: null,
        baseBranch: null, baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{"prompt":"x"}',
        lifecycle: 'live', endReason: null, deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null,
        sortOrder: 0, pinnedOrder: 0, createdAt: Date.now(), archivedAt: null,
      }),
    )
    const cat = (session: string, kind: 'agent' | 'shell') => ({ sessionId: session, kind, command: { argv: ['/bin/cat'] }, cwd: repo.root, cols: 80, rows: 24 })
    const agent = (await c.core.terminals.launch(cat(sessionId, 'agent'))).ptyId
    const shell = (await c.core.terminals.launch(cat(sessionId, 'shell'))).ptyId
    const tab = (await c.core.terminals.launch(cat('shells', 'shell'))).ptyId
    const started = [agent, shell, tab].sort()
    await until('the three holders to be in the run directory', () => JSON.stringify(present()) === JSON.stringify(started))
    /** A row is what the holder's own state file says, and the process it names runs. */
    const expectRows = async (when: string) => {
      const rows = await list()
      expect(rows.map((r) => r.ptyId).sort(), `${when}: the list is the run directory's holders`).toEqual(present())
      for (const r of rows) {
        const j = holderState(h.home, r.ptyId) as { pid: number; childPid: number; sessionId: string; kind: string; pidStartTime: number }
        expect(r, `${when}: ${r.ptyId}`).toEqual({ ptyId: r.ptyId, sessionId: j.sessionId, kind: j.kind, pid: j.pid, childPid: j.childPid, startedAt: Math.round(j.pidStartTime / 1000), alive: true, exited: false, orphan: false })
      }
      // oldest first
      expect(rows.map((r) => r.startedAt)).toEqual([...rows.map((r) => r.startedAt)].sort((a, b) => (a ?? 0) - (b ?? 0)))
      return rows
    }
    const rows = await expectRows('with the database as core wrote it')
    expect(rows.find((r) => r.ptyId === agent)).toMatchObject({ sessionId, kind: 'agent' })
    expect(rows.find((r) => r.ptyId === tab)).toMatchObject({ sessionId: 'shells', kind: 'shell' })

    // the database emptied under a running core: no session, no project and no PTY row is left, and the list is the same
    c.core.db.tx(() => {
      for (const table of ['ptys', 'status_events', 'session_ui', 'session_runtime', 'sessions', 'projects']) c.core.db.run(`DELETE FROM ${table}`)
    })
    expect(c.core.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM ptys) + (SELECT COUNT(*) FROM projects) AS n')?.n).toBe(0)
    expect((await expectRows('with every row deleted')).map((r) => r.ptyId).sort()).toEqual(started)

    // the database file lost while Kea was closed: a new core on a fresh database lists the same holders
    c.dispose()
    for (const x of ['', '-wal', '-shm']) fs.rmSync(path.join(h.home, `kea.db${x}`), { force: true })
    await h.restart()
    c = start()
    expect(c.core.opened.fresh).toBe(true)
    expect((await expectRows('on a fresh database, before core has reconciled or rebuilt anything')).map((r) => r.ptyId).sort()).toEqual(started)
    await c.reconciled()
    await c.core.started
    expect((await expectRows('on a fresh database')).map((r) => r.ptyId).sort()).toEqual(started)

    // Terminate: a holder core is attached to; its program ends and it leaves the run directory and the list
    expect(await c.call('terminal.terminateHolder', { ptyId: shell })).toEqual({ ok: true })
    await until('the terminated holder to be gone', () => !holderAlive(h.home, shell))
    expect(await ids()).toEqual([agent, tab].sort())
    await expectRows('after Terminate')

    // a holder that turned up since core last looked (nothing core keeps accounts for it): listed all the same, since
    // it is in the run directory, and Terminate ends it once its process is confirmed to be that holder
    const stray = await h.spawn({ argv: ['/bin/cat'], sessionId: 'shells', kind: 'shell', cwd: repo.root })
    await until('the stray holder to be in the run directory', () => present().includes(stray.ptyId))
    expect(await ids()).toEqual([agent, tab, stray.ptyId].sort())
    await expectRows('with a holder core did not start')
    expect(await c.call('terminal.terminateHolder', { ptyId: stray.ptyId })).toEqual({ ok: true })
    await until('the stray holder to be gone', () => !holderAlive(h.home, stray.ptyId))
    expect(await ids()).toEqual([agent, tab].sort())

    // a ptyId that is no holder: nothing is signalled
    expect(await c.call('terminal.terminateHolder', { ptyId: 'zzzzzzzzzz' })).toEqual({ ok: false })
    expect(present()).toEqual([agent, tab].sort())
    await expectRows('at the end')
  })
})
