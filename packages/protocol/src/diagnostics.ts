// "Copy diagnostics": what crosses for it, and the one rule its text holds to, kept here so that core (which writes
// most of the text), the window (which adds the resource report) and the tests share it:
//
//   no terminal content, ever; and no path outside `<KEA_HOME>` unless the person ticked "Include file paths".
//
// Terminal content is kept out by what the text is built from (versions, counts, ids, pids, the processes' own log
// lines), never by a filter. Paths are kept out by `scrubPaths`: `<KEA_HOME>` stands for the home, `<path>` for any
// other path. Losing a word that was no path is right here; leaving a word of one is not. How it reads a text, line by
// line (a path never runs over a line break, nor over an escaped one inside a JSON string):
//
//   - **Between quotes** (`'…'`, `"…"`, `` `…` ``, the quotes of JSON inside a JSON string, a string cut short before
//     its closing quote): what starts like a path is one to the closing quote, spaces included; so is a name it was
//     told (`names`: a branch Kea made). Any other quoted text is read as a text of its own, and between single quotes
//     or backticks it goes whole if it names a path at all.
//   - **A home, a volume or a known folder** (`~/…`, `~user/…`, `$HOME/…`, `/Users/…`, `/home/…`, `/Volumes/…`, a
//     `file:` / `smb:` / `afp:` / `nfs:` URL to one, every folder in `roots`, wherever it stands, inside another URL
//     too): where such a path ends cannot be told when it is not quoted, since its names may hold spaces. It runs to
//     the end of its line or of the quotes around it.
//   - **Any other path** (`/opt/…`, `./…`, `../…`, a URL-encoded one, `%2F…`) runs to the next white space, quote,
//     closing bracket or one of `< > | , ;`.
//   - **A word with a `/` in it** that is no URL and no number (`src/app.ts`, `kea/fix-login`, `origin/main`,
//     `text/plain`) is a path too: a relative one, or a branch. One that follows a path on the same line is taken for
//     the rest of that path (`/Applications/Some App.app/Contents/x`): everything between them goes with it.
//   - The home itself becomes `<KEA_HOME>`, and what follows it stays (`<KEA_HOME>/logs/core.log`), unless it leaves
//     the home again by `..`.
//
// What it cannot know, and leaves: outside a home, a volume and quotes, the words after the last space of a path's
// last name (`/srv/build output` → `<path> output`); a name of the person's that is not shaped like a path and that
// nothing told it (a branch without a `/` is known only between quotes); a URL that is no file's (`http://…/acme`).
import { z } from 'zod'
import { L } from './generated/limits.ts'
import { zPlatformReport } from './platform.ts'
import { zResourceReport, type ResourceReport } from './resources.ts'
import { defineApi } from './rpc.ts'

export const diagnosticsApi = defineApi({
  /**
   * Core's part of the diagnostics text: Kea and system versions, the agent CLIs found, sessions and terminals as
   * counts, the holder list, banners, and the newest warnings and errors of every process's log. `paths`: the person
   * ticked "Include file paths"; without it the text names no path outside `<KEA_HOME>`.
   */
  'diagnostics.collect': { args: z.object({ paths: z.boolean().optional() }), result: z.object({ text: z.string() }) },
  /**
   * The platform report as main assembled it last and sent it to core, for Settings › About; null until main
   * has sent one to this core.
   */
  'diagnostics.platform': { args: z.object({}), result: z.object({ report: zPlatformReport.nullable() }) },
})

/** What stands for the home folder of this Kea in a text without paths. */
export const KEA_HOME_MARK = '<KEA_HOME>'
/** What stands for any other path. */
export const PATH_MARK = '<path>'

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sticky = (source: string, flags = ''): RegExp => new RegExp(source, `y${flags}`)
/** What `re` (sticky) matches of `s` at `i`, or null. */
function at(re: RegExp, s: string, i: number): string | null {
  re.lastIndex = i
  const m = re.exec(s)
  return m ? m[0] : null
}

