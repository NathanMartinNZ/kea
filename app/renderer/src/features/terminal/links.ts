// Link policy: `⌘`-click opens OSC 8 and detected links in the default browser only when their scheme is http, https or
// mailto. Any other target is not opened: hovering shows the full target and `⌘`-click offers "Copy link". Main checks
// the scheme again before opening.
//
// File references: `path`, `path:line`, `path:line:col` and `path(line,col)` printed in a session's terminal,
// and `file:` targets, are links when core says they are files inside the session's worktree
// (`editor.resolvePaths`); a `⌘`-click opens the editor at that position. This file is the pure part: finding the
// references in a line, mapping them onto the terminal's cells, and remembering what core answered. The wiring to
// xterm, core and the editor is `fileLinks.ts`.

import { L } from '@kea/protocol'

export const OPENABLE_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:']

export type LinkAction = { open: true; url: string } | { open: false; target: string; reason: 'scheme' | 'malformed' }

// C0, DEL, C1 and the bidi controls that can make a target read as something else
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/

export function linkAction(target: string): LinkAction {
  if (CONTROL.test(target) || /\s/.test(target.trim()) || target.trim() !== target) return { open: false, target, reason: 'malformed' }
  let u: URL
  try {
    u = new URL(target)
  } catch {
    return { open: false, target, reason: 'malformed' }
  }
  if (!OPENABLE_SCHEMES.includes(u.protocol)) return { open: false, target, reason: 'scheme' }
  if (u.protocol !== 'mailto:' && !u.hostname) return { open: false, target, reason: 'malformed' }
  return { open: true, url: u.href }
}

/** The target as hover text: the full string, control characters made visible, so nothing can hide in it. */
export function linkHoverText(target: string): string {
  return target.replace(new RegExp(CONTROL.source, 'g'), (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

// ── file references ──────────────────────────────────────────────────────────────────────────────

export interface FileRef {
  /** Where the reference starts in the line and how long it is (UTF-16 units), its position included. */
  index: number
  length: number
  /** As printed: relative to the working directory, absolute, `~/…`, or a `file:` URL. */
  path: string
  /** 1-based; null when none was printed. */
  line: number | null
  col: number | null
}

// a URL of any scheme: its path is not a file reference (`https://example.com/src/a.ts:3` is one link, the browser's)
const URL_SPAN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>`]+/g
const FILE_URL = /^file:\/\//i
const TRAILING = /[.,;:!?)\]}>'"]+$/
const NAME = String.raw`[\p{L}\p{N}_@+\-.\[\]]`
// path = an optional root (`/`, `./`, `../`, `~/`), folders (a route group `(name)` is one too), a file name that ends
// in a letter, digit, `_` or `]`; then an optional position: `:line[:col]`, `(line[,col])`, or Python's `", line N`
const FILE_REF = new RegExp(
  String.raw`(?<![\p{L}\p{N}_@+\-.~/\[\]\\:])((?:~/|\.{1,2}/|/)?(?:(?:\([\p{L}\p{N}_\-.]+\)|${NAME}+)/)*${NAME}*[\p{L}\p{N}_\]])(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\)|", line (\d+))?`,
  'gu',
)
const HAS_LETTER = /\p{L}/u
const HAS_EXTENSION = /\.[\p{L}\p{N}_]{1,12}$/u

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n >= 1 ? n : null
}

/**
 * The file references printed in a line, left to right, at most `max` (L.terminalLinkCandidatesMax). A reference names
 * a folder on the way (`src/a.ts`) or has a file extension (`README.md`); bare words and numbers are not candidates.
 * Whether one is a file at all is core's answer (`LinkChecks`).
 */
export function detectFileRefs(text: string, max: number = L.terminalLinkCandidatesMax): FileRef[] {
  const refs: FileRef[] = []
  // `file:` URLs are references themselves; every other URL is blanked so that nothing inside it is taken for a path
  const plain = text.replace(URL_SPAN, (url, at: number) => {
    if (FILE_URL.test(url)) {
      const target = url.replace(TRAILING, '')
      // one with a control or bidi character is no reference (as `isFileUrl` says of an OSC 8 target)
      if (target.length <= L.terminalLinkPathMaxChars && !CONTROL.test(target)) refs.push({ index: at, length: target.length, path: target, line: null, col: null })
    }
    return ' '.repeat(url.length)
  })
  for (const m of plain.matchAll(FILE_REF)) {
    const path = m[1] as string
    if (path.length > L.terminalLinkPathMaxChars || !HAS_LETTER.test(path)) continue
    if (!path.includes('/') && !HAS_EXTENSION.test(path)) continue
    const line = num(m[2] ?? m[4] ?? m[6])
    refs.push({ index: m.index, length: m[0].length, path, line, col: line === null ? null : num(m[3] ?? m[5]) })
  }
  return refs.sort((a, b) => a.index - b.index).slice(0, max)
}

/** `src/a.ts:42:7`: a reference as the hover shows it and as messages say it. */
export function fileRefText(path: string, line: number | null, col: number | null): string {
  if (line === null) return path
  return col === null ? `${path}:${line}` : `${path}:${line}:${col}`
}

/** A terminal cell, 1-based as xterm's link ranges are; `w` is its width in columns (2 for a wide character). */
export interface Cell {
  x: number
  y: number
  w: number
}

/** The parts of xterm's buffer the mapping reads. */
export interface BufferLineLike {
  readonly isWrapped: boolean
  readonly length: number
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined
}
export interface BufferLike {
  readonly length: number
  getLine(y: number): BufferLineLike | undefined
}

/**
 * The logical line that buffer row `y` (0-based) is part of: its wrapped rows joined, up to `maxChars`, with the cell
 * of every UTF-16 unit of the text (a path that wraps is still one reference).
 */
export function logicalLine(buffer: BufferLike, y: number, maxChars: number = L.terminalLinkLineMaxChars): { text: string; cells: Cell[] } {
  let start = y
  let budget = maxChars
  // back to the row the line begins on, no further than the text read could reach
  while (start > 0 && buffer.getLine(start)?.isWrapped && budget > 0) {
    start--
    budget -= buffer.getLine(start)?.length ?? 0
  }
  let text = ''
  const cells: Cell[] = []
  for (let row = start; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line || (row > start && !line.isWrapped)) break
    for (let x = 0; x < line.length && text.length < maxChars; x++) {
      const cell = line.getCell(x)
      const w = cell?.getWidth() ?? 1
      if (w === 0) continue // the second half of a wide character
      const chars = cell?.getChars() || ' '
      text += chars
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: row + 1, w })
    }
    if (text.length >= maxChars) break
  }
  return { text, cells }
}

