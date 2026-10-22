import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { rootOnlyFile, type StatFs } from './rootOnly.ts'

/** A file system of stated paths: `[uid, mode]` per path, a file where the mode says so; every path is real. */
function fake(entries: Record<string, [number, number]>): StatFs {
  return {
    realpathSync: (p) => p,
    statSync: (p) => {
      const e = entries[p]
      if (!e) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
      return { uid: e[0], mode: e[1], isFile: () => (e[1] & 0o170000) === 0o100000, isDirectory: () => (e[1] & 0o170000) === 0o040000 }
    },
  }
}
const DIR = 0o040000
const FILE = 0o100000

describe('rootOnlyFile', () => {
  it("U-PLT-15 · only root can change it: a root-owned file no one else may write, in root's folders all the way up; a 0775 file, a user's folder, a world-writable folder, a folder or a missing path is no", () => {
    const ok = { '/': [0, DIR | 0o755], '/opt': [0, DIR | 0o755], '/opt/Kea': [0, DIR | 0o755], '/opt/Kea/kea': [0, FILE | 0o755] } satisfies Record<string, [number, number]>
    expect(rootOnlyFile('/opt/Kea/kea', fake(ok))).toBe(true)
    expect(rootOnlyFile('/opt/Kea/kea', fake({ ...ok, '/opt/Kea/kea': [0, FILE | 0o775] })), '0775').toBe(false)
    expect(rootOnlyFile('/opt/Kea/kea', fake({ ...ok, '/opt/Kea/kea': [1000, FILE | 0o755] })), "the user's file").toBe(false)
    expect(rootOnlyFile('/opt/Kea/kea', fake({ ...ok, '/opt/Kea': [1000, DIR | 0o755] })), "in the user's folder").toBe(false)
    expect(rootOnlyFile('/opt/Kea/kea', fake({ ...ok, '/opt': [0, DIR | 0o1777] })), 'below a world-writable folder').toBe(false)
    expect(rootOnlyFile('/opt/Kea', fake(ok)), 'a folder').toBe(false)
    expect(rootOnlyFile('/opt/Kea/gone', fake(ok)), 'missing').toBe(false)
    // the real file system: the system's shell is root's, a temp file is the user's
    expect(rootOnlyFile('/bin/sh')).toBe(true)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-plt-15-'))
    try {
      fs.writeFileSync(path.join(tmp, 'kea'), '', { mode: 0o755 })
      expect(rootOnlyFile(path.join(tmp, 'kea'))).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
