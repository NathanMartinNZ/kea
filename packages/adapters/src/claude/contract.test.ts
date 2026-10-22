import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CRITICAL_EVENTS, FIELDS, FLAGS, HOOK_EVENTS, PROJECTION_COUNT, PROJECTION_KEEP, PROJECTION_SUMMARISE } from './contract.ts'
import { projection } from './launch.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..')

/** The string literals of a TS source ('…', "…", `…` without interpolation), comments removed first. */
function literals(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const out: string[] = []
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** Kea's own flags (kea-helper's CLI) and words that are not the agent's. */
const KEA_FLAGS = new Set(['--session', '--home', '--project'])

/** Strings that look agent-specific: CLI flags, env vars, snake_case payload fields, dotted payload paths. */
function agentLike(s: string): boolean {
  if (/^--[a-z][a-z0-9-]+$/.test(s)) return !KEA_FLAGS.has(s)
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s) && s.length >= 6) return !s.startsWith('KEA_')
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(s)) return true
  if (/^[a-z_]+(?:\.[a-z_]+)+$/.test(s) && s.includes('_')) return true
  return false
}

describe('claude contract', () => {
  it('U-AGT-12 · every flag, env var and payload field the adapter uses is declared in contract.ts; the projection is generated from it', () => {
    // the adapter's code (every source file of claude/ but the contract and tests) names none of its own
    const files = fs.readdirSync(HERE).map((f) => path.join(HERE, f))
    const offenders: string[] = []
    for (const f of files) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.endsWith('contract.ts')) continue
      for (const s of literals(fs.readFileSync(f, 'utf8'))) if (agentLike(s)) offenders.push(`${path.relative(SRC, f)}: ${s}`)
    }
    expect(offenders).toEqual([])
    // the check itself catches an undeclared flag, env var and field
    expect(literals("const a = ['--resume', 'CLAUDE_X_Y', 'tool_name', 'tool_input.command', '--home']").filter(agentLike)).toEqual(['--resume', 'CLAUDE_X_Y', 'tool_name', 'tool_input.command'])
    // the projection is the contract's lists, field for field
    const p = projection()
    expect(p.keep).toEqual(PROJECTION_KEEP.map((k) => FIELDS[k]))
    expect(p.count).toEqual(PROJECTION_COUNT.map((k) => FIELDS[k]))
    expect(p.summarise).toEqual(PROJECTION_SUMMARISE.map((k) => FIELDS[k]))
    expect(p.critical).toEqual({ field: FIELDS.event, values: [...CRITICAL_EVENTS] })
    for (const e of CRITICAL_EVENTS) expect(HOOK_EVENTS).toContain(e)
    // every field the contract declares is in the projection (nothing declared and unused)
    expect(new Set([...p.keep, ...p.count, ...p.summarise])).toEqual(new Set(Object.values(FIELDS)))
    expect(Object.values(FLAGS).every((f) => f.startsWith('--'))).toBe(true)
  })
})
