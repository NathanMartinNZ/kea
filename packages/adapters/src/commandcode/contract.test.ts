import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commandcode, modSource } from './adapter.ts'
import {
  BATCH_END_EVENTS,
  COMMAND,
  COMMANDS,
  CONFIG_DIR_NAME,
  FLAGS,
  MOD_API,
  MOD_EVENTS,
  MOD_FILE,
  MOD_HOOKS,
  MOD_OPTION,
  MODEL_EVENT,
  QUEUED_EVENT,
  READ_ONLY_TOOLS,
  RUN_END_EVENTS,
  SESSION_END,
  SESSION_START,
  TOOL_EVENTS,
  TOOL_WAITING,
  TRANSCRIPT_EXT,
  TRANSCRIPT_LOOK_EVENTS,
  TRANSCRIPTS_DIR,
} from './contract.ts'
import * as mod from './kea-mod.ts'
import { modHarness } from './mod-harness.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..')

/** The string literals of a TS source ('…', "…", `…` without interpolation), comments removed first. */
function literals(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const out: string[] = []
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** Kea's own flags (kea-helper's CLI). */
const KEA_FLAGS = new Set(['--session', '--home', '--project'])

/** Strings that look agent-specific: CLI flags, env vars, snake_case payload fields, dotted payload paths. */
function agentLike(s: string): boolean {
  if (/^--[a-z][a-z0-9-]+$/.test(s)) return !KEA_FLAGS.has(s)
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s) && s.length >= 6) return !s.startsWith('KEA_')
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(s)) return true
  if (/^[a-z_]+(?:\.[a-z_]+)+$/.test(s) && s.includes('_')) return true
  return false
}

describe('commandcode contract', () => {
  it('U-AGT-12 · Command Code: every flag, env var and payload field the adapter uses is declared in contract.ts; kea-mod.ts, which must stand alone, names exactly the contract’s', () => {
    // the adapter's code (every source file of commandcode/ but the contract, the mod and tests) names none of its own
    const offenders: string[] = []
    for (const f of fs.readdirSync(HERE)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'contract.ts' || f === MOD_FILE) continue
      for (const s of literals(fs.readFileSync(path.join(HERE, f), 'utf8'))) if (agentLike(s)) offenders.push(`${path.relative(SRC, path.join(HERE, f))}: ${s}`)
    }
    expect(offenders).toEqual([])
    expect(literals("const a = ['--resume', 'COMMANDCODE_X', 'tool_queued', 'result.stop_reason', '--home']").filter(agentLike)).toEqual(['--resume', 'COMMANDCODE_X', 'tool_queued', 'result.stop_reason'])
    expect(Object.values(FLAGS).every((f) => f.startsWith('--'))).toBe(true)

    // kea-mod.ts is loaded by Command Code from a folder of Kea's, alone: it imports nothing but Node's own modules
    const src = modSource() ?? ''
    expect(src).toBe(fs.readFileSync(path.join(HERE, MOD_FILE), 'utf8'))
    const imports = [...src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const i of imports) expect(i).toMatch(/^node:/)
    expect(src).toMatch(/^export default function/m)
    // so its names are its own copies: each equals the contract's
    expect(mod.OPTION).toBe(MOD_OPTION)
    expect([...mod.FORWARDED, mod.QUEUED, mod.MODEL].sort()).toEqual([...MOD_EVENTS].sort())
    expect(mod.QUEUED).toBe(QUEUED_EVENT)
    expect(mod.MODEL).toBe(MODEL_EVENT)
    expect([...mod.TOOL_EVENTS]).toEqual([...TOOL_EVENTS])
    expect([...mod.BATCH_END]).toEqual([...BATCH_END_EVENTS])
    expect([...mod.RUN_END]).toEqual([...RUN_END_EVENTS])
    expect([...mod.LOOK_AT]).toEqual([...TRANSCRIPT_LOOK_EVENTS])
    expect(mod.MADE).toEqual({ start: SESSION_START, end: SESSION_END, waiting: TOOL_WAITING })
    expect([...mod.READ_ONLY_TOOLS]).toEqual([...READ_ONLY_TOOLS])
    expect([...mod.TRANSCRIPTS]).toEqual([CONFIG_DIR_NAME, TRANSCRIPTS_DIR])
    expect(mod.TRANSCRIPT_EXT).toBe(TRANSCRIPT_EXT)
    // and the agent strings in it are those names, the fields it reads of an event, and nothing else
    const own = new Set<string>([...MOD_EVENTS, SESSION_START, SESSION_END, TOOL_WAITING, ...READ_ONLY_TOOLS])
    expect(literals(src).filter((s) => agentLike(s) && !own.has(s))).toEqual([])
    // the mod API it calls, and the hooks it registers
    const h = modHarness()
    expect(h.hooks.sort()).toEqual(Object.values(MOD_HOOKS).sort())
    for (const m of MOD_API) expect(src).toContain(`cmd.${m}(`)

    // the adapter as registered: its names, its launch file
    expect(commandcode.id).toBe('commandcode')
    expect(commandcode.commands).toEqual(COMMANDS)
    expect(commandcode.commands[0]).toBe(COMMAND)
    expect(commandcode.launchFiles?.()).toEqual([{ name: MOD_FILE, content: src }])
    expect(commandcode.identify(['/opt/homebrew/bin/cmd', '--resume', 'x'])).toBe(true)
    expect(commandcode.identify(['/usr/local/bin/command-code'])).toBe(true)
    expect(commandcode.identify(['/opt/bin/claude'])).toBe(false)
    expect(commandcode.identify([])).toBe(false)
    // a transcript is the agent's own only under its config folder's sessions
    const env = { HOME: '/Users/x' }
    expect(commandcode.ownsTranscript?.('/Users/x/.commandcode/projects/slug/a.jsonl', env)).toBe(true)
    expect(commandcode.ownsTranscript?.('/Users/x/.commandcode/projects/../../.ssh/id.jsonl', env)).toBe(false)
    expect(commandcode.ownsTranscript?.('/Users/x/.commandcode/config.json', env)).toBe(false)
    expect(commandcode.ownsTranscript?.('/Users/y/.commandcode/projects/slug/a.jsonl', env)).toBe(false)
    expect(commandcode.ownsTranscript?.('projects/slug/a.jsonl', env)).toBe(false)
    expect(commandcode.ownsTranscript?.('/Users/x/.commandcode/projects/slug/a.jsonl', {})).toBe(false)
  })
})
