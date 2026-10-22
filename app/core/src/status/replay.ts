// Replaying status-report fixtures (U-ST-7): every `fixtures/status/<id>/` that holds a `fixture.json`
// (made by `pnpm fixture:from-report` from a report bundle) is a signal sequence and the person's expected state. The
// replay runs it through the same session machine the engine runs (machine.ts) and names the state it ends in.
// Folders without a `fixture.json` (recorded status files, `fixtures/status/claude/`) are not report fixtures.

import fs from 'node:fs'
import path from 'node:path'
import { expectedStateOf, zSignalJson, zStatusFixture, type ExpectedState, type StatusFixture } from '@kea/protocol'
import { signalFromJson, stateFromJson } from './codec.ts'
import { SessionMachine } from './machine.ts'
import type { StatusState } from './table.ts'

export interface LoadedFixture {
  dir: string
  fixture: StatusFixture
  signals: ReturnType<typeof signalFromJson>[]
}

/** Every report fixture under `root` (one folder each), sorted by folder name. */
export function loadFixtures(root: string): LoadedFixture[] {
  let names: string[]
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const out: LoadedFixture[] = []
  for (const n of names.sort()) {
    const dir = path.join(root, n)
    if (!fs.existsSync(path.join(dir, 'fixture.json'))) continue
    out.push(loadFixture(dir))
  }
  return out
}

export function loadFixture(dir: string): LoadedFixture {
  const fixture = zStatusFixture.parse(JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8')))
  const text = fs.existsSync(path.join(dir, 'signals.ndjson')) ? fs.readFileSync(path.join(dir, 'signals.ndjson'), 'utf8') : ''
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const signals = lines.map((l) => zSignalJson.parse(JSON.parse(l))).sort((a, b) => a.seq - b.seq).map(signalFromJson)
  return { dir, fixture, signals }
}

/** Run a fixture's signals, in the order they arrived, from its start; the state it ends in and the picker's word for it. */
export function replay(f: Pick<LoadedFixture, 'fixture' | 'signals'>): { state: StatusState; expected: ExpectedState } {
  const st = f.fixture.start
  const m = new SessionMachine({ start: stateFromJson(st.base), startMono: st.baseMono === null ? null : BigInt(st.baseMono), prompt: st.prompt, noTurns: st.noTurns })
  for (const s of f.signals) m.apply(s, false)
  return { state: m.state, expected: expectedStateOf({ lifecycle: 'live', phase: m.state.phase }) }
}
