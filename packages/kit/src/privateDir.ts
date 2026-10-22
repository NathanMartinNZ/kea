// A directory only this user can reach: the socket folder's check, and the instance lock's on Linux. Its own module,
// needing only `fs`, so the OS layer can use it without a cycle through rundir.ts.

import fs from 'node:fs'

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafePathError'
  }
}

const myUid = () => process.getuid?.() ?? 0

/**
 * Create `dir` (and missing parents) mode 0700, then check it with lstat: a real directory, not a symlink, owned by
 * this user and closed to everyone else. `/tmp/kea-<uid>` is shared ground, so its first component is checked the same
 * way. Throws UnsafePathError otherwise; Kea never loosens or takes over such a directory.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const checks = [dir]
  const tmp = /^\/tmp\/kea-\d+(?=\/|$)/.exec(dir)?.[0]
  if (tmp && tmp !== dir) checks.unshift(tmp)
  for (const d of checks) {
    const st = fs.lstatSync(d)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafePathError(`${d} is not a directory`)
    if (st.uid !== myUid()) throw new UnsafePathError(`${d} is owned by uid ${st.uid}`)
    if ((st.mode & 0o077) !== 0) throw new UnsafePathError(`${d} is accessible to other users (mode ${(st.mode & 0o777).toString(8)})`)
  }
}
