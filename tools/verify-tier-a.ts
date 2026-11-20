// Tier A as data: the tests `pnpm verify` runs before every push, per Vitest project. The unit project runs in full;
// the rest are selected by test-ID name pattern, so a test joins Tier A by carrying its ID. A pattern that finds no
// tests passes (`--passWithNoTests`).

export type TierAProject = 'integration' | 'contract' | 'chaos' | 'memory'

/** The Tier A selection. Unit tests (the U-ST-7 status-report replays included) and Rust unit tests run in full. */
export const TIER_A: Record<TierAProject, string[]> = {
  // I-PLT-*: the Linux rows (the instance lock, holders hidden by hidepid), each a named skip where it cannot run.
  // I-FT-29, I-PRJ-7: a folder made a repository outside Kea, heard through each system's own file watcher
  integration: ['I-HLD-*', 'I-PTY-1…6', 'I-PTY-13', 'I-WT-3', 'I-AGT-1/2', 'I-PLT-*', 'I-FT-29', 'I-PRJ-7'],
  // static contract K-CL-1…6 (from its cache; a miss launches nothing), K-CM-1…5 (the same); fixture contract K-FX-1…3 and the
  // fixture privacy scan K-FX-8
  contract: ['K-CL-1…6', 'K-CM-1…5', 'K-FX-1…3', 'K-FX-8'],
  // I-HLD-* tests that need the real app (I-HLD-25) live with the app-level chaos suites (tests/chaos/app-*)
  chaos: ['C-KILL-1/2/3/6/11/12', 'I-HLD-*'],
  // the leak cycles fast enough for every push. L-TERM-2, L-TERM-4 and L-FV-2 are Tier B (with them the tier took
  // 4m50s of a 5-minute gate): each rule keeps a cheaper Tier A guard (U-TERM-17/34/35, L-MEM-1, L-FV-1)
  memory: [
    'L-TERM-1',
    'L-TERM-7',
    'L-TERM-8',
    'L-FV-1',
    'L-FV-7',
    'L-FV-8',
    'L-MEM-1',
    'L-MEM-18',
    'L-MEM-2',
    'L-MEM-5',
    'L-PTY-1',
    'L-PTY-2',
    'L-MEM-9',
    'L-FT-1',
    'L-MEM-11',
    'L-MEM-13',
    'L-MEM-20',
    'L-MEM-21',
    'L-MEM-14',
    'L-HLD-2',
  ],
}

/** Unit tests named in the Tier A selection (they run anyway with the unit project). */
export const TIER_A_UNIT = ['U-ST-7']

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type ExpandedEntry = { kind: 'id'; id: string } | { kind: 'wildcard'; prefix: string }

const PREFIX_RE = '[A-Z][A-Z0-9]*(?:-[A-Z]+)*-'

/** Expand a test-ID spec (`L-TERM-1`, `I-HLD-*`, `I-PTY-1…6`, `C-KILL-1/2/3`) into concrete IDs or wildcard prefixes. */
function expandEntry(entry: string): ExpandedEntry[] {
  const s = entry.trim()
  const wild = new RegExp(`^(${PREFIX_RE})\\*$`).exec(s)
  if (wild) return [{ kind: 'wildcard', prefix: wild[1]! }]
  const range = new RegExp(`^(${PREFIX_RE})(\\d+)(?:…|\\.\\.\\.|–)(?:(${PREFIX_RE}))?(\\d+)$`).exec(s)
  if (range) {
    const prefix = range[1]!
    const from = Number(range[2])
    const to = Number(range[4])
    if ((range[3] !== undefined && range[3] !== prefix) || to < from || to - from > 500) {
      throw new Error(`verify-tier-a: cannot use "${entry}" as a test ID`)
    }
    const out: ExpandedEntry[] = []
    for (let n = from; n <= to; n++) out.push({ kind: 'id', id: `${prefix}${n}` })
    return out
  }
  const slash = new RegExp(`^(${PREFIX_RE})(\\d+[a-z]?)((?:/\\d+[a-z]?)+)$`).exec(s)
  if (slash) {
    const nums = [slash[2]!, ...slash[3]!.split('/').filter(Boolean)]
    return nums.map((n) => ({ kind: 'id', id: `${slash[1]}${n}` }))
  }
  if (new RegExp(`^${PREFIX_RE}\\d+[a-z]?$`).test(s)) return [{ kind: 'id', id: s }]
  throw new Error(`verify-tier-a: cannot use "${entry}" as a test ID`)
}

/** A Vitest `--testNamePattern` matching any listed ID at the start of a test (or after a describe prefix). */
export function namePattern(entries: string[]): string {
  const alts: string[] = []
  for (const e of entries) {
    for (const r of expandEntry(e)) {
      if (r.kind === 'id') alts.push(escape(r.id))
      else alts.push(`${escape(r.prefix)}\\d+[a-z]?`)
    }
  }
  return `(?:^|\\s)(?:${alts.join('|')})(?![\\w-])`
}

/** The concrete IDs (wildcards stay as `I-HLD-*`). */
export function tierAIds(project: TierAProject): string[] {
  return TIER_A[project].flatMap((e) => expandEntry(e).map((r) => (r.kind === 'id' ? r.id : `${r.prefix}*`)))
}
