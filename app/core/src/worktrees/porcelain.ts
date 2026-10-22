// `git worktree list --porcelain -z`: one record per worktree, attributes separated by NUL, records by an
// empty attribute. The first record is the main worktree (or the bare repository).

export interface WorktreeEntry {
  path: string
  /** The checked-out commit; null for a bare repository. */
  head: string | null
  /** The branch's short name (`kea/fix-x`), null when detached or bare. */
  branch: string | null
  bare: boolean
  detached: boolean
  /** The lock reason ('' when locked without one); null when not locked. */
  locked: string | null
  /** Why `git worktree prune` would remove it; null when it would not. */
  prunable: string | null
}

export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const field of out.split('\0')) {
    if (field === '') {
      if (cur) entries.push(cur)
      cur = null
      continue
    }
    const sp = field.indexOf(' ')
    const key = sp < 0 ? field : field.slice(0, sp)
    const value = sp < 0 ? '' : field.slice(sp + 1)
    if (key === 'worktree') {
      if (cur) entries.push(cur)
      cur = { path: value, head: null, branch: null, bare: false, detached: false, locked: null, prunable: null }
      continue
    }
    if (!cur) continue
    switch (key) {
      case 'HEAD':
        cur.head = value
        break
      case 'branch':
        cur.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
        break
      case 'bare':
        cur.bare = true
        break
      case 'detached':
        cur.detached = true
        break
      case 'locked':
        cur.locked = value
        break
      case 'prunable':
        cur.prunable = value
        break
    }
  }
  if (cur) entries.push(cur)
  return entries
}

/** The lock reason `git worktree add` leaves while it runs; an add killed midway leaves it behind. */
export const INITIALIZING_LOCK = 'initializing'
