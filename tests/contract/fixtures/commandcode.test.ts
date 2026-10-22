// Command Code's recorded sessions and transcripts against the adapter.
//
// fixtures/hooks/commandcode/<version>/ was recorded on the real CLI in tools/recorder's world (a sandbox with no
// network, the mock model as its provider, a repo-factory repo), started with the adapter's own argv:
//   mod-events.<name>.jsonl   every mod-API event and session hook call the CLI made, with its time (a second, recording
//                             mod loaded beside Kea's; the conversation in `run_end` left out)
//   session.<name>.jsonl      what Kea received in that run: the payloads the kea-mod.ts of that day sent through
//                             kea-helper
//   session.<name>.events.json  the golden: the AgentEvents today's adapter makes of them
// `named` is a launch without Kea's mod (the conversation named instead): its mod events only.
//
// These files are recordings and stay as recorded: nothing in them is written by hand. When kea-mod.ts changes what it
// sends for the same CLI events, the recording does not change; what today's mod sends more than the recorded one did
// is named line by line in SENT_SINCE below, with the behaviour that sends it, until the next recording. A sequence
// made by hand (from reading the CLI's bundle) lives in a file named `derived.*`, which says so in its first line and
// which this test never reads (packages/adapters/src/commandcode/mapping.test.ts does: U-AGT-46).
//
// fixtures/transcripts/commandcode/<version>/<state>.{jsonl,meta.json,checkpoints.jsonl}: the session's files as they
// were at each point of that run; `reconcile.json` is the golden.
//
// A new CLI version: record it again in the recorder's world (tools/recorder/README.md, "Command Code"), scrub, then
// `KEA_UPDATE_GOLDENS=1 npx vitest run --project contract tests/contract/fixtures/commandcode` and review the diff.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { AgentEvent } from '@kea/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandcode } from '../../../packages/adapters/src/commandcode/adapter.ts'
import { FIELDS, MOD_EVENTS, MOD_HOOKS, SESSION_END, SESSION_START, TOOL_WAITING } from '../../../packages/adapters/src/commandcode/contract.ts'
import { projection } from '../../../packages/adapters/src/commandcode/launch.ts'
import { CommandCodeSignals, knownEvent } from '../../../packages/adapters/src/commandcode/mapping.ts'
import { modHarness } from '../../../packages/adapters/src/commandcode/mod-harness.ts'
import { projectPayload } from '../../../packages/adapters/src/kit/projection.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOKS = path.resolve(HERE, '../../../fixtures/hooks/commandcode')
const TRANSCRIPTS = path.resolve(HERE, '../../../fixtures/transcripts/commandcode')
const UPDATE = process.env.KEA_UPDATE_GOLDENS === '1'

type Dict = Record<string, unknown>
interface ModCall {
  ms: number
  kind: 'event' | 'hook'
  name: string
  arg: Dict
}

/**
 * What today's kea-mod.ts sends on a recording's CLI events beyond what the recorded mod sent then, as
 * `[event, tool call]` in order, per `<version>/<name>`.
 *
 * 1.79.2/main: the mod's waiting item follows the batch's prompts one after another. A refused `write_file` is
 * followed in its batch by a `git status`; the mod cannot know that this call needs no answer, so it names it as the
 * one waiting, and the run's end takes the item down 8 ms later (the batch ended with the refusal).
 */
const SENT_SINCE: Record<string, [string, string][]> = {
  '1.79.2/main': [[TOOL_WAITING, 'toolu_mock_7_2']],
}

const versions = (root: string) => (fs.existsSync(root) ? fs.readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort() : [])
const lines = <T>(file: string): T[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T)

