// The query table. Terminal queries are answered only by the ptyhost mirror, whose replies go to the PTY;
// the renderer's xterm swallows every query form with a parser hook that returns `true` only for the query form, so
// set/push forms still apply there. Each entry says who answers on the mirror:
//
//   xterm  — `@xterm/headless` answers it itself (same code as the renderer's xterm, so the reply is identical)
//   kea    — the headless mirror does not answer it; `installMirrorResponders` does
//   nobody — deliberately unanswered (window reports would echo attacker-chosen text; clipboard reads are denied;
//            unimplemented queries fall back after the DA1 sentinel), swallowed on both sides
//
// No query is answered twice (the renderer swallows all of them) or never (every entry has exactly one answerer or is
// deliberately silent). queries.test.ts checks every entry on both sides (U-PTY-5).

import { BG, ColorState, colorReport, CURSOR, FG, luminance, parseOsc104, parseOsc4, parseOscSpecial, type ColorRequest } from './colors.ts'
import { disposeAll, p0, type CsiParams, type Disposable, type FunctionIdentifier, type ParserApi, type TerminalApi } from './xterm.ts'

export type Answerer = 'xterm' | 'kea' | 'nobody'

interface EntryBase {
  id: string
  name: string
  answeredBy: Answerer
  /** A query in this entry's form, for tests and the dev-build prober. */
  example: string
  /** Pattern of the mirror's reply to `example` (null when nobody answers). */
  reply: RegExp | null
  note?: string
}

export type QueryEntry =
  | (EntryBase & { kind: 'csi'; ident: FunctionIdentifier; isQuery: (params: CsiParams) => boolean })
  | (EntryBase & { kind: 'dcs'; ident: FunctionIdentifier; isQuery: (data: string, params: CsiParams) => boolean })
  | (EntryBase & { kind: 'osc'; ident: number; isQuery: (data: string) => boolean })

const always = () => true
const hasReport = (reqs: ColorRequest[]) => reqs.some((r) => r.type === 'report')

/** Window reports xterm can produce (`CSI Ps t`, Ps = 11, 13, 14, 15, 16, 18, 19, 20, 21); 14/16/18 are geometry. */
const WINDOW_REPORTS_SILENT = new Set([11, 13, 15, 19, 20, 21])

