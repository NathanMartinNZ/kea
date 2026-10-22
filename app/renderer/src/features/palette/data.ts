// The palette's data while it is open: its sources read into the candidates the index matches, and a match read back
// into the row the list shows (its title now, its key now, why it cannot run now). Made when the palette opens and made
// again when what it shows changes underneath it; a keystroke only searches it.
//
// `Sources` is the seam between the palette and the window: the window's own (`sources.ts`) reads the stores and the
// registry; a perf test gives the palette a synthetic one of a fixed size (P-UI-3: 500 sessions, 200 commands). Pure:
// nothing here reads the window.

import { commandById, L, type SessionGlyph } from '@kea/protocol'
import { BOOST, emptyContent, markRuns, matchField, mostUsed, needleOf, PaletteIndex, STARTERS, usageBoost, type Candidate, type Hit } from './model.ts'
import type { Usage } from './usage.ts'

export interface SessionSource {
  id: string
  title: string
  branch: string | null
  project: string
  glyph: SessionGlyph
  /** In the attention set: it leads an empty query and is boosted in a search. */
  needsYou: boolean
}

export interface CommandSource {
  id: string
  /** The table's title: what a query is matched against. */
  title: string
  category: string
}

/** What a command's row says now. */
export interface CommandNow {
  title: string
  shortcut: string | null
  /** Why it cannot run now; null when it can. */
  reason: string | null
  /** What `↵` does on the row instead, while it cannot run; null for nothing. */
  remedy: string | null
}

export interface Sources {
  sessions(): SessionSource[]
  /** The sessions that need you, in attention order. */
  needing(): string[]
  /** The sessions in the order they were last looked at (`⌃Tab`'s). */
  recent(): readonly string[]
  commands(): readonly CommandSource[]
  projects(): { id: string; name: string }[]
  /** A command's row now; asked only for the rows shown. */
  now(id: string): CommandNow
}

/** One row of the list. */
export interface Row {
  /** Unique in the list: `<kind>:<id>`. */
  key: string
  kind: Candidate['kind']
  id: string
  /** The title as runs, the characters the query matched marked. */
  title: readonly { text: string; hit: boolean }[]
  /** The quieter text after the title: a session's project and branch, a command's category or why it cannot run. */
  detail: string | null
  glyph: SessionGlyph | null
  shortcut: string | null
  /** An unavailable command: listed dimmed with its reason. */
  disabled: boolean
  /** What `↵` does on a disabled row instead, as the row says it. */
  remedy: string | null
}

/**
 * The palette's view of its sources while it is open: the index over them, and the rows of a query. Made when the
 * palette opens and made again when the sources change under it; a keystroke only searches it.
 */
export class PaletteData {
  private readonly src: Sources
  private readonly sessions: ReadonlyMap<string, SessionSource>
  private readonly projects: ReadonlyMap<string, string>
  private readonly commandIds: readonly string[]
  private readonly categories: ReadonlyMap<string, string>
  private readonly index: PaletteIndex
  private readonly needing: readonly string[]
  private readonly used: readonly string[]
  /** What each command's row says now, asked once per command while this data stands (a `when` can be costly). */
  private readonly nowCache = new Map<string, CommandNow>() // bounded: one per command of the sources, for the life of this object (replaced with it on every change)

  constructor(src: Sources, usage: Pick<Usage, 'count'>) {
    this.src = src
    const sessions = src.sessions()
    const cmds = src.commands()
    const projs = src.projects()
    this.sessions = new Map(sessions.map((s) => [s.id, s]))
    this.projects = new Map(projs.map((p) => [p.id, p.name]))
    this.commandIds = cmds.map((c) => c.id)
    this.categories = new Map(cmds.map((c) => [c.id, c.category]))
    this.needing = src.needing()
    this.used = mostUsed(this.commandIds, (id) => usage.count(id), STARTERS)
    const items: Candidate[] = []
    for (const s of sessions) items.push({ kind: 'session', id: s.id, fields: [s.title, s.branch ?? '', s.project], boost: BOOST.session + (s.needsYou ? BOOST.needsYou : 0) })
    // a command is found by its title, and by its category with its title ("project open" → Project · Open in Editor)
    for (const c of cmds) items.push({ kind: 'command', id: c.id, fields: [c.title, `${c.category} ${c.title}`], boost: BOOST.command + usageBoost(usage.count(c.id)) })
    for (const p of projs) items.push({ kind: 'project', id: p.id, fields: [p.name], boost: BOOST.project })
    this.index = new PaletteIndex(items)
  }

  /** How many candidates the index holds (the resource report's `paletteCandidates`). */
  get size(): number {
    return this.index.items.length
  }

  get commandCount(): number {
    return this.commandIds.length
  }

  /** The rows of a query over every source (`commands`: commands only), best first. */
  search(query: string, o: { commandsOnly: boolean }): Row[] {
    const hits = this.index.search(query, L.paletteResults, o.commandsOnly ? 'command' : undefined)
    const out: Row[] = []
    for (const h of hits) out.push(this.row(h, query))
    return out
  }

  /** An empty query's rows: the sessions that need you, the recent ones, the most-used commands. */
  empty(): Row[] {
    const c = emptyContent({ needing: this.needing, recent: this.src.recent().filter((id) => this.sessions.has(id)), used: this.used })
    return [...c.sessions.map((id) => this.sessionRow(id, [])), ...c.actions.map((id) => this.commandRow(id, ''))]
  }

  /** `>` alone: the commands, the most used first, then the table's order; at most `paletteResults`. */
  allCommands(): Row[] {
    return this.used.slice(0, L.paletteResults).map((id) => this.commandRow(id, ''))
  }

  private row(h: Hit, query: string): Row {
    const it = h.item
    if (it.kind === 'session') return this.sessionRow(it.id, this.index.marks(h, query))
    if (it.kind === 'command') return this.commandRow(it.id, query)
    return { key: `project:${it.id}`, kind: 'project', id: it.id, title: markRuns(it.fields[0] ?? '', this.index.marks(h, query)), detail: 'New session', glyph: null, shortcut: null, disabled: false, remedy: null }
  }

  private sessionRow(id: string, marks: readonly number[]): Row {
    const s = this.sessions.get(id) as SessionSource
    const detail = [s.project, s.branch].filter(Boolean).join(' · ')
    return { key: `session:${id}`, kind: 'session', id, title: markRuns(s.title, marks), detail: detail || null, glyph: s.glyph, shortcut: null, disabled: false, remedy: null }
  }

  private commandRow(id: string, query: string): Row {
    let now = this.nowCache.get(id)
    if (!now) this.nowCache.set(id, (now = this.src.now(id)))
    // the title shown is the one that applies now (`Stop Dev Server`), so the marks are found in it
    const marks: number[] = []
    if (query !== '') {
      const { raw, tight } = needleOf(query)
      if (matchField(now.title, now.title.toLowerCase(), raw, tight, marks) === 0) marks.length = 0
    }
    const category = this.categories.get(id) ?? commandById(id)?.category ?? ''
    return {
      key: `command:${id}`,
      kind: 'command',
      id,
      title: markRuns(now.title, marks),
      detail: now.reason ?? category,
      glyph: null,
      shortcut: now.shortcut,
      disabled: now.reason !== null,
      remedy: now.remedy,
    }
  }
}
