// The zoo programs' shared command-line handling: flags, `--help`, and exit codes (0 ok, 1 runtime failure, 2 usage).

export class UsageError extends Error {}

export type FlagKind = 'value' | 'bool' | 'list'

export interface Parsed {
  values: Map<string, string>
  bools: Set<string>
  lists: Map<string, string[]>
}

/** Parse `--flag value`, `--flag=value`, boolean `--flag` and repeatable list flags. No positionals. */
export function parseFlags(argv: readonly string[], spec: Readonly<Record<string, FlagKind>>): Parsed {
  const out: Parsed = { values: new Map(), bools: new Set(), lists: new Map() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    const flag = eq > 0 ? a.slice(0, eq) : a
    const kind = spec[flag]
    if (kind === undefined) throw new UsageError(a.startsWith('-') ? `unknown option ${flag}` : `unexpected argument "${a}"`)
    if (kind === 'bool') {
      if (eq > 0) throw new UsageError(`${flag} takes no value`)
      out.bools.add(flag)
      continue
    }
    let v: string | undefined
    if (eq > 0) v = a.slice(eq + 1)
    else v = argv[++i]
    if (v === undefined) throw new UsageError(`${flag} needs a value`)
    if (kind === 'value') out.values.set(flag, v)
    else out.lists.set(flag, [...(out.lists.get(flag) ?? []), v])
  }
  return out
}

/** An integer flag in [min, max]. */
export function intFlag(p: Parsed, flag: string, dflt: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = p.values.get(flag)
  if (v === undefined) return dflt
  const n = Number(v)
  if (!/^-?\d+$/.test(v.trim()) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new UsageError(`${flag} must be an integer ${min}…${max === Number.MAX_SAFE_INTEGER ? '' : max}, got "${v}"`)
  }
  return n
}

/** A non-negative number flag (rates). */
export function numFlag(p: Parsed, flag: string, dflt: number): number {
  const v = p.values.get(flag)
  if (v === undefined) return dflt
  const n = Number(v)
  if (v.trim() === '' || !Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a number ≥ 0, got "${v}"`)
  return n
}

/** `\n`, `\r`, `\t`, `\e`, `\a`, `\xHH`, `\\` in a command-line string. */
export function unescape(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (m, c: string) => {
    if (c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16))
    switch (c) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case 'e':
        return '\x1b'
      case 'a':
        return '\x07'
      case '\\':
        return '\\'
      default:
        return m
    }
  })
}

/**
 * Run a program's main: `--help`/`-h` prints the usage; a UsageError prints its message and exits 2; any other error
 * exits 1. `main` sets `process.exitCode` itself (or lets the event loop end).
 */
export function runMain(usage: string, argv: readonly string[], main: (argv: readonly string[]) => void | Promise<void>): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage)
    return
  }
  const fail = (e: unknown) => {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n(see --help)\n`)
      process.exit(2)
    }
    process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`)
    process.exit(1)
  }
  try {
    const r = main(argv)
    if (r) r.catch(fail)
  } catch (e) {
    fail(e)
  }
}
