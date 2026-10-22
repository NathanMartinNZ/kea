// Desktop entries (freedesktop's Desktop Entry Specification 1.5), as far as finding an app on Linux needs them: the
// `[Desktop Entry]` group's `Type`, `Hidden`, `TryExec` and `Exec`, and the program `Exec` runs. Pure, so it is tested
// on every system against recorded entries (`fixtures/os/linux/desktop/`). Nothing here runs it: an entry only says
// where an app is installed (commands.ts).

/** What a desktop entry says of the app it starts. */
export interface DesktopEntry {
  /** `Exec` as argv, field codes removed (`%f`, `%U`, …), `%%` read as `%`; null when it has none or cannot be read. */
  exec: string[] | null
  /** `TryExec`: a file that must be there for the entry to count, or null. */
  tryExec: string | null
  /** `Hidden=true`: the entry was deleted (spec: "as if it did not exist"). */
  hidden: boolean
  /** `Type=Application`. */
  application: boolean
}

/** A value of the string type: `\s`, `\n`, `\t`, `\r` and `\\` (the spec's escapes); any other `\x` is kept as it is. */
function unescapeValue(v: string): string {
  return v.replace(/\\([sntr\\])/g, (_m, c: string) => (c === 's' ? ' ' : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : '\\'))
}

/** Every field code but `%%`, which reads as `%`. */
const FIELD_CODE = /%([fFuUdDnNickvm%])/g

/**
 * `Exec`'s value as argv (after the string escapes): arguments are separated by spaces; an argument in double quotes
 * keeps its spaces, and inside it `\"`, `` \` ``, `\$` and `\\` stand for the character; a field code standing alone is
 * dropped, one inside an argument is removed from it. Null for a value the spec does not allow (an unclosed quote).
 */
export function parseExec(value: string): string[] | null {
  const args: string[] = []
  let cur = ''
  let inArg = false
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string
    if (quoted) {
      if (c === '\\' && i + 1 < value.length && '"`$\\'.includes(value[i + 1] as string)) {
        cur += value[++i]
      } else if (c === '"') {
        quoted = false
      } else cur += c
      continue
    }
    if (c === ' ' || c === '\t') {
      if (inArg) args.push(cur)
      cur = ''
      inArg = false
      continue
    }
    inArg = true
    if (c === '"') quoted = true
    else cur += c
  }
  if (quoted) return null
  if (inArg) args.push(cur)
  const out: string[] = []
  for (const a of args) {
    if (/^%[fFuUdDnNickvm]$/.test(a)) continue
    out.push(a.replace(FIELD_CODE, (_m, c: string) => (c === '%' ? '%' : '')))
  }
  return out.length ? out : null
}

/** The `[Desktop Entry]` group of a desktop file's text; keys with a locale (`Name[de]`) are ignored. */
export function parseDesktopEntry(text: string): DesktopEntry {
  const keys = new Map<string, string>() // bounded: the keys of one entry's text
  let inMain = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('[')) {
      inMain = line.trim() === '[Desktop Entry]'
      continue
    }
    if (!inMain || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (key.includes('[') || keys.has(key)) continue
    keys.set(key, unescapeValue(line.slice(eq + 1).trim()))
  }
  const exec = keys.get('Exec')
  return {
    exec: exec === undefined ? null : parseExec(exec),
    tryExec: keys.get('TryExec') || null,
    hidden: keys.get('Hidden') === 'true',
    application: keys.get('Type') === 'Application',
  }
}

/**
 * The program an `Exec` argv starts: its first argument, or for `env [NAME=value…] program …` (snap's entries) the
 * program after the assignments. Null when there is none.
 */
export function execProgram(argv: readonly string[]): string | null {
  let i = 0
  const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
  if (argv[0] !== undefined && base(argv[0]) === 'env') {
    i = 1
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] as string)) i++
  }
  return argv[i] ?? null
}
