// Rebuild from the holders: the database is a cache, so at every launch, before the first launch reconciliation, every
// session the holders left state files for but the database does not have is recreated: all of them when `kea.db` was
// lost or set aside as unreadable, the newest ones when it came back stale (its WAL deleted). Nothing is scanned or
// probed unless such a session directory exists, so a normal launch pays one directory listing.
//
// For each such `<KEA_HOME>/sessions/<id>/` with trusted holder state files (holders.ts: the file names its own
// directory, its ptyId and this KEA_HOME's socket): the cwd of its agent PTY (else its first PTY) → `git rev-parse` →
// the project (the main worktree of a linked worktree, the repo root, or the folder for a non-git cwd), created once
// per root. The session row: worktree isolation when the cwd is a linked worktree (`<worktree root>/<project>/<slug>`),
// in place otherwise; the slug from the directory, the title from the slug (transcript titles need the agent's
// adapter); `live` when its agent PTY's holder is alive and its child running, else `detached` (`exited` when the state
// file has the exit, `lost` otherwise). One `ptys` row per state file, so the reconciliation that follows reattaches
// the live holders and ends the rest. `session_runtime` starts idle and is set by reconcile. Lost for good: sort order,
// presets, per-project settings, launch configs and names.
//
// Shell tabs (the `shells` pseudo-session) have no session to rebuild: their records live in terminals.json.
// A session whose cwd is gone cannot be placed in a project; its holders stay orphans (Settings › Advanced).

import fs from 'node:fs'
import path from 'node:path'
import { ulid, ulidTime, type Logger } from '@kea/kit'
import { L, ULID_RE, type EndReason, type Isolation, type Lifecycle, type PtyState } from '@kea/protocol'
import type { KeaDb } from '../platform/db/db.ts'
import { scanHolders, type HolderEntry, type HolderJson } from '../terminal/holders.ts'
import { upsertPtyRow } from '../terminal/dbRecords.ts'
import { procsProbe, type ProcessProbe } from '../terminal/procs.ts'
import { SHELLS_SESSION, startedAtMs } from '../terminal/reconcile.ts'
import { canonical, currentBranch, inspectRepo, mainEntry } from '../worktrees/git.ts'
import { defaultProjectName } from './projects.ts'
import { insertSession, titleFromSlug, type SessionRow } from './rows.ts'

/** The agent a session ran, from its agent PTY's argv (the adapters say). Null: unknown, the `shell` pseudo-agent. */
export type IdentifyAgent = (argv: readonly string[]) => string | null

/** The pseudo-agent of sessions without an agent adapter: such a session runs a login shell. */
export const SHELL_AGENT = 'shell'

export interface RebuildOptions {
  home: string
  db: KeaDb
  log: Logger
  /** Holder liveness. Default: none to ask (`procsProbe(null)`). */
  probe?: ProcessProbe
  now?: () => number
  identifyAgent?: IdentifyAgent
  /** Whether git can be run (false → every session is placed in a non-git project at its cwd). Asked only when there is something to rebuild. */
  gitUsable?: () => Promise<boolean>
}

export interface RebuildResult {
  projects: number
  sessions: number
  ptys: number
  /** Sessions that could not be rebuilt, and why. */
  skipped: { sessionId: string; why: string }[]
}

type Placed = { projectRoot: string; isGit: boolean; bare?: boolean; isolation: Isolation; cwd: string; worktreeRoot: string | null; slug: string; branch: string | null }

const SLUG_CHARS = /[^a-z0-9-]+/g

function slugOf(name: string, fallback: string): string {
  const s = name.toLowerCase().replace(SLUG_CHARS, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, L.slugMaxChars)
  return s || fallback
}

function mtimeMs(home: string, j: HolderJson): number | null {
  try {
    return Math.floor(fs.statSync(path.join(home, 'sessions', j.sessionId, `${j.ptyId}.json`)).mtimeMs)
  } catch {
    return null
  }
}

async function place(sessionId: string, cwd: string, gitUsable: boolean): Promise<Placed | string> {
  let real: string
  try {
    real = canonical(cwd)
    if (!fs.statSync(real).isDirectory()) return `cwd ${cwd} is not a directory`
  } catch {
    return `cwd ${cwd} is gone`
  }
  const fallbackSlug = `session-${sessionId.slice(-6).toLowerCase()}`
  const facts = gitUsable ? await inspectRepo(real).catch(() => null) : null
  if (!facts) return { projectRoot: real, isGit: false, isolation: 'inplace', cwd: real, worktreeRoot: null, slug: fallbackSlug, branch: null }
  if (facts.linked) {
    const branch = await currentBranch(facts.toplevel).catch(() => null)
    const main = await mainEntry(facts.toplevel)
    if (main) {
      const slug = slugOf(path.basename(facts.toplevel), fallbackSlug)
      return { projectRoot: main.path, isGit: true, bare: main.bare, isolation: 'worktree', cwd: facts.toplevel, worktreeRoot: path.dirname(path.dirname(facts.toplevel)), slug, branch }
    }
  }
  return { projectRoot: facts.toplevel, isGit: true, isolation: 'inplace', cwd: facts.toplevel, worktreeRoot: null, slug: fallbackSlug, branch: null }
}

/** Session directories with no `sessions` row (the shells pseudo-session aside). */
export function unknownSessionDirs(home: string, db: KeaDb): string[] {
  let dirs: fs.Dirent[]
  try {
    dirs = fs.readdirSync(path.join(home, 'sessions'), { withFileTypes: true })
  } catch {
    return []
  }
  return dirs
    .filter((d) => d.isDirectory() && d.name !== SHELLS_SESSION && SESSION_DIR.test(d.name))
    .map((d) => d.name)
    .filter((id) => !db.get('SELECT 1 AS x FROM sessions WHERE id = ?', id))
}

