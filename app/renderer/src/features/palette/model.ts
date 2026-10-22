// The command palette as data: what the input's text means, how a query is matched and ranked, and what the list shows.
// Pure: `Palette.svelte` lays it out, `sources.ts` reads the window's state into candidates.
//
//   text                 base `all` (⌘⇧P)                         base `files` (⌘P)
//   fix auth             sessions, commands and projects together  files of the session on screen
//   > arch               commands only                             commands only
//   / login              files of the session on screen            (a path may start with /: it is the query)
//
// Matching. A candidate is matched on its fields (a session: title, branch, project; a command: its title and its
// category; a project: its name), the first one counting most. Three kinds of match, best first: the query as it stands
// somewhere in the field (best at its start, then at a word's start); the query's characters each starting a word or
// following on in one (`tfp`, `togfil` → Toggle File Panel); the characters in order, close together (within twice the
// query's length: letters scattered over a long title or a path are no match). A candidate's boost is added to its
// score: sessions before commands before projects, a session that needs you first (the category boosts), a command by
// how often the palette ran it.
//
// Nothing is allocated per candidate per keystroke: the lowercase fields are made when the index is built, scores go
// into arrays the index keeps, and only the rows the list will show are made into objects.

import { L } from '@kea/protocol'

export type BaseMode = 'all' | 'files'
export type Mode = 'all' | 'commands' | 'files'

/** What the input's text asks for, given how the palette was opened. */
export function parseQuery(base: BaseMode, text: string): { mode: Mode; needle: string } {
  const t = text.trimStart()
  if (t.startsWith('>')) return { mode: 'commands', needle: t.slice(1).trim() }
  if (base === 'files') return { mode: 'files', needle: t.trim() }
  if (t.startsWith('/')) return { mode: 'files', needle: t.slice(1).trim() }
  return { mode: 'all', needle: t.trim() }
}

// ── the matcher ─────────────────────────────────────────────────────────────────────────────────────

/** A match of the query as it stands scores at least this; a word-start match at least `WORDS`; any other below it. */
const WHOLE = 2000
const WORDS = 1200
const LOOSE = 400

/** Does a word start at `i` of `text`? After a separator, or at a capital that follows a small letter. */
function wordStart(text: string, i: number): boolean {
  if (i === 0) return true
  const p = text.charCodeAt(i - 1)
  // space - _ / . : (
  if (p === 32 || p === 45 || p === 95 || p === 47 || p === 46 || p === 58 || p === 40) return true
  const c = text.charCodeAt(i)
  return c >= 65 && c <= 90 && p >= 97 && p <= 122
}

/**
 * The score of a query in one field; 0 when it does not match. `lower` is `text` in lowercase, `raw` the query in
 * lowercase as typed (spaces kept, single), `tight` the same without its spaces. `out`, when given, receives the
 * indexes of the characters matched (for the highlight): only the rows shown ask for them.
 */
export function matchField(text: string, lower: string, raw: string, tight: string, out: number[] | null = null): number {
  const n = tight.length
  if (n === 0) return 1
  if (n > lower.length) return 0
  if (out) out.length = 0
  // 1. the query as it stands: at the start, else at a word's start, else anywhere
  let at = lower.indexOf(raw)
  if (at >= 0) {
    let word = at
    while (word >= 0 && !wordStart(text, word)) word = lower.indexOf(raw, word + 1)
    if (word >= 0) at = word
    if (out) for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) !== 32) out.push(at + i)
    return WHOLE + (at === 0 ? 600 : word >= 0 ? 400 : 0) - Math.min(lower.length - raw.length, 200) - Math.min(at, 100)
  }
  // 2. each character starts a word or follows the one before it; the fewer words it takes, the better
  let pos = 0
  let ok = true
  let words = 0
  for (let k = 0; k < n; k++) {
    const c = tight.charCodeAt(k)
    if (k === 0 || pos >= lower.length || lower.charCodeAt(pos) !== c) {
      let j = pos
      while (j < lower.length && !(lower.charCodeAt(j) === c && wordStart(text, j))) j++
      if (j >= lower.length) {
        ok = false
        break
      }
      pos = j
      words++
    }
    if (out) out.push(pos)
    pos++
  }
  if (ok) return WORDS + Math.max(0, 300 - words * 40) - Math.min(lower.length - n, 200)
  if (out) out.length = 0
  // 3. the characters in order: the first complete run forward, then tightened from its end backward
  let end = -1
  pos = 0
  for (let k = 0; k < n; k++) {
    const j = lower.indexOf(tight[k] as string, pos)
    if (j < 0) return 0
    pos = j + 1
    end = j
  }
  let start = end
  for (let k = n - 1, j = end; k >= 0; k--, j--) {
    const c = tight.charCodeAt(k)
    while (lower.charCodeAt(j) !== c) j--
    start = j
    if (out) out.push(j)
  }
  // letters scattered over a long text are no match: they must sit within twice the query's length
  const span = end - start + 1
  if (span > n * 2) {
    if (out) out.length = 0
    return 0
  }
  if (out) out.reverse()
  // closer together is better; a match that begins a word is better
  return LOOSE + Math.max(0, 500 - (span - n) * 12) + (wordStart(text, start) ? 150 : 0) - Math.min(lower.length - n, 200)
}