function golden<T>(file: string, actual: T): T {
  if (UPDATE) fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
  if (!fs.existsSync(file)) throw new Error(`${path.basename(file)}: no golden; generate it with KEA_UPDATE_GOLDENS=1 and review it`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

/** The adapter's events over a recorded payload list, as core applies them (one signals object per launch). */
function eventsOf(payloads: Dict[]): AgentEvent[] {
  const s = new CommandCodeSignals(null)
  const out: AgentEvent[] = []
  for (const [i, payload] of payloads.entries()) out.push(...s.hook({ payload, monoMs: i }))
  expect(s.ignored.unknownEvent).toBe(0)
  return out
}

describe('Command Code recorded sessions and transcripts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('K-FX-2 · Command Code: each recorded session → the golden event sequence; the recorded mod events replayed through kea-mod.ts give the payloads the real run sent, in order, and beyond them only the lines named here that a later mod sends more', () => {
    const vs = versions(HOOKS)
    expect(vs.length, 'recorded versions').toBeGreaterThan(0)
    for (const v of vs) {
      const dir = path.join(HOOKS, v)
      const sessions = fs.readdirSync(dir).filter((f) => /^session\.[a-z0-9-]+\.jsonl$/.test(f))
      expect(sessions.length, `${v}: recorded sessions`).toBeGreaterThan(0)
      const seen = new Set<string>()
      for (const f of sessions) {
        const name = f.slice('session.'.length, -'.jsonl'.length)
        const payloads = lines<Dict>(path.join(dir, f))
        // what Kea received: only events the adapter knows, already as the projection leaves them
        for (const [i, p] of payloads.entries()) {
          expect(knownEvent(p), `${v}/${f}[${i}] ${String(p[FIELDS.event])}`).toBe(true)
          expect(projectPayload(p, projection()), `${v}/${f}[${i}]: the projection keeps a sent payload whole`).toEqual(p)
          seen.add(String(p[FIELDS.event]))
        }
        // the golden
        const events = eventsOf(payloads)
        expect(events, `${v}/${f}: the adapter's events`).toEqual(golden(path.join(dir, `session.${name}.events.json`), events))
        // every transcript the session named is the agent's own
        for (const e of events) if (e.t === 'session.started' && e.transcriptPath) expect(commandcode.ownsTranscript?.(e.transcriptPath, { HOME: '/tmp/kea-world/home' })).toBe(true)

        // the mod itself, on what the CLI gave it: the same payloads, in the same order, as the real run sent
        const calls = lines<ModCall>(path.join(dir, `mod-events.${name}.jsonl`))
        const transcriptOf = new Map<string, string>()
        for (const p of payloads) if (typeof p[FIELDS.transcript] === 'string' && typeof p[FIELDS.sessionId] === 'string') transcriptOf.set(p[FIELDS.sessionId] as string, p[FIELDS.transcript] as string)
        const h = modHarness()
        let at = calls[0]?.ms ?? 0
        let session: string | null = null
        for (const c of calls) {
          vi.advanceTimersByTime(Math.max(0, c.ms - at))
          at = c.ms
          if (c.kind === 'hook') {
            if (c.name === MOD_HOOKS.start) {
              session = typeof c.arg.sessionId === 'string' ? c.arg.sessionId : null
              // a resumed conversation's file is there from the start
              if (c.arg.source === 'resume' && session && transcriptOf.has(session)) h.transcripts.set(session, transcriptOf.get(session)!)
            }
            h.hook(c.name, c.arg)
            continue
          }
          // the file appears when the first model step commits: by the first turn's end
          if (c.name === 'turn_end' && session && transcriptOf.has(session)) h.transcripts.set(session, transcriptOf.get(session)!)
          h.emit(c.name, c.arg)
        }
        // … and nothing but those, save the lines a mod changed since the recording sends more (never fewer, never others)
        const more: Dict[] = []
        let next = 0
        for (const sent of h.sent) {
          if (isDeepStrictEqual(sent, payloads[next])) next++
          else more.push(sent)
        }
        expect(next, `${v}/mod-events.${name}.jsonl replayed through kea-mod.ts: every recorded payload, in order`).toBe(payloads.length)
        expect(more.map((p) => [p[FIELDS.event], p[FIELDS.toolCallId]]), `${v}/${name}: what today’s mod sends more`).toEqual(SENT_SINCE[`${v}/${name}`] ?? [])
        expect(h.timers).toBe(0)
        // what the adapter makes of those lines: an item for that call, raised and taken down, and nothing else changed
        const added = new Set(more.map((p) => p[FIELDS.toolCallId]))
        const mine = (e: AgentEvent): boolean => (e.t === 'attention.permission' || e.t === 'attention.cleared') && added.has(e.key)
        const replayed = eventsOf(h.sent)
        expect(replayed.filter((e) => !mine(e)), `${v}/${name}: the adapter’s events over what today’s mod sends`).toEqual(events)
        expect(replayed.filter(mine).map((e) => e.t)).toEqual(more.flatMap(() => ['attention.permission', 'attention.cleared']))
      }
      // the recordings exercise every row of the mapping but the ones nothing in them could cause
      const never = new Set(['tool_hook_blocked', 'compaction_start', 'compaction_done'])
      expect([...MOD_EVENTS, SESSION_START, SESSION_END, TOOL_WAITING].filter((e) => e !== 'tool_queued' && !seen.has(e) && !never.has(e)), `${v}: mapped events no recording has`).toEqual([])

      // a launch without Kea's mod: the conversation is named, and that name is never taken for its title
      const named = path.join(dir, 'mod-events.named.jsonl')
      if (fs.existsSync(named)) {
        const h = modHarness()
        for (const c of lines<ModCall>(named)) (c.kind === 'hook' ? h.hook : h.emit)(c.name, c.arg)
        expect(h.events.filter((e) => e.t === 'meta' && e.title !== undefined)).toEqual([])
        expect(h.events.map((e) => e.t)).toEqual(['session.started', 'turn.started', 'meta', 'turn.finished', 'session.ended'])
      }
    }
  })

  it('K-FX-3 · Command Code: each recorded transcript state → the golden reconcile result (an answer or a refusal is finished; a prompt sent since, an interrupt and a failure leave the stored status; the title from the meta file, never Kea’s own name)', async () => {
    vi.useRealTimers()
    const vs = versions(TRANSCRIPTS)
    expect(vs.length, 'recorded versions').toBeGreaterThan(0)
    for (const v of vs) {
      const dir = path.join(TRANSCRIPTS, v)
      const states = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.checkpoints.jsonl'))
        .map((f) => f.slice(0, -'.jsonl'.length))
        .sort()
      const actual: Record<string, unknown> = {}
      for (const s of states) actual[s] = await commandcode.reconcile({ keaSessionId: '01JXKEASESSION0000000000AA', agentSessionId: null, transcriptPath: path.join(dir, `${s}.jsonl`), cwd: '/private/tmp/kea-fixture-xxxxxx/demo', launch: { prompt: '' } })
      expect(actual, `${v}: reconcile results`).toEqual(golden(path.join(dir, 'reconcile.json'), actual))
      // what the goldens must say, whatever else they hold (a wrong golden cannot be approved by accident)
      const r = actual as Record<string, { phase: string | null; title?: { title: string; source: string }; model?: string }>
      expect(r.answered).toMatchObject({ phase: 'finished', title: { title: 'ok', source: 'agent' }, model: 'mock/mock-model' })
      expect(r.allowed?.phase).toBe('finished')
      expect(r.denied?.phase).toBe('finished')
      expect(r.cleared?.phase).toBe('finished')
      // the prompt is sent and Command Code is asking: the transcript still ends with the last answer
      expect(r.asking?.phase).toBeNull()
      expect(r.interrupted?.phase).toBeNull()
      expect(r.failed?.phase).toBeNull()
      expect(r.named).toMatchObject({ phase: 'finished' })
      expect(r.named?.title).toBeUndefined()
    }
    // no transcript known, a file that is gone: nothing, and no throw
    expect(await commandcode.reconcile({ keaSessionId: 'x', agentSessionId: null, transcriptPath: null, cwd: '/', launch: { prompt: '' } })).toEqual({ phase: null })
    expect(await commandcode.reconcile({ keaSessionId: 'x', agentSessionId: null, transcriptPath: '/nonexistent/a.jsonl', cwd: '/', launch: { prompt: '' } })).toEqual({ phase: null })
  })
})