export const QUERY_TABLE: readonly QueryEntry[] = [
  { id: 'DA1', name: 'Primary device attributes', kind: 'csi', ident: { final: 'c' }, isQuery: (p) => p0(p) === 0, answeredBy: 'xterm', example: '\x1b[c', reply: /^\x1b\[\?1;2c$/ },
  { id: 'DA2', name: 'Secondary device attributes', kind: 'csi', ident: { prefix: '>', final: 'c' }, isQuery: (p) => p0(p) === 0, answeredBy: 'xterm', example: '\x1b[>c', reply: /^\x1b\[>0;276;0c$/ },
  { id: 'DA3', name: 'Tertiary device attributes', kind: 'csi', ident: { prefix: '=', final: 'c' }, isQuery: always, answeredBy: 'nobody', example: '\x1b[=c', reply: null, note: 'xterm.js does not implement DA3' },
  { id: 'DSR', name: 'Device status report (5) / cursor position (6)', kind: 'csi', ident: { final: 'n' }, isQuery: (p) => p0(p) === 5 || p0(p) === 6, answeredBy: 'xterm', example: '\x1b[6n', reply: /^\x1b\[\d+;\d+R$/ },
  { id: 'DECXCPR', name: 'Extended cursor position', kind: 'csi', ident: { prefix: '?', final: 'n' }, isQuery: (p) => p0(p) === 6, answeredBy: 'xterm', example: '\x1b[?6n', reply: /^\x1b\[\?\d+;\d+R$/ },
  { id: 'COLOR_SCHEME', name: 'Colour scheme (dark/light)', kind: 'csi', ident: { prefix: '?', final: 'n' }, isQuery: (p) => p0(p) === 996, answeredBy: 'kea', example: '\x1b[?996n', reply: /^\x1b\[\?997;[12]n$/, note: 'renderer also has vtExtensions.colorSchemeQuery: false' },
  { id: 'DECRQM', name: 'Request ANSI mode', kind: 'csi', ident: { intermediates: '$', final: 'p' }, isQuery: always, answeredBy: 'xterm', example: '\x1b[4$p', reply: /^\x1b\[4;[0-4]\$y$/ },
  { id: 'DECRQM_DEC', name: 'Request DEC private mode (incl. 2026)', kind: 'csi', ident: { prefix: '?', intermediates: '$', final: 'p' }, isQuery: always, answeredBy: 'xterm', example: '\x1b[?2026$p', reply: /^\x1b\[\?2026;[0-4]\$y$/ },
  { id: 'KITTY_KBD', name: 'Kitty keyboard flags', kind: 'csi', ident: { prefix: '?', final: 'u' }, isQuery: always, answeredBy: 'xterm', example: '\x1b[?u', reply: /^\x1b\[\?\d+u$/ },
  { id: 'XTVERSION', name: 'Terminal name and version', kind: 'csi', ident: { prefix: '>', final: 'q' }, isQuery: (p) => p0(p) === 0, answeredBy: 'xterm', example: '\x1b[>q', reply: /^\x1bP>\|xterm\.js\([^)]*\)\x1b\\$/ },
  { id: 'DECRQSS', name: 'Request setting', kind: 'dcs', ident: { intermediates: '$', final: 'q' }, isQuery: always, answeredBy: 'xterm', example: '\x1bP$qr\x1b\\', reply: /^\x1bP1\$r\d+;\d+r\x1b\\$/ },
  { id: 'XTGETTCAP', name: 'Termcap query', kind: 'dcs', ident: { intermediates: '+', final: 'q' }, isQuery: always, answeredBy: 'nobody', example: '\x1bP+q544e\x1b\\', reply: null, note: 'not implemented by xterm.js; programs fall back after the DA1 sentinel' },
  { id: 'OSC4', name: 'Palette colour', kind: 'osc', ident: 4, isQuery: (d) => hasReport(parseOsc4(d)), answeredBy: 'kea', example: '\x1b]4;1;?\x07', reply: /^\x1b\]4;1;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x1b\\$/ },
  { id: 'OSC10', name: 'Default foreground', kind: 'osc', ident: 10, isQuery: (d) => hasReport(parseOscSpecial(10, d)), answeredBy: 'kea', example: '\x1b]10;?\x07', reply: /^\x1b\]10;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x1b\\$/ },
  { id: 'OSC11', name: 'Default background', kind: 'osc', ident: 11, isQuery: (d) => hasReport(parseOscSpecial(11, d)), answeredBy: 'kea', example: '\x1b]11;?\x1b\\', reply: /^\x1b\]11;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x1b\\$/ },
  { id: 'OSC12', name: 'Cursor colour', kind: 'osc', ident: 12, isQuery: (d) => hasReport(parseOscSpecial(12, d)), answeredBy: 'kea', example: '\x1b]12;?\x07', reply: /^\x1b\]12;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x1b\\$/ },
  { id: 'OSC52_READ', name: 'Clipboard read', kind: 'osc', ident: 52, isQuery: (d) => d.split(';')[1] === '?', answeredBy: 'nobody', example: '\x1b]52;c;?\x07', reply: null, note: 'clipboard reads are denied' },
  { id: 'WIN_PX', name: 'Text area size in pixels', kind: 'csi', ident: { final: 't' }, isQuery: (p) => p0(p) === 14, answeredBy: 'kea', example: '\x1b[14t', reply: /^\x1b\[4;\d+;\d+t$/ },
  { id: 'CELL_PX', name: 'Cell size in pixels', kind: 'csi', ident: { final: 't' }, isQuery: (p) => p0(p) === 16, answeredBy: 'kea', example: '\x1b[16t', reply: /^\x1b\[6;\d+;\d+t$/ },
  { id: 'WIN_CHARS', name: 'Text area size in characters', kind: 'csi', ident: { final: 't' }, isQuery: (p) => p0(p) === 18, answeredBy: 'kea', example: '\x1b[18t', reply: /^\x1b\[8;\d+;\d+t$/ },
  { id: 'WIN_REPORTS', name: 'Window state, position, screen size, icon label and title reports', kind: 'csi', ident: { final: 't' }, isQuery: (p) => WINDOW_REPORTS_SILENT.has(p0(p)), answeredBy: 'nobody', example: '\x1b[21t', reply: null, note: 'a title report would echo attacker-chosen text into the input' },
]

function identKey(e: QueryEntry): string {
  if (e.kind === 'osc') return `osc:${e.ident}`
  const i = e.ident
  return `${e.kind}:${i.prefix ?? ''}|${i.intermediates ?? ''}|${i.final}`
}

/** Entries grouped by parser identifier: one hook per identifier on each side. */
function groups(): Map<string, QueryEntry[]> {
  const m = new Map<string, QueryEntry[]>()
  for (const e of QUERY_TABLE) {
    const k = identKey(e)
    const list = m.get(k)
    if (list) list.push(e)
    else m.set(k, [e])
  }
  return m
}

/** The entry a sequence matches, if it is a query form. */
export function matchQuery(kind: 'csi' | 'dcs', ident: FunctionIdentifier, params: CsiParams, data?: string): QueryEntry | undefined
export function matchQuery(kind: 'osc', ident: number, data: string): QueryEntry | undefined
export function matchQuery(kind: 'csi' | 'dcs' | 'osc', ident: FunctionIdentifier | number, a: CsiParams | string, b?: string): QueryEntry | undefined {
  for (const e of QUERY_TABLE) {
    if (e.kind !== kind) continue
    if (e.kind === 'osc') {
      if (e.ident === ident && e.isQuery(a as string)) return e
      continue
    }
    const i = ident as FunctionIdentifier
    if ((e.ident.prefix ?? '') !== (i.prefix ?? '') || (e.ident.intermediates ?? '') !== (i.intermediates ?? '') || e.ident.final !== i.final) continue
    if (e.kind === 'csi' && e.isQuery(a as CsiParams)) return e
    if (e.kind === 'dcs' && e.isQuery(b ?? '', a as CsiParams)) return e
  }
  return undefined
}

// ── renderer side ─────────────────────────────────────────────────────────────────────────────────────────

export interface SwallowOptions {
  /** Called for each swallowed query, for a caller that logs query traffic (the renderer passes none). */
  onSwallow?: (entry: QueryEntry) => void
}

/**
 * Renderer: swallow every query form so the renderer's xterm never replies. Set forms still apply; a colour OSC that
 * mixes sets and queries is swallowed and its sets are re-applied as a set-only sequence.
 */
export function installRendererSwallow(term: Pick<TerminalApi, 'parser' | 'write'>, opts: SwallowOptions = {}): Disposable {
  const ds: Disposable[] = []
  const p: ParserApi = term.parser
  for (const list of groups().values()) {
    const first = list[0] as QueryEntry
    if (first.kind === 'csi') {
      ds.push(
        p.registerCsiHandler(first.ident, (params) => {
          const hit = list.find((e) => e.kind === 'csi' && e.isQuery(params))
          if (hit) opts.onSwallow?.(hit)
          return !!hit
        }),
      )
    } else if (first.kind === 'dcs') {
      ds.push(
        p.registerDcsHandler(first.ident, (data, params) => {
          const hit = list.find((e) => e.kind === 'dcs' && e.isQuery(data, params))
          if (hit) opts.onSwallow?.(hit)
          return !!hit
        }),
      )
    } else {
      const ident = first.ident
      ds.push(
        p.registerOscHandler(ident, (data) => {
          const hit = list.find((e) => e.kind === 'osc' && e.isQuery(data))
          if (!hit) return false
          opts.onSwallow?.(hit)
          const sets = colorSetsOnly(ident, data)
          if (sets) term.write(sets)
          return true
        }),
      )
    }
  }
  return { dispose: () => disposeAll(ds.splice(0)) }
}

/** For a colour OSC that mixes sets with queries: the sets alone, as separate sequences; '' when there are none. */
export function colorSetsOnly(ident: number, data: string): string {
  let reqs: ColorRequest[]
  if (ident === 4) reqs = parseOsc4(data)
  else if (ident === 10 || ident === 11 || ident === 12) reqs = parseOscSpecial(ident, data)
  else return ''
  let s = ''
  for (const r of reqs) {
    if (r.type !== 'set') continue
    const spec = `#${r.rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`
    s += r.index < 256 ? `\x1b]4;${r.index};${spec}\x1b\\` : `\x1b]${10 + r.index - FG};${spec}\x1b\\`
  }
  return s
}

// ── mirror side ───────────────────────────────────────────────────────────────────────────────────────────

export interface MirrorQueryContext {
  /** Theme plus program overrides; colour sets/restores are applied here, in order with the reports. */
  colors: ColorState
  /** Last pixel size of the text area from the renderer's RESIZE; null until a renderer has reported one. */
  pixelSize(): { width: number; height: number } | null
  /** Write a reply to the PTY. The owner drops replies while the mirror rebuilds from the ring. */
  reply(data: string): void
}

/**
 * Mirror: Kea's responders for what `@xterm/headless` does not answer (colours, colour scheme, pixel and character
 * geometry), plus hooks that keep the deliberately silent entries silent. Builtin-answered entries get no hook.
 */
export function installMirrorResponders(term: Pick<TerminalApi, 'parser' | 'rows' | 'cols'>, ctx: MirrorQueryContext): Disposable {
  const ds: Disposable[] = []
  const p = term.parser

  const colorHook = (parse: (data: string) => ColorRequest[]) => (data: string) => {
    for (const { index, rgb } of ctx.colors.apply(parse(data))) ctx.reply(colorReport(index, rgb))
    return false // xterm.js still sees sets (no effect on the headless mirror); it never answers reports there
  }
  ds.push(
    p.registerOscHandler(4, colorHook(parseOsc4)),
    p.registerOscHandler(10, colorHook((d) => parseOscSpecial(10, d))),
    p.registerOscHandler(11, colorHook((d) => parseOscSpecial(11, d))),
    p.registerOscHandler(12, colorHook((d) => parseOscSpecial(12, d))),
    p.registerOscHandler(104, colorHook(parseOsc104)),
    p.registerOscHandler(110, colorHook(() => [{ type: 'restore', index: FG }])),
    p.registerOscHandler(111, colorHook(() => [{ type: 'restore', index: BG }])),
    p.registerOscHandler(112, colorHook(() => [{ type: 'restore', index: CURSOR }])),
    p.registerOscHandler(52, (data) => data.split(';')[1] === '?'), // clipboard read: silent
    p.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
      if (p0(params) !== 996) return false
      // as xterm.js decides it: dark when the background is darker than the foreground
      const dark = luminance(ctx.colors.get(BG)) < luminance(ctx.colors.get(FG))
      ctx.reply(`\x1b[?997;${dark ? 1 : 2}n`)
      return true
    }),
    p.registerCsiHandler({ final: 't' }, (params) => {
      const op = p0(params)
      if (op === 14 || op === 16) {
        const px = ctx.pixelSize()
        const w = px?.width ?? 0
        const h = px?.height ?? 0
        if (op === 14) ctx.reply(`\x1b[4;${h};${w}t`)
        else ctx.reply(`\x1b[6;${term.rows ? Math.floor(h / term.rows) : 0};${term.cols ? Math.floor(w / term.cols) : 0}t`)
        return true
      }
      if (op === 18) {
        ctx.reply(`\x1b[8;${term.rows};${term.cols}t`)
        return true
      }
      return WINDOW_REPORTS_SILENT.has(op) // silent; other window ops fall through (windowOptions are all off)
    }),
  )
  return { dispose: () => disposeAll(ds.splice(0)) }
}
