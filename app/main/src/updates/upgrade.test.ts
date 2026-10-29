// Kea's files replaced or removed under the running Kea: respawns refused once the archive is another file (the same
// release installed again changes nothing), a child of another build counts too, a refused respawn restarts Kea once
// per target version and never after a removal; the archive compared by device and inode on real files.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asarIdentity, plainStat, relaunchArgs, relaunchedFor, treeVersion, UpgradeGuard, type UpgradeDeps } from './upgrade.ts'

function guard(o: Partial<UpgradeDeps> & { ids?: (string | null)[]; tree?: string | null } = {}) {
  const ids = [...(o.ids ?? ['1:100'])]
  let last = ids[0] ?? null
  const calls: string[] = []
  const g = new UpgradeGuard({
    running: '1.0.2',
    relaunchedFor: null,
    identity: () => (ids.length ? (last = ids.shift() ?? null) : last),
    treeVersion: () => (o.tree === undefined ? '1.0.3' : o.tree),
    upgraded: (v) => calls.push(`upgraded ${v}`),
    removed: () => calls.push('removed'),
    relaunch: (t) => calls.push(`relaunch ${t}`),
    log: { info: () => undefined, warn: () => undefined },
    ...o,
  })
  return { g, calls }
}

describe('files replaced under a running Kea', () => {
  it('U-DST-23 · a respawn goes ahead while the archive is the one main started with; once it is another file it is refused and stays refused', () => {
    const same = guard({ ids: ['1:100', '1:100'] })
    expect(same.g.mayRespawn()).toBe(true)
    const replaced = guard({ ids: ['1:100', '1:200'] })
    expect(replaced.g.mayRespawn()).toBe(false)
    expect(replaced.calls).toEqual(['upgraded 1.0.3'])
    expect(replaced.g.mayRespawn()).toBe(false)
    expect(replaced.calls, 'said once').toHaveLength(1)
  })

  it('U-DST-24 · the same release installed again changes nothing; a missing archive is a removal, never a restart; a dev build without an archive is never compared', () => {
    const again = guard({ ids: ['1:100', '1:200'], tree: '1.0.2' })
    expect(again.g.mayRespawn()).toBe(true)
    expect(again.calls).toEqual([])
    const gone = guard({ ids: ['1:100', null] })
    expect(gone.g.mayRespawn()).toBe(false)
    gone.g.respawnRefused()
    expect(gone.calls).toEqual(['removed'])
    const dev = guard({ ids: [null, '1:1'] })
    expect(dev.g.mayRespawn()).toBe(true)
    expect(dev.g.now).toBe('running')
  })

  it('U-DST-25 · a child of another build marks Kea upgraded (a dev tree rebuilt has no version); a refused respawn restarts Kea for the tree’s version, once per version', () => {
    const child = guard({ ids: [null], tree: null })
    child.g.childFromOtherBuild()
    expect(child.g.mayRespawn()).toBe(false)
    child.g.respawnRefused()
    expect(child.calls).toEqual(['upgraded null', 'relaunch unknown'])

    const looped = guard({ ids: ['1:100', '1:200'], relaunchedFor: '1.0.3' })
    expect(looped.g.mayRespawn()).toBe(false)
    looped.g.respawnRefused()
    expect(looped.calls, 'already restarted for 1.0.3').toEqual(['upgraded 1.0.3'])

    const next = guard({ ids: ['1:100', '1:200'], relaunchedFor: '1.0.3', tree: '1.0.4' })
    next.g.mayRespawn()
    next.g.respawnRefused()
    expect(next.calls.at(-1), 'a newer version restarts again').toBe('relaunch 1.0.4')
  })

  it('U-DST-26 · a restart keeps the start’s own arguments without an earlier marker and adds its target; the next start reads it', () => {
    const args = relaunchArgs(['/opt/Kea/kea-app', '--ozone-platform=x11', '--kea-relaunched=1.0.3'], '1.0.4')
    expect(args).toEqual(['--ozone-platform=x11', '--kea-relaunched=1.0.4'])
    expect(relaunchedFor(['/opt/Kea/kea-app', ...args])).toBe('1.0.4')
    expect(relaunchedFor(['/opt/Kea/kea-app'])).toBeNull()
  })
})

describe('the archive on disk', () => {
  let dir: string
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('U-DST-27 · a package manager’s rename over app.asar is a new identity; the same file keeps it; a missing one has none; the tree’s version is read from kea-version', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-upgrade-'))
    const stat = plainStat({})
    fs.writeFileSync(path.join(dir, 'app.asar'), 'old')
    const first = asarIdentity(dir, stat)
    expect(first).toMatch(/^\d+:\d+$/)
    expect(asarIdentity(dir, stat)).toBe(first)
    fs.writeFileSync(path.join(dir, 'app.asar.dpkg-new'), 'new')
    fs.renameSync(path.join(dir, 'app.asar.dpkg-new'), path.join(dir, 'app.asar'))
    expect(asarIdentity(dir, stat)).not.toBe(first)
    fs.rmSync(path.join(dir, 'app.asar'))
    expect(asarIdentity(dir, stat)).toBeNull()
    expect(treeVersion(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, 'kea-version'), '1.0.3\n')
    expect(treeVersion(dir)).toBe('1.0.3')
    fs.writeFileSync(path.join(dir, 'kea-version'), 'garbage')
    expect(treeVersion(dir)).toBeNull()
  })

  it('U-DST-28 · outside Electron the stat is node’s own; inside, original-fs’s when it loads', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-upgrade-'))
    const spy = vi.spyOn(fs, 'statSync')
    plainStat({})(dir)
    expect(spy).toHaveBeenCalledWith(dir)
    spy.mockRestore()
    // no original-fs under Node: node's stat stands in
    expect(() => plainStat({ electron: '44.5.1' })(dir)).not.toThrow()
  })
})