const SESSION_DIR = /^[0-9A-Za-z_-]{1,64}$/

/** See the module comment. Writes everything in one transaction. */
export async function rebuildFromHolders(o: RebuildOptions): Promise<RebuildResult> {
  const now = o.now ?? Date.now
  const result: RebuildResult = { projects: 0, sessions: 0, ptys: 0, skipped: [] }
  const unknown = new Set(unknownSessionDirs(o.home, o.db))
  if (unknown.size === 0) return result
  const scan = await scanHolders(o.home, o.probe ?? procsProbe(null))
  const bySession = new Map<string, HolderEntry[]>()
  for (const e of scan.entries.values()) {
    if (e.identity !== 'trusted' || !e.json || !unknown.has(e.json.sessionId)) continue
    bySession.set(e.json.sessionId, [...(bySession.get(e.json.sessionId) ?? []), e])
  }
  if (bySession.size === 0) return result
  const gitUsable = (await o.gitUsable?.()) ?? true

  // a holder whose liveness `ps` could not tell counts as running: reconciliation decides once ptyhost has listed it
  const running = (e: HolderEntry) => e.alive !== false && !e.json!.exited
  const plans: { sessionId: string; createdAt: number; placed: Placed; agentArgv: string[] | null; lifecycle: Lifecycle; endReason: EndReason | null; ptys: HolderEntry[] }[] = []
  for (const [sessionId, entries] of [...bySession].sort(([a], [b]) => a.localeCompare(b))) {
    const ptys = entries.sort((a, b) => a.json!.pidStartTime - b.json!.pidStartTime)
    const agent = ptys.find((e) => e.json!.kind === 'agent') ?? null
    const placed = await place(sessionId, (agent ?? ptys[0]!).json!.cwd, gitUsable)
    if (typeof placed === 'string') {
      result.skipped.push({ sessionId, why: placed })
      continue
    }
    const fileTimes = ptys.map((e) => mtimeMs(o.home, e.json!)).filter((t): t is number => t !== null)
    const createdAt = ULID_RE.test(sessionId) ? ulidTime(sessionId) : Math.min(now(), ...fileTimes)
    const live = agent !== null && running(agent)
    const endReason: EndReason | null = live ? null : agent?.json!.exited ? 'exited' : 'lost'
    plans.push({ sessionId, createdAt, placed, agentArgv: agent?.json!.argv ?? null, lifecycle: live ? 'live' : 'detached', endReason, ptys })
  }

  o.db.tx(() => {
    const projectIds = new Map<string, string>()
    let order = (o.db.get<{ m: number | null }>('SELECT max(sort_order) AS m FROM projects')?.m ?? 0) + 1
    for (const p of [...plans].sort((a, b) => a.createdAt - b.createdAt)) {
      const root = p.placed.projectRoot
      let projectId = projectIds.get(root) ?? o.db.get<{ id: string }>('SELECT id FROM projects WHERE root_path = ?', root)?.id
      if (!projectId) {
        projectId = ulid(now())
        o.db.run(
          'INSERT INTO projects (id, name, root_path, is_git, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          projectId, defaultProjectName({ root, bare: p.placed.bare === true }), root, p.placed.bare ? 2 : p.placed.isGit ? 1 : 0, order++, now(),
        )
        result.projects++
      }
      projectIds.set(root, projectId)
      let slug = p.placed.slug
      for (let n = 2; o.db.get('SELECT 1 AS x FROM sessions WHERE project_id = ? AND slug = ?', projectId, slug); n++) slug = `${p.placed.slug}-${n}`
      const row: SessionRow = {
        id: p.sessionId,
        projectId,
        slug,
        title: titleFromSlug(slug),
        titleSource: 'auto',
        isolation: p.placed.isolation,
        cwd: p.placed.cwd,
        worktreeRoot: p.placed.worktreeRoot,
        branch: p.placed.branch,
        baseBranch: null,
        baseCommit: null,
        portBase: null,
        agent: (p.agentArgv && o.identifyAgent?.(p.agentArgv)) || SHELL_AGENT,
        agentSessionId: null,
        transcriptPath: null,
        launchConfig: JSON.stringify({ prompt: '' }),
        lifecycle: p.lifecycle,
        endReason: p.endReason,
        deletedAt: null,
        snapshotRef: null,
        creationStep: null,
        diskBytes: null,
        diskAt: null,
        sortOrder: -p.createdAt, // newest first
        pinnedOrder: 0,
        createdAt: p.createdAt,
        archivedAt: null,
      }
      insertSession(o.db, row)
      result.sessions++
      p.ptys.forEach((e, i) => {
        const j = e.json!
        const state: PtyState = running(e) ? 'running' : j.exited ? 'exited' : 'lost'
        const created = mtimeMs(o.home, j) ?? p.createdAt
        upsertPtyRow(o.db, {
          ptyId: j.ptyId,
          sessionId: p.sessionId,
          kind: j.kind,
          argv: j.argv,
          cwd: j.cwd,
          title: null,
          holderPid: j.pid,
          holderStartedAt: startedAtMs(j),
          childPid: j.childPid,
          cols: 0,
          rows: 0,
          state,
          exitCode: j.exitCode,
          exitSignal: j.exitSignal,
          tabOrder: i,
          createdAt: created,
          endedAt: state === 'running' ? null : now(),
        })
        result.ptys++
      })
    }
  })
  o.log.info('sessions rebuilt from the holders’ state files', { ...result, skipped: result.skipped.length })
  for (const s of result.skipped) o.log.warn('session not rebuilt', s)
  return result
}
