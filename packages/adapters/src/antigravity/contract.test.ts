import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAILURE_KIND } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import {
  AGENT_STATES,
  COMMAND,
  COMMANDS,
  CRITICAL_AGENT_STATES,
  FEED_FIELDS,
  FLAGS,
  KNOWN_AGENT_STATES,
  PROJECTION_KEEP,
  PROJECTION_QUOTA_FIELDS,
  PROJECTION_SUMMARISE,
  SUBAGENT_RUNNING,
} from './contract.ts'
import { antigravityProjection } from './launch.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..')

/** The string literals of a TS source ('…', "…", `…` without interpolation), comments removed first. */
function literals(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const out: string[] = []
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** Kea's own flags (`kea-helper`'s CLI) and protocol enum values that happen to be snake_case. */
const KEA_FLAGS = new Set(['--session', '--home', '--project'])
const KEA_ENUMS = new Set<string>(FAILURE_KIND)

/** Strings that look agent-specific: CLI flags, env vars, snake_case payload fields, dotted payload paths. */
function agentLike(s: string): boolean {
  if (/^--[a-z][a-z0-9-]+$/.test(s)) return !KEA_FLAGS.has(s)
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s) && s.length >= 6) return !s.startsWith('KEA_')
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(s)) return !KEA_ENUMS.has(s)
  if (/^[a-z_]+(?:\.[a-z_]+)+$/.test(s) && s.includes('_')) return true
  return false
}

describe('antigravity contract', () => {
  it('U-AGT-12 · Antigravity CLI: every flag, env var and payload field the adapter uses is declared in contract.ts; the feed projection is generated from it', () => {
    const offenders: string[] = []
    for (const f of fs.readdirSync(HERE)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'contract.ts') continue
      for (const s of literals(fs.readFileSync(path.join(HERE, f), 'utf8'))) {
        if (agentLike(s)) offenders.push(`${path.relative(SRC, path.join(HERE, f))}: ${s}`)
      }
    }
    expect(offenders).toEqual([])
    expect(literals("const a = ['--conversation', 'ANTIGRAVITY_X', 'agent_state', 'context_window.used_percentage', '--home']").filter(agentLike)).toEqual([
      '--conversation',
      'ANTIGRAVITY_X',
      'agent_state',
      'context_window.used_percentage',
    ])
    expect(Object.values(FLAGS).every((f) => f.startsWith('--'))).toBe(true)
    expect(COMMANDS[0]).toBe(COMMAND)

    const p = antigravityProjection()
    expect(p.keep).toEqual(PROJECTION_KEEP.map((k) => FEED_FIELDS[k]))
    expect(p.count).toEqual([])
    expect(p.countWhere).toEqual([{ path: FEED_FIELDS.subagents, field: FEED_FIELDS.subagentStatus, equals: SUBAGENT_RUNNING }])
    expect(p.keepMap?.[0]?.path).toBe(FEED_FIELDS.quota)
    expect(p.keepMap?.[0]?.fields).toEqual(PROJECTION_QUOTA_FIELDS.map((k) => FEED_FIELDS[k]))
    expect(p.summarise).toEqual(PROJECTION_SUMMARISE.map((k) => FEED_FIELDS[k]))
    expect(p.critical).toEqual([
      { field: FEED_FIELDS.agentState, values: [...CRITICAL_AGENT_STATES] },
      { field: FEED_FIELDS.toolConfirmationPending, values: [true] },
    ])
    for (const s of CRITICAL_AGENT_STATES) expect(KNOWN_AGENT_STATES).toContain(s)
    expect(Object.values(AGENT_STATES).sort()).toEqual([...KNOWN_AGENT_STATES].sort())
  })
})