/** A query made ready for `matchField`: lowercase, its spaces single (`raw`) and removed (`tight`). */
export function needleOf(text: string): { raw: string; tight: string } {
  const raw = text.trim().toLowerCase().replace(/\s+/g, ' ')
  return { raw, tight: raw.replaceAll(' ', '') }
}

// ── the index ───────────────────────────────────────────────────────────────────────────────────────

export type CandidateKind = 'session' | 'command' | 'project' | 'choice'

export interface Candidate {
  kind: CandidateKind
  id: string
  /** What the query is matched against, the first field the one shown as the row's title. */
  fields: readonly string[]
  /** Added to a match's score: the category's boost and what the row's state adds. */
  boost: number
}

export interface Hit {
  item: Candidate
  score: number
  /** The field that matched best (0: the title). */
  field: number
}

/** A later field counts for less than the title: a session found by its branch, then by its project. */
const FIELD_WEIGHT = [1, 0.85, 0.7] as const

/** The category boosts: sessions, then commands, then projects; a session that needs you; a used command. */
export const BOOST = { session: 150, needsYou: 100, command: 0, project: -100, usedOnce: 5, usedMax: 100 } as const

export class PaletteIndex {
  readonly items: readonly Candidate[]
  /** Each item's fields in lowercase, flat: item `i`'s are at `first[i]` … `first[i + 1] - 1`. */
  private readonly lower: string[] = [] // bounded: one string per field of the candidates given (sources.ts: the window's sessions, commands and projects)
  private readonly text: string[] = [] // bounded: as `lower`
  private readonly first: Int32Array
  private readonly scores: Float64Array
  private readonly fields: Uint8Array
  private readonly order: Int32Array

  constructor(items: readonly Candidate[]) {
    this.items = items
    this.first = new Int32Array(items.length + 1)
    for (const [i, it] of items.entries()) {
      this.first[i] = this.lower.length
      for (const f of it.fields) {
        this.text.push(f)
        this.lower.push(f.toLowerCase())
      }
    }
    this.first[items.length] = this.lower.length
    this.scores = new Float64Array(items.length)
    this.fields = new Uint8Array(items.length)
    this.order = new Int32Array(items.length)
  }

  /** The best `limit` matches of `query`, best first (ties in the candidates' own order); `kind`: only that kind. */
  search(query: string, limit: number = L.paletteResults, kind?: CandidateKind): Hit[] {
    const { raw, tight } = needleOf(query)
    const { items, lower, text, first, scores, fields, order } = this
    let count = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as Candidate
      if (kind !== undefined && it.kind !== kind) continue
      let best = 0
      let field = 0
      const from = first[i] as number
      const to = first[i + 1] as number
      for (let f = from; f < to; f++) {
        const s = matchField(text[f] as string, lower[f] as string, raw, tight) * (FIELD_WEIGHT[f - from] ?? 0.7)
        if (s > best) {
          best = s
          field = f - from
        }
      }
      if (best <= 0) continue
      scores[i] = best + it.boost
      fields[i] = field
      order[count++] = i
    }
    const found = order.subarray(0, count)
    found.sort((a, b) => (scores[b] as number) - (scores[a] as number) || a - b)
    const out: Hit[] = []
    for (let k = 0; k < count && k < limit; k++) {
      const i = found[k] as number
      out.push({ item: items[i] as Candidate, score: scores[i] as number, field: fields[i] as number })
    }
    return out
  }

  /** The characters of a hit's title the query matched (for the highlight); none when another field matched. */
  marks(hit: Hit, query: string): number[] {
    if (hit.field !== 0) return []
    const { raw, tight } = needleOf(query)
    const title = hit.item.fields[0] ?? ''
    const out: number[] = []
    matchField(title, title.toLowerCase(), raw, tight, out)
    return out
  }
}