/** Where a path token ends: white space, a quote, a bracket that closes, or one of `< > | , ;`. */
const TOKEN = '[^\\s"\'`<>|,;)\\]}]'
/** What follows the home ends there too, and at a `:` (a list of paths; a line number). */
const HOME_TAIL = '[^\\s"\'`<>|,;:)\\]}]*'
/** A path cannot start right after one of these: it is then part of a word, a URL's `//`, or a marked path. */
const NOT_BEFORE = /[\w<>/.~-]/
/** A word can start after one of these (or at the start of the text). */
const WORD_BEFORE = /[\s"'`<>|,;:=()[\]{}\\]/

const MARK_PATH = sticky(escape(PATH_MARK))
const MARK_HOME = sticky(`${escape(KEA_HOME_MARK)}${HOME_TAIL}`)
const HOME_REST = sticky(HOME_TAIL)
const URL_TOKEN = sticky('[A-Za-z][A-Za-z0-9+.-]*://[^\\s"\'`<>]*')
const ABSOLUTE = sticky(`/(?!/)${TOKEN}+`)
const TILDE = sticky(`~[\\w.-]*/${TOKEN}*`)
const ENV_HOME = sticky(`\\$(?:HOME|\\{HOME\\})/${TOKEN}*`)
const DOTTED = sticky(`\\.{1,2}/${TOKEN}+`)
const ENCODED = sticky('(?:file%3A%2F%2F)?(?:~|%7E)?%2F[^\\s"\'`<>&#]*', 'i')
/** A word with a `/` in it: its first name holds no `:` or `=` (`key=a/b`, `host:a/b`), the others may (`a/b.ts:3:1`). */
const WORD = sticky('[^\\s"\'`<>|,;:=()\\[\\]{}/\\\\]+(?:/[^\\s"\'`<>|,;()\\[\\]{}/]+)+/?')
/** Not a path: `3/4`, `2026/10/13`. */
const NUMBER = /^[\d.]+(?:\/[\d.]+)+$/
/** A path under a home folder or a volume: its names may hold spaces. */
const SPACED = /^\/(?:Users|home|Volumes)\//
const SPACED_HERE = sticky('/(?:Users|home|Volumes)/')
/** The same anywhere in a token (`/opt/bin:/Users/…`, `-C/Users/…`, `a:~/x`). */
const SPACED_INSIDE = /\/(?:Users|home|Volumes)\/|(?:^|[:=])~[\w.-]*\/|\$HOME\b|\$\{HOME\}/
const FILE_URL = /^(file|smb|afp|nfs):\/\//i
/** In a URL that is no file's: a home folder or a volume in its path (`vscode://file/Users/…`), a URL-encoded path as a value. */
const SPACED_IN_URL = /\/(?:Users|home|Volumes)\//
const ENCODED_VALUE = /=(?:file%3A%2F%2F)?(?:~|%7E)?%2F/i

const clean = (roots: readonly string[]): string[] => [...new Set(roots.map((r) => r.replace(/\/+$/, '')).filter((r) => r.startsWith('/') && r.length > 1))].sort((a, b) => b.length - a.length)

export interface ScrubOptions {
  /** `<KEA_HOME>`, as an absolute path; several when it is known by more than one (a symlinked temp folder). */
  home: string | readonly string[]
  /** Folders outside the home that the text may name, which may hold spaces: the user's home folder, projects, worktree roots. */
  roots?: readonly string[]
  /** Names of the person's that hold no `/` and may stand between quotes: the branches Kea made for its sessions. */
  names?: readonly string[]
}

interface Rules {
  homes: ReadonlySet<string>
  /** The homes and the roots, the longest first, as one pattern; null: none was given. */
  known: RegExp | null
  names: ReadonlySet<string>
  /** `outsidePaths`: every piece taken out, as it stood. */
  found: string[] | null
  /**
   * How much reading was done, in steps: one for every position `segment` stops at, one for every backslash read while
   * looking for the quote a run of them may end in, one for every quote `closing` looks at, one for every character
   * handed on as a quoted text. A unit test bounds it (U-DIAG-11); nothing else reads it.
   */
  work: { steps: number }
}

function rules(o: ScrubOptions, found: string[] | null): Rules {
  const homes = clean(typeof o.home === 'string' ? [o.home] : o.home)
  const all = clean([...homes, ...(o.roots ?? [])])
  return { homes: new Set(homes), known: all.length ? sticky(`(?:${all.map(escape).join('|')})(?![\\w.-])`) : null, names: new Set((o.names ?? []).filter((n) => n.length > 0)), found, work: { steps: 0 } }
}

/** The home at `i` of `s` and what follows it, as it is written out; null: it leaves the home again (`..`). */
function homeText(s: string, i: number, home: string): { text: string; end: number } | null {
  const tail = at(HOME_REST, s, i + home.length) ?? ''
  if (/(?:^|\/)\.\.(?:\/|$)/.test(tail)) return null
  return { text: KEA_HOME_MARK + tail, end: i + home.length + tail.length }
}

/** A known folder at one of the `/` of `s[from, to)`: where, or -1. */
function knownInside(s: string, from: number, to: number, r: Rules): number {
  if (!r.known) return -1
  for (let k = s.indexOf('/', from); k >= 0 && k < to; k = s.indexOf('/', k + 1)) if (at(r.known, s, k) !== null) return k
  return -1
}

/**
 * The home a `file:` URL's path stands in. None when a known folder inside that home holds the path (the worktrees
 * Kea makes there, named after projects and sessions): that folder's own rule takes it, as it does outside a URL.
 */
function urlHome(url: string, p: string, r: Rules): string | undefined {
  if (!/^file:/i.test(url)) return undefined
  const home = [...r.homes].find((h) => p === h || p.startsWith(`${h}/`))
  if (home === undefined) return undefined
  const known = r.known ? at(r.known, p, 0) : null
  return known !== null && !r.homes.has(known) ? undefined : home
}

/** A `file:` URL's path, as it is written in the file system. */
function urlPath(u: string): string {
  const p = u.replace(FILE_URL, '')
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

/** Where `closing` last looked for a token in one text: from where, and what it found (-1: nothing to the end). */
type Closers = Map<string, { from: number; found: number }>

/**
 * Where the string that `tok` opens at `i` closes; -1: nowhere on this line. `seen` holds what was found before in
 * this text: a text is read from left to right, so the closer found for an earlier quote of the same kind is this
 * one's too while it lies ahead, and "none to the end" holds for every later one. A line of quotes that close nowhere
 * is then looked through once, not once per quote.
 */
function closing(s: string, i: number, tok: string, r: Rules, seen: Closers): number {
  const from = i + tok.length
  const last = seen.get(tok)
  if (last && last.from <= from && (last.found === -1 || last.found >= from)) return last.found
  let found = -1
  for (let j = s.indexOf(tok, from); j >= 0; j = s.indexOf(tok, j + 1)) {
    r.work.steps++
    if (s[j - 1] === '\\') continue
    // an apostrophe inside a word closes nothing (`Dad's`)
    if (tok === "'" && /\w/.test(s[j + 1] ?? '')) continue
    found = j
    break
  }
  seen.set(tok, { from, found })
  return found
}

/**
 * One text read as the rules above say. `quoted`: it stands between quotes, so if it starts like a path all of it is
 * one. The answer is the text to write; with `r.found`, what was taken out is noted there.
 */
function segment(s: string, r: Rules, quoted: boolean, depth = 0): string {
  const took = (text: string): void => void r.found?.push(text)
  const closers: Closers = new Map() // bounded: one entry per kind of quote in this text, gone with the call
  if (quoted && startsLikePath(s, r)) {
    if (s !== PATH_MARK) took(s)
    return PATH_MARK
  }
  const out: string[] = []
  let from = 0 // where the text not yet written starts
  /** `out.length` right after the last path that ended at a boundary of its own on this level; -1: none yet. */
  let token = -1
  let tokenEnd = 0
  const write = (i: number, text: string): void => {
    if (i > from) out.push(s.slice(from, i))
    if (text) out.push(text)
  }
  /** A path whose end cannot be told: it and the rest of the text are one mark. */
  const toTheEnd = (i: number): string => {
    write(i, PATH_MARK)
    took(s.slice(i))
    return out.join('')
  }
  /** A path that ends at `end`. */
  const delimited = (i: number, end: number): number => {
    write(i, PATH_MARK)
    took(s.slice(i, end))
    token = out.length
    tokenEnd = end
    return (from = end)
  }

  let i = 0
  while (i < s.length) {
    r.work.steps++
    const c = s[i] as string
    const prev = i > 0 ? (s[i - 1] as string) : undefined
    const free = prev === undefined || !NOT_BEFORE.test(prev)

    if (c === '<') {
      const mark = at(MARK_PATH, s, i)
      if (mark !== null) {
        write(i, mark)
        token = out.length
        i = from = tokenEnd = i + mark.length
        continue
      }
      const home = at(MARK_HOME, s, i)
      if (home !== null) {
        write(i, home)
        i = from = i + home.length
        continue
      }
    }

    if (c === '"' || c === "'" || c === '`' || c === '\\') {
      // A quote, with the backslashes that escape it (the quotes of JSON inside a JSON string). A run of backslashes
      // is read once, here: when no quote ends it, it is passed over whole. Looked at again from each of its
      // backslashes, a line of them would cost its length squared.
      let q = i
      while (s[q] === '\\') q++
      r.work.steps += q - i
      const quote = s[q]
      if (quote !== '"' && quote !== "'" && quote !== '`') {
        i = q
        continue
      }
      const tok = s.slice(i, q + 1)
      const plain = tok === "'"
      let end = plain && prev !== undefined && /\w/.test(prev) ? -2 : closing(s, i, tok, r, closers)
      // a string cut short runs to the end of the line; an apostrophe that closes nowhere is one only before a path
      if (end === -1 && plain && !startsLikePath(s.slice(i + 1), r)) end = -2
      if (end === -2) {
        i += tok.length
        continue
      }
      const content = s.slice(i + tok.length, end === -1 ? s.length : end)
      const inner = quotedText(content, tok, r, depth + 1)
      write(i, tok + inner + (end === -1 ? '' : tok))
      i = from = end === -1 ? s.length : end + tok.length
      if (inner.includes(PATH_MARK)) {
        token = out.length
        tokenEnd = i
      }
      continue
    }

    if (c === '/') {
      const known = r.known ? at(r.known, s, i) : null
      if (known !== null && r.homes.has(known)) {
        const h = homeText(s, i, known)
        if (h === null) return toTheEnd(i)
        write(i, h.text)
        i = from = h.end
        continue
      }
      if (known !== null) return toTheEnd(i)
      // a home folder or a volume is one wherever it stands (`</Users/…>`)
      if (free || at(SPACED_HERE, s, i) !== null) {
        const t = at(ABSOLUTE, s, i)
        if (t !== null) {
          if (SPACED.test(t) || SPACED_INSIDE.test(t) || knownInside(s, i + 1, i + t.length, r) >= 0) return toTheEnd(i)
          i = delimited(i, i + t.length)
          continue
        }
      }
    } else if ((c === '~' && free && at(TILDE, s, i) !== null) || (c === '$' && at(ENV_HOME, s, i) !== null)) {
      return toTheEnd(i)
    } else if (c === '.' && free) {
      const t = at(DOTTED, s, i)
      if (t !== null) {
        if (SPACED_INSIDE.test(t) || knownInside(s, i, i + t.length, r) >= 0) return toTheEnd(i)
        i = delimited(i, i + t.length)
        continue
      }
    } else if ((c === '%' || c === 'f' || c === 'F' || c === '~') && (prev === undefined || !/[\w%]/.test(prev))) {
      const t = at(ENCODED, s, i)
      if (t !== null) {
        i = delimited(i, i + t.length)
        continue
      }
    }

    if (prev === undefined || WORD_BEFORE.test(prev)) {
      const url = at(URL_TOKEN, s, i)
      if (url !== null) {
        const end = i + url.length
        if (FILE_URL.test(url)) {
          const p = urlPath(url)
          const home = urlHome(url, p, r)
          const h = home === undefined ? null : homeText(p, 0, home)
          if (h !== null && h.end === p.length) {
            write(i, h.text)
            i = from = end
            continue
          }
          // a URL to a file names its folders as the file system does: spaces and all
          if (h !== null || !/^file:/i.test(url) || SPACED.test(p) || SPACED_INSIDE.test(p) || knownInside(p, 0, p.length, r) >= 0) return toTheEnd(i)
          i = delimited(i, end)
          continue
        }
        // any other URL stays, but for a known folder, a home folder or a volume, or a URL-encoded path in it
        const k = knownInside(s, i, end, r)
        const g = url.search(SPACED_IN_URL)
        const spaced = k >= 0 && (g < 0 || k <= i + g) ? k : g < 0 ? -1 : i + g
        const enc = url.search(ENCODED_VALUE)
        if (enc >= 0 && (spaced < 0 || i + enc < spaced)) {
          // what follows it in the URL (`&line=3`) is read on as text
          const start = i + enc + 1
          i = delimited(start, start + (at(ENCODED, s, start) as string).length)
          continue
        }
        if (spaced < 0) i = end
        // the known folder's own rule takes it from there (the home stays, as `<KEA_HOME>`)
        else if (spaced === k) i = k
        else return toTheEnd(spaced)
        continue
      }
      const w = at(WORD, s, i)
      if (w !== null) {
        const end = i + w.length
        if (NUMBER.test(w)) {
          i = end
          continue
        }
        const k = knownInside(s, i, end, r)
        if (k >= 0) {
          i = k
          continue
        }
        if (SPACED_INSIDE.test(w)) return toTheEnd(i)
        if (token >= 0) {
          // the rest of the path before it: everything between them goes with it
          out.length = token
          took(s.slice(tokenEnd, end))
          i = from = tokenEnd = end
          continue
        }
        i = delimited(i, end)
        continue
      }
    }
    i++
  }
  write(s.length, '')
  return out.join('')
}

/**
 * Whether a text between quotes starts like a path outside the home: all of it is then one (an apostrophe with no
 * closing one is a quote only before such a text).
 */
function startsLikePath(s: string, r: Rules): boolean {
  const c = s[0]
  if (c === undefined) return false
  if (s.startsWith(PATH_MARK)) return true
  if (c === '/') {
    const known = r.known ? at(r.known, s, 0) : null
    if (known !== null) return !r.homes.has(known) || homeText(s, 0, known) === null
    return at(ABSOLUTE, s, 0) !== null
  }
  if (at(TILDE, s, 0) !== null || at(ENV_HOME, s, 0) !== null || at(DOTTED, s, 0) !== null || at(ENCODED, s, 0) !== null) return true
  const url = at(URL_TOKEN, s, 0)
  if (url !== null) {
    if (!FILE_URL.test(url)) return false
    const p = urlPath(url)
    const home = urlHome(url, p, r)
    return home === undefined || homeText(p, 0, home)?.end !== p.length
  }
  const w = at(WORD, s, 0)
  return w !== null && !NUMBER.test(w)
}

// a JSON string's line breaks, by how deep its quotes are escaped: `\n` between `"`, `\\n` between `\"`
const breaks = (depth: number): RegExp => new RegExp(`((?<!\\\\)\\\\{${depth}}[nr])`)
const BREAKS = [breaks(1), breaks(2)]

/**
 * What stands between two `tok`, `depth` quotes deep (1: the quotes of the line itself). Deeper than
 * L.diagnosticsScrubQuoteDepthMax it is not read: it goes whole, so that quotes inside quotes inside quotes cost a
 * bounded number of readings of the same characters.
 */
function quotedText(content: string, tok: string, r: Rules, depth: number): string {
  if (content === '') return content
  if (depth > L.diagnosticsScrubQuoteDepthMax) {
    if (content !== PATH_MARK) r.found?.push(content)
    return PATH_MARK
  }
  r.work.steps += content.length
  if (r.names.has(content)) {
    r.found?.push(content)
    return PATH_MARK
  }
  if (tok.endsWith('"')) {
    // each line of a JSON string by itself
    return content
      .split(BREAKS[tok.length - 1] ?? breaks(tok.length))
      .map((part, n) => (n % 2 ? part : segment(part, r, true, depth)))
      .join('')
  }
  const inner = segment(content, r, true, depth)
  if (inner !== PATH_MARK && inner.includes(PATH_MARK)) {
    r.found?.push(content)
    return PATH_MARK
  }
  return inner
}

function pass(text: string, r: Rules): string {
  return text
    .split('\n')
    .map((line) => segment(line, r, false))
    .join('\n')
}

/**
 * The scrub for one set of folders, to be applied to many texts (the folders are made into one pattern, once):
 * `text` with every path outside the home replaced by `<path>` and the home itself by `<KEA_HOME>` (what follows it
 * stays: `<KEA_HOME>/logs/core.log`). Applying it again changes nothing: it reads each line until a reading changes
 * nothing (`settled`). A second reading finds something only where the first took a closing quote away with a path.
 *
 * Its work grows with the length of the text and no faster, whatever the text is made of (U-DIAG-11): a line is read
 * at most L.diagnosticsScrubReadingsMax times, a quoted text at most L.diagnosticsScrubQuoteDepthMax quotes deep, and
 * where a quote closes is looked for once per kind of quote in a text (`closing`), not once per quote. So it needs no
 * caller to cut its text first.
 */
export function scrubber(o: ScrubOptions): (text: string) => string {
  const r = rules(o, null)
  return (text) => scrub(text, r)
}

/**
 * One line read until a reading changes nothing. Two readings as a rule (the second finds nothing), three or four
 * where a path took a closing quote with it; never more than L.diagnosticsScrubReadingsMax: a line that still changes
 * then keeps no word.
 */
function settled(line: string, r: Rules): string {
  let out = segment(line, r, false)
  for (let n = 1; n < L.diagnosticsScrubReadingsMax; n++) {
    const again = segment(out, r, false)
    if (again === out) return out
    out = again
  }
  return PATH_MARK
}

function scrub(text: string, r: Rules): string {
  return text
    .split('\n')
    .map((line) => settled(line, r))
    .join('\n')
}

/** `scrubber(o)` applied to one text. */
export function scrubPaths(text: string, o: ScrubOptions): string {
  return scrubber(o)(text)
}

/** `scrubPaths`, and how much reading it took (`Rules.work`): the tests' bound on the scrub's work, U-DIAG-11. */
export function scrubWork(text: string, o: ScrubOptions): { text: string; steps: number } {
  const r = rules(o, null)
  return { text: scrub(text, r), steps: r.work.steps }
}

/**
 * What a text still names that `scrubPaths` would take out, read by the same rules with no folder named to them:
 * none after it (the tests' check on the scrubbed text).
 */
export function outsidePaths(text: string): string[] {
  const found: string[] = []
  pass(text, rules({ home: [] }, found))
  return found
}

// ── the resource report's part of the text ─────────────────────────────────────────────────────────

/** Main's answer to the window's question (`kea:resourceReports`): every process's report as main collects them, and its newest footprint sample. */
export interface CollectedResources {
  reports: Record<string, ResourceReport>
  /** The processes with no report, and why (`not running`, `no answer`, `no window`). */
  missing: Record<string, string>
  /** `t`: when it was sampled (ISO); bytes of physical footprint per process. Null: none yet. */
  footprint: { t: string; bytes: Record<string, number>; errors?: Record<string, string> } | null
}

/** The window checks what main sent before it becomes text. */
export const zCollectedResources = z.object({
  reports: z.record(z.string(), zResourceReport),
  missing: z.record(z.string(), z.string()),
  footprint: z.object({ t: z.string(), bytes: z.record(z.string(), z.number()), errors: z.record(z.string(), z.string()).optional() }).nullable(),
})

/** `v` as main's answer, or null when it is not one. */
export function asCollectedResources(v: unknown): CollectedResources | null {
  const r = zCollectedResources.safeParse(v)
  if (!r.success) return null
  const f = r.data.footprint
  return { reports: r.data.reports, missing: r.data.missing, footprint: f ? { t: f.t, bytes: f.bytes, ...(f.errors ? { errors: f.errors } : {}) } : null }
}

const MIB = 1024 * 1024
const count = (v: number): string => (Number.isNaN(v) ? 'unreadable' : String(v))

/** One report's rows, one line each: `  core.db  statements=12 walBytes=0`. A gauge that threw reads `unreadable`. */
export function reportLines(report: ResourceReport): string[] {
  return Object.keys(report)
    .sort()
    .map((row) => {
      const v = report[row] as number | Record<string, number>
      const value =
        typeof v === 'number'
          ? count(v)
          : Object.keys(v)
              .map((k) => `${k}=${count(v[k] as number)}`)
              .join(' ')
      return `  ${row}  ${value}`
    })
}

/** The "Resources" section: each process's footprint and its report, and the processes that gave none. Names and numbers only. */
export function resourcesSection(r: CollectedResources | null): string[] {
  const out = ['## Resources']
  if (!r) return [...out, 'main did not answer: no report but the window’s own.']
  if (r.footprint) {
    const mb = Object.keys(r.footprint.bytes).map((p) => `${p} ${Math.round((r.footprint!.bytes[p] as number) / MIB)} MiB`)
    out.push(`footprint at ${r.footprint.t}: ${mb.join(' · ') || 'none read'}`)
    for (const [p, why] of Object.entries(r.footprint.errors ?? {})) out.push(`footprint of ${p} not read: ${why}`)
  } else out.push('footprint: not sampled yet')
  for (const [p, why] of Object.entries(r.missing)) out.push(`${p}: no report (${why})`)
  for (const p of Object.keys(r.reports)) out.push(`${p}:`, ...reportLines(r.reports[p] as ResourceReport))
  return out
}