/** The cells a reference covers, as an xterm link range (inclusive, 1-based); null when it has none. */
export function refRange(cells: readonly Cell[], ref: Pick<FileRef, 'index' | 'length'>): { start: { x: number; y: number }; end: { x: number; y: number } } | null {
  const first = cells[ref.index]
  const last = cells[ref.index + ref.length - 1]
  if (!first || !last) return null
  return { start: { x: first.x, y: first.y }, end: { x: last.x + last.w - 1, y: last.y } }
}

/** Asks core which printed paths are files of a session: one answer per path, in order (the path relative to the working directory, or null). */
export type ResolvePaths = (sessionId: string, paths: string[]) => Promise<(string | null)[]>

/**
 * What core answered for printed paths, remembered for L.terminalLinkCacheMs (files come and go) so that moving the
 * pointer along a line asks once. Least recently used first out.
 */
export class LinkChecks {
  // bounded: L.terminalLinkCacheMax entries, least recently used first out
  private readonly known = new Map<string, { file: string | null; at: number }>()
  private readonly resolve: ResolvePaths
  private readonly now: () => number

  constructor(resolve: ResolvePaths, now: () => number = () => performance.now()) {
    this.resolve = resolve
    this.now = now
  }

  get size(): number {
    return this.known.size
  }

  clear(): void {
    this.known.clear()
  }

  /** Which of `paths` are files of the session: the file's path relative to its working directory, or null. */
  async check(sessionId: string, paths: readonly string[]): Promise<(string | null)[]> {
    const t = this.now()
    const key = (p: string) => `${sessionId}\n${p}`
    const unknown = [...new Set(paths.filter((p) => !this.fresh(key(p), t)))]
    if (unknown.length > 0) {
      const answers = await this.resolve(sessionId, unknown)
      unknown.forEach((p, i) => this.remember(key(p), answers[i] ?? null, t))
    }
    return paths.map((p) => this.known.get(key(p))?.file ?? null)
  }

  private fresh(key: string, t: number): boolean {
    const e = this.known.get(key)
    if (!e) return false
    if (t - e.at >= L.terminalLinkCacheMs) {
      this.known.delete(key)
      return false
    }
    // most recently used last
    this.known.delete(key)
    this.known.set(key, e)
    return true
  }

  private remember(key: string, file: string | null, at: number): void {
    this.known.delete(key)
    this.known.set(key, { file, at })
    while (this.known.size > L.terminalLinkCacheMax) this.known.delete(this.known.keys().next().value as string)
  }
}

export interface FileLink extends FileRef {
  /** The file, relative to the session's working directory. */
  file: string
}

/** The references of `text` that are files of the session (verified to exist), left to right. */
export async function fileLinks(text: string, sessionId: string, checks: LinkChecks): Promise<FileLink[]> {
  const refs = detectFileRefs(text)
  if (refs.length === 0) return []
  const files = await checks.check(sessionId, refs.map((r) => r.path))
  return refs.flatMap((r, i) => {
    const file = files[i]
    return file ? [{ ...r, file }] : []
  })
}

/** A `file:` target (an OSC 8 link's): it opens only as a file of the session, in the editor. */
export function isFileUrl(target: string): boolean {
  return FILE_URL.test(target) && !CONTROL.test(target)
}