// ── what the list shows ─────────────────────────────────────────────────────────────────────────────

/** The list's sections, and the two a continuation shows: an argument's choices, the files of a session. */
export type SectionId = 'sessions' | 'actions' | 'projects' | 'choices'
export const SECTION_OF: Readonly<Record<CandidateKind, SectionId>> = { session: 'sessions', command: 'actions', project: 'projects', choice: 'choices' }
export const SECTION_TITLE: Readonly<Record<SectionId, string>> = { sessions: 'Sessions', actions: 'Actions', projects: 'Projects', choices: 'Choices' }

/**
 * The hits as the list shows them (Sessions, Actions, Projects): ranked together, then laid out by
 * section, the section of the best match first and each section's rows in rank order, so the first row is always the
 * best match of all.
 */
export function sectioned<T extends { item: { kind: CandidateKind } }>(hits: readonly T[]): { id: SectionId; hits: T[] }[] {
  const out: { id: SectionId; hits: T[] }[] = []
  for (const h of hits) {
    const id = SECTION_OF[h.item.kind]
    const s = out.find((x) => x.id === id)
    if (s) s.hits.push(h)
    else out.push({ id, hits: [h] })
  }
  return out
}

/**
 * What an empty query lists. The sessions that need you (in attention order as given), then the recent ones (the `⌃Tab`
 * order, those already listed left out, at most `paletteRecentSessions`), then the `paletteRecentCommands` most-used
 * commands.
 */
export function emptyContent(a: { needing: readonly string[]; recent: readonly string[]; used: readonly string[] }): { sessions: string[]; actions: string[] } {
  const needing = new Set(a.needing)
  const recent = a.recent.filter((id) => !needing.has(id)).slice(0, L.paletteRecentSessions)
  return { sessions: [...a.needing, ...recent], actions: a.used.slice(0, L.paletteRecentCommands) }
}

/**
 * The commands by how often the palette ran them, most first; among equals the starters (what a first palette shows),
 * then the table's order. `ids`: every command, in table order.
 */
export function mostUsed(ids: readonly string[], count: (id: string) => number, starters: readonly string[]): string[] {
  const place = new Map<string, number>()
  for (const [i, id] of ids.entries()) place.set(id, starters.length + i)
  for (const [i, id] of starters.entries()) if (place.has(id)) place.set(id, i)
  return [...ids].sort((a, b) => count(b) - count(a) || (place.get(a) as number) - (place.get(b) as number))
}

/** What a palette that was never used offers first: the most-used commands before any count. */
export const STARTERS: readonly string[] = ['session.new', 'project.add', 'files.goToFile', 'server.toggle', 'session.openInEditor', 'app.settings']

/** A command's boost from its use: it grows with each run and stops at `BOOST.usedMax`. */
export function usageBoost(count: number): number {
  return Math.min(BOOST.usedMax, count * BOOST.usedOnce)
}

/** A title as runs for the highlight: `marks` are the indexes the query matched. */
export function markRuns(text: string, marks: readonly number[]): { text: string; hit: boolean }[] {
  if (marks.length === 0) return text === '' ? [] : [{ text, hit: false }]
  const hit = new Set(marks)
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const h = hit.has(i)
    const last = out[out.length - 1]
    if (last && last.hit === h) last.text += text[i]
    else out.push({ text: text[i] as string, hit: h })
  }
  return out
}

/** ↑ ↓ through `count` rows, wrapping; PageUp and PageDown to the ends. Null: not a movement key; -1: no rows. */
export function moveRow(count: number, index: number, key: string): number | null {
  const moves = key === 'ArrowDown' || key === 'ArrowUp' || key === 'PageDown' || key === 'PageUp'
  if (!moves) return null
  if (count === 0) return -1
  if (key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowUp') return (index - 1 + count) % count
  return key === 'PageDown' ? count - 1 : 0
}
