// Kea's own folders and Time Machine, for real: the whole of core on a temp KEA_HOME, wired to a real ptyhost and real
// holders, with the real exclusion writer (`/usr/bin/xattr`, never `tmutil`). The attribute is read back from each
// folder. Everything marked lies under the run's temp home or a temp worktree root.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BACKUP_EXCLUDED_KEY, type ExcludeWriter } from '@kea/core/src/platform/backupExclusions.ts'
import { kvGet } from '@kea/core/src/platform/db/db.ts'
import { BACKUP_EXCLUDE_ATTR } from '@kea/core/src/os/darwin.ts'
import { excludeFromBackup } from '@kea/core/src/worktrees/backup.ts'
import { createMemoryLogger } from '@kea/kit'
import { isAvailable, type SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { until } from '../support/holders.ts'
import { createArgs, repo, startSessions, type SessionsUnderTest } from './core-sessions-support.ts'
import { coreOs } from '../../app/core/src/os/index.ts'

// Excluding a folder from backups is Time Machine’s attribute on macOS; Linux has no such thing to set.
const backups = isAvailable(coreOs.backupExclude)

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

/** What Time Machine reads on `p`: the string in the attribute's property list, or null when `p` does not carry it. */
function exclusionOf(p: string): string | null {
  let hex: string
  try {
    hex = execFileSync('/usr/bin/xattr', ['-px', BACKUP_EXCLUDE_ATTR, p], { stdio: ['ignore', 'pipe', 'pipe'] }).toString() // os-ok: macOS test tool, called only where Time Machine's exclusion exists
  } catch {
    return null
  }
  const plist = Buffer.from(hex.replace(/\s+/g, ''), 'hex')
  expect(plist.subarray(0, 8).toString('latin1'), p).toBe('bplist00')
  return /com\.apple\.[a-z]+/.exec(plist.toString('latin1'))?.[0] ?? ''
}

async function live(s: SessionsUnderTest, projectId: string, prompt: string): Promise<SessionView> {
  const r = await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt))
  const v = await s.until(r.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

describe.runIf(backups)('Kea’s own folders stay out of Time Machine', () => {
  it('I-HOME-1 · core marks run/, sessions/, bin/, logs/, reports/ and each worktree root’s trash as they appear, with the attribute Time Machine reads; worktrees and the database stay in backups; a later launch writes nothing', async () => {
    const log = createMemoryLogger()
    const writes: string[][] = []
    const backupExclude: ExcludeWriter = (dir, names) => {
      writes.push(names.map((n) => path.join(dir, n)))
      return excludeFromBackup(dir, names, log)
    }
    const s = await startSessions({ opts: { backupExclude } })
    cleanup.push(() => s.dispose())
    const home = s.h.home
    const marked = (p: string) => exclusionOf(p) === 'com.apple.backupd'
    const x = () => s.c.core.backupExclusions!
    // logs/ is made by core's own entry (main.ts), which this test does not run
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
    await x().look()
    expect(marked(path.join(home, 'logs'))).toBe(true)

    // the first session: its terminal's state under sessions/, the helper copy under bin/
    const r = repo()
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const a = await live(s, p.id, 'first session')
    await until('sessions/ and bin/ to be marked', () => marked(path.join(home, 'sessions')) && marked(path.join(home, 'bin')))
    await x().look()
    expect(x().awaitsFirstTerminal, 'the terminals need no more following').toBe(false)
    if (fs.existsSync(path.join(home, 'run'))) expect(marked(path.join(home, 'run')), 'run/').toBe(true)

    // the first report makes reports/, which is marked as it is made, with no session made or deleted (U-HOME-6); then
    // the first delete (its trash stays as a folder once made)
    expect(fs.existsSync(path.join(home, 'reports'))).toBe(false)
    await s.call('status.report', { id: a.id, expected: 'working' })
    await until('reports/ to be marked', () => marked(path.join(home, 'reports')))
    await s.call('sessions.delete', { id: a.id, deleteBranch: true, forceBranch: true })
    const trash = path.join(home, 'worktrees', '.kea-trash')
    await until('the trash to be marked', () => marked(trash))
    await s.idle()

    // what a restore needs stays in backups: the worktrees, the database, the settings, the home itself
    const b = await live(s, p.id, 'second session')
    await x().look()
    // a session's row changing (its title here; its status with every hook) makes no folder, so core does not look; a
    // session made or deleted does (and each trash is marked as it appears)
    const looks = vi.spyOn(x(), 'look')
    await s.call('sessions.rename', { id: b.id, title: 'Second, renamed' })
    await s.call('sessions.rename', { id: b.id, title: 'Second, renamed again' })
    await s.until(b.id, 'the row changed', (v) => v.title === 'Second, renamed again')
    expect(looks, 'no look for a row that only changed').not.toHaveBeenCalled()
    looks.mockRestore()
    for (const kept of [home, path.join(home, 'kea.db'), path.join(home, 'worktrees'), path.dirname(b.cwd), b.cwd]) expect(exclusionOf(kept), kept).toBeNull()

    // the worktree root is moved by the setting: the new root's trash is marked when it appears, the old one's entry
    // stays while a session still records that root
    const moved = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-home-root-')))
    cleanup.push(() => fs.rmSync(moved, { recursive: true, force: true }))
    await s.call('settings.set', { key: 'general.worktreeRoot', value: moved })
    const c = await live(s, p.id, 'third session')
    expect(c.cwd.startsWith(moved + path.sep), c.cwd).toBe(true)
    await s.call('sessions.delete', { id: c.id, deleteBranch: true, forceBranch: true })
    await until('the moved root’s trash to be marked', () => marked(path.join(moved, '.kea-trash')))
    await s.idle()
    await x().look()
    expect(exclusionOf(moved), 'the root itself').toBeNull()
    const record = JSON.parse(kvGet(s.c.core.db, BACKUP_EXCLUDED_KEY)!) as Record<string, string>
    expect(Object.keys(record)).toEqual(expect.arrayContaining([trash, path.join(moved, '.kea-trash'), ...['sessions', 'bin', 'logs', 'reports'].map((d) => path.join(home, d))]))
    for (const marks of Object.keys(record)) expect(marks === path.join(moved, '.kea-trash') || marks.startsWith(home + path.sep), `only this run’s folders: ${marks}`).toBe(true)

    // the next launch: everything is recorded, so nothing is written
    const before = writes.length
    await s.relaunch()
    await x().look()
    expect(writes).toHaveLength(before)
    expect(log.entries.filter((e) => e.level === 'warn' || e.level === 'error')).toEqual([])
    await s.call('sessions.delete', { id: b.id, deleteBranch: true, forceBranch: true })
    await s.idle()
  })
})
