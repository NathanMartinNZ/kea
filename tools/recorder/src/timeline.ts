// The tier-3 timeline fixture, for Kea's terminal heuristics (status read from output timing, bells and notifications;
// K-FX-6): from the hook recordings of a Claude version (`fixtures/hooks/claude/<version>/.raw/s2/<case>/`, gitignored:
// drive.json, hooks.jsonl, pty.events.jsonl, pty.raw), one content-free timeline per case, on the recording's own clock
// (ms since the driver's t0):
//
//   prompted   the agent was started with an argv prompt (it counts as the first keystroke)
//   reads      every PTY read: [time, bytes]
//   keys       the driver's keystrokes
//   bells      BEL bytes outside escape sequences, at the time of the read that carried them
//   notifies   OSC 9 (not ConEmu's `9;<n>;…` commands) and OSC 777 `notify` sequences, by time only
//   hooks      [hook event name, time]
//
// No terminal bytes, paths, prompts or payload text: only what tier 3 and its tier-1 comparison read. The output goes
// to `.raw/tier3-timeline.json` next to the recordings; `pnpm fixtures:scrub --only hooks/claude/<version>/.raw/tier3-timeline.json`
// then writes the committed copy, `fixtures/hooks/claude/<version>/tier3-timeline.json`.
//
//   node tools/recorder/src/timeline.ts <version> [<fixtures root>]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface TimelineCase {
  name: string
  prompted: boolean
  reads: [number, number][]
  keys: number[]
  bells: number[]
  notifies: number[]
  hooks: [string, number][]
}

export interface Timeline {
  version: 1
  cli: string
  note: string
  cases: TimelineCase[]
}

const FILES = ['drive.json', 'hooks.jsonl', 'pty.events.jsonl', 'pty.raw'] as const

/** Times at 0.1 ms: finer than any rule tier 3 has, coarse enough to carry nothing else. */
const t = (ms: number) => Math.round(ms * 10) / 10

function lines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** Bells and OSC 9 / 777 notifications in the raw bytes, at the time of the read that carried them. */
export function terminalSignals(raw: Uint8Array, reads: readonly { size: number; at: number }[]): { bells: number[]; notifies: number[] } {
  const at: number[] = new Array<number>(raw.length)
  let off = 0
  for (const r of reads) for (let i = 0; i < r.size && off < raw.length; i++) at[off++] = r.at
  const bells: number[] = []
  const notifies: number[] = []
  let osc: number[] | null = null
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!
    if (osc) {
      const st = b === 0x1b && raw[i + 1] === 0x5c
      if (b === 0x07 || st) {
        const text = Buffer.from(osc).toString('utf8')
        if ((/^9;/.test(text) && !/^9;\d+(;|$)/.test(text)) || /^777;notify;/.test(text)) notifies.push(at[i]!)
        osc = null
        if (st) i++
      } else osc.push(b)
    } else if (b === 0x1b && raw[i + 1] === 0x5d) {
      osc = []
      i++
    } else if (b === 0x07) bells.push(at[i]!)
  }
  return { bells, notifies }
}

/** One recorded case directory → its timeline, or null when a file is missing. */
export function caseTimeline(dir: string): TimelineCase | null {
  if (!FILES.every((f) => fs.existsSync(path.join(dir, f)))) return null
  const drive = JSON.parse(fs.readFileSync(path.join(dir, 'drive.json'), 'utf8')) as { args?: string[]; res: { t0: unknown; steps?: { step: Record<string, unknown>; end?: unknown }[] } }
  const t0 = Number(drive.res.t0)
  const ms = (v: unknown) => (Number(v) - t0) / 1e6
  const reads = lines(path.join(dir, 'pty.events.jsonl'))
    .filter((e) => typeof e.read === 'number')
    .map((e) => ({ size: e.read as number, at: ms(e.mono) }))
  const { bells, notifies } = terminalSignals(fs.readFileSync(path.join(dir, 'pty.raw')), reads)
  return {
    name: path.basename(dir),
    prompted: (drive.args ?? []).includes('--'),
    reads: reads.map((r) => [t(r.at), r.size]),
    keys: (drive.res.steps ?? []).filter((s) => typeof s.step.send === 'string').map((s) => t(ms(s.end))),
    bells: bells.map(t),
    notifies: notifies.map(t),
    hooks: lines(path.join(dir, 'hooks.jsonl')).map((h) => [String(h.event), t(ms(h.ts))]),
  }
}

/** Every complete case under `<fixtures>/hooks/claude/<version>/.raw/s2/`, by name. */
export function deriveTimeline(fixtures: string, version: string): Timeline {
  const s2 = path.join(fixtures, 'hooks', 'claude', version, '.raw', 's2')
  const cases = fs
    .readdirSync(s2)
    .sort()
    .map((name) => path.join(s2, name))
    .filter((d) => fs.statSync(d).isDirectory())
    .map(caseTimeline)
    .filter((c): c is TimelineCase => c !== null)
  return {
    version: 1,
    cli: version,
    note: 'Recordings reduced to timing only (tools/recorder/src/timeline.ts): ms since the driver started; reads [ms, bytes]; hooks [event, ms]',
    cases,
  }
}

/** One case per line: small diffs when a recording is added. */
export function renderTimeline(tl: Timeline): string {
  const head = JSON.stringify({ ...tl, cases: [] }, null, 2).replace(/"cases": \[\]\n\}$/, '"cases": [\n')
  return `${head}${tl.cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: node tools/recorder/src/timeline.ts <claude version> [<fixtures root>]')
    process.exit(2)
  }
  const fixtures = path.resolve(process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures'))
  const tl = deriveTimeline(fixtures, version)
  const out = path.join(fixtures, 'hooks', 'claude', version, '.raw', 'tier3-timeline.json')
  fs.writeFileSync(out, renderTimeline(tl))
  console.log(`${tl.cases.length} cases → ${path.relative(process.cwd(), out)}; next: pnpm fixtures:scrub --only hooks/claude/${version}/.raw/tier3-timeline.json`)
}
