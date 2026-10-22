// The generated Settings sections as data: which rows a section shows, what a control shows for a value, and the value
// a control's text stands for. Everything comes from the rows (`SettingRow`, protocol/settings.ts), which come from the
// schema; nothing here names a key, so a setting added to the schema is drawn with no change (U-SET-6). A value is
// checked by its schema, in core (`settings.set`): this only turns text into the shape the schema reads.

import type { AgentInfo, SettingRow, SettingsDescription, SettingsSection } from '@kea/protocol'

/** The rows a generated section draws: every key of that section that has a control, in the schema's order. */
export function sectionRows(rows: readonly SettingRow[], section: SettingsSection): SettingRow[] {
  return rows.filter((r) => r.section === section && r.control !== 'none' && r.agent === undefined)
}

/** One adapter's card in the Agents section: what core detected, then its rows (the shared keys, then its own). */
export interface AgentCard {
  id: string
  displayName: string
  info: AgentInfo | null
  rows: SettingRow[]
}

/** The Agents section: one card per registered adapter, in registry order. */
export function agentCards(d: SettingsDescription, infos: readonly AgentInfo[]): AgentCard[] {
  return d.agents.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    info: infos.find((i) => i.id === a.id) ?? null,
    rows: d.rows.filter((r) => r.agent === a.id && r.control !== 'none'),
  }))
}

/** What the card says about the CLI: detected path, version and login state, or "Not installed". */
export function agentSummary(info: AgentInfo | null): { state: 'detecting' | 'installed' | 'missing' | 'none'; lines: string[] } {
  if (!info || info.state === 'detecting') return { state: 'detecting', lines: ['Looking for it…'] }
  if (info.state === 'pseudo') return { state: 'none', lines: [] }
  if (info.state === 'missing') return { state: 'missing', lines: ['Not installed'] }
  const login = info.loggedIn === null ? null : info.loggedIn ? 'Signed in' : 'Signed out'
  return { state: 'installed', lines: [[info.version ? `Version ${info.version}` : null, login].filter(Boolean).join(' · '), ...(info.notice ? [info.notice] : [])].filter((l) => l !== '') }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The value differs from the default: the row offers "Reset". */
export function isModified(row: SettingRow, value: unknown): boolean {
  return !same(value, row.default)
}

/** The options of a select: the schema's, or the registered adapters for a key that names one (`optionsFrom`). */
export function optionsOf(row: SettingRow, agents: readonly { id: string; displayName: string }[]): { value: string; label: string }[] {
  if (row.options) return [...row.options]
  if (row.optionsFrom === 'agents') return agents.map((a) => ({ value: a.id, label: a.displayName }))
  return []
}

/** What a text-like control shows for a value: a number or string as typed, a list one item per line, a map as `NAME=value` lines. */
export function shownText(row: SettingRow, value: unknown): string {
  if (value === null || value === undefined) return ''
  if (row.control === 'list') return Array.isArray(value) ? value.join('\n') : ''
  if (row.control === 'map') return typeof value === 'object' ? Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join('\n') : ''
  return String(value)
}

export type Parsed = { value: unknown } | { reset: true } | { error: string }

/**
 * The value a control's text stands for. An emptied control that may be empty (`nullable`: a path override) resets the
 * key; text that has no reading as this control's kind is refused here (a number that is not one, a map line without
 * `=`); everything else goes to core, whose schema decides (range, pattern, length).
 */
export function parseText(row: SettingRow, text: string): Parsed {
  if (row.control === 'number') {
    const t = text.trim()
    const n = t === '' ? NaN : Number(t)
    return Number.isFinite(n) ? { value: n } : { error: 'Enter a number' }
  }
  if (row.control === 'list') {
    return { value: text.split('\n').map((l) => l.trim()).filter((l) => l !== '') }
  }
  if (row.control === 'map') {
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const eq = line.indexOf('=')
      if (eq <= 0) return { error: `“${line.trim()}” is not NAME=value` }
      out[line.slice(0, eq).trim()] = line.slice(eq + 1)
    }
    return { value: out }
  }
  const t = text.trim()
  if (t === '' && row.nullable) return { reset: true }
  return { value: t }
}

/** The schema's message without the key core puts before it (`terminal.fontSize: Too big: …`). */
export function refusal(row: SettingRow, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.startsWith(`${row.fullKey}: `) ? msg.slice(row.fullKey.length + 2) : msg
}

/** A row's id in the document (labels, described-by). */
export function rowId(row: SettingRow): string {
  return `setting-${row.fullKey.replace(/[^A-Za-z0-9]+/g, '-')}`
}

// ── Advanced: the holders ─────────────────────────────────────────────────────────────────────────────

/** How long a holder has run, in the two largest units that say it (`3 h 20 min`); empty when its start is not known. */
export function uptimeText(startedAt: number | null, now: number): string {
  if (startedAt === null) return ''
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  const [d, h, m] = [Math.floor(s / 86_400), Math.floor((s % 86_400) / 3600), Math.floor((s % 3600) / 60)]
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`
  return m > 0 ? `${m} min` : `${s} s`
}

/** A holder's kind as Advanced names it (the tab it is: Agent, Setup, Server, a shell). */
export function kindText(kind: string | null): string {
  return kind === 'agent' ? 'Agent' : kind === 'script' ? 'Setup' : kind === 'server' ? 'Server' : kind === 'shell' ? 'Shell' : 'Unknown'
}
