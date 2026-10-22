// The recorded hook payloads against the adapter: every payload in fixtures/hooks/claude/<version>/ (one file per
// event, and the whole sessions in `session.*.jsonl`) of an event Kea injects validates against the adapter's schema
// for that event (packages/adapters/src/claude/payloads.ts), and the projection kea-helper applies (generated from
// contract.ts) keeps every field the mapping reads: each of the contract's fields present in a raw payload is present
// in the projected one, and the mapping derives the same events (by kind, in order, over each whole session) from the
// projected payloads as from the raw ones. Their texts may differ: the mapping is written for projected payloads (a
// question's text is read from the summarised `tool_input.questions`).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FIELDS } from '../../../packages/adapters/src/claude/contract.ts'
import { projection } from '../../../packages/adapters/src/claude/launch.ts'
import { ClaudeSignals } from '../../../packages/adapters/src/claude/mapping.ts'
import { payloadSchema } from '../../../packages/adapters/src/claude/payloads.ts'
import { projectPayload } from '../../../packages/adapters/src/kit/projection.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/hooks/claude')
type Payload = Record<string, unknown>

/** Each recorded payload list: a single-event file is a list of one. */
function recorded(): { name: string; payloads: Payload[] }[] {
  const out: { name: string; payloads: Payload[] }[] = []
  for (const v of fs.existsSync(ROOT) ? fs.readdirSync(ROOT).sort() : []) {
    const dir = path.join(ROOT, v)
    for (const f of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, f)
      if (f.endsWith('.json')) out.push({ name: `${v}/${f}`, payloads: [JSON.parse(fs.readFileSync(file, 'utf8')) as Payload] })
      else if (f.endsWith('.jsonl'))
        out.push({
          name: `${v}/${f}`,
          payloads: fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Payload),
        })
    }
  }
  return out
}

function get(v: unknown, dotted: string): unknown {
  for (const k of dotted.split('.')) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
    v = (v as Payload)[k]
  }
  return v
}

describe('recorded hook payloads', () => {
  it('K-FX-1 · every recorded payload of an injected event validates against the adapter’s schema for it, and the projection keeps every field the mapping reads', () => {
    const lists = recorded()
    expect(lists.length, 'recorded payloads').toBeGreaterThan(0)
    const p = projection()
    let checked = 0
    for (const { name, payloads } of lists) {
      const raw = new ClaudeSignals(String(payloads[0]![FIELDS.sessionId] ?? ''))
      const projected = new ClaudeSignals(String(payloads[0]![FIELDS.sessionId] ?? ''))
      for (const [i, payload] of payloads.entries()) {
        const event = String(payload[FIELDS.event])
        const schema = payloadSchema(event)
        if (schema) {
          const r = schema.safeParse(payload)
          expect(r.success, `${name}[${i}] ${event}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true)
          checked++
        }
        const proj = projectPayload(payload, p)
        const lost = Object.values(FIELDS).filter((f) => get(payload, f) !== undefined && get(proj, f) === undefined)
        expect(lost, `${name}[${i}] ${event}: fields the projection dropped`).toEqual([])
        const fromRaw = raw.hook({ payload, monoMs: i }).map((e) => e.t)
        const fromProjected = projected.hook({ payload: proj, monoMs: i }).map((e) => e.t)
        expect(fromProjected, `${name}[${i}] ${event}: the events from the projected payload`).toEqual(fromRaw)
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})
