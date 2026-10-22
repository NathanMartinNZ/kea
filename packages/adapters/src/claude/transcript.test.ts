import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { contextPct, eventsOfLines, reconcile, reconcileLines, watchTranscript } from './transcript.ts'

const FX = fileURLToPath(new URL('../../../../fixtures/transcripts/claude/2.1.296/s1-main.jsonl', import.meta.url))
const recorded = fs.readFileSync(FX, 'utf8').split('\n').filter(Boolean)
// record shapes of 2.1.296 not met in the mock-model recordings (the title fields are the bundle's `aiTitle` / `customTitle`)
const AI_TITLE = JSON.stringify({ type: 'ai-title', aiTitle: 'List repository files', sessionId: 's' })
const CUSTOM_TITLE = JSON.stringify({ type: 'custom-title', customTitle: 'My own name', sessionId: 's' })
const PLAIN_INTERRUPT = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
const usage = (model: string, tokens: number) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } } })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('claude transcript', () => {
  it('U-AGT-10 · tail parsing on recorded lines: both interrupt markers by prefix, ai-title and custom-title with their sources, cost-state, usage → context % for known models only', () => {
    const ev = eventsOfLines(recorded)
    // the recorded Esc at a permission prompt: `[Request interrupted by user for tool use]`
    expect(ev.filter((e) => e.t === 'turn.interrupted')).toHaveLength(1)
    // usage of claude-opus-5-5 (a 1M window): the last assistant record's prompt size
    const ctx = ev.filter((e): e is Extract<AgentEvent, { t: 'meta' }> => e.t === 'meta' && e.contextUsedPct !== undefined)
    expect(ctx.length).toBeGreaterThan(0)
    expect(ctx.at(-1)!.contextUsedPct).toBeCloseTo(0.4, 1)
    // cost-state (2.1.296's `totalCostUSD`)
    expect(ev.filter((e) => e.t === 'meta' && e.costUsd !== undefined).at(-1)).toEqual({ t: 'meta', costUsd: 0.095796 })
    // titles, and the plain marker
    expect(eventsOfLines([AI_TITLE, CUSTOM_TITLE, PLAIN_INTERRUPT])).toEqual([
      { t: 'meta', title: 'List repository files', titleSource: 'agent' },
      { t: 'meta', title: 'My own name', titleSource: 'user' },
      { t: 'turn.interrupted' },
    ])
    // context %: known windows only, the longest prefix wins
    expect(eventsOfLines([usage('claude-opus-4-5-20251101', 100_000)])).toEqual([{ t: 'meta', contextUsedPct: 50 }])
    expect(eventsOfLines([usage('claude-opus-4-6', 100_000)])).toEqual([{ t: 'meta', contextUsedPct: 10 }])
    expect(eventsOfLines([usage('some-other-model', 100_000)])).toEqual([])
    expect(contextPct(null, 5)).toBeNull()
    // garbage and sidechain lines give nothing
    expect(eventsOfLines(['not json', '[1,2]', JSON.stringify({ type: 'ai-title', aiTitle: 'sub', isSidechain: true })])).toEqual([])
  })

  it('U-AGT-10 · reconcile: last title (custom wins), cost, context, and the status the last message implies; slash commands and compaction records are not prompts', async () => {
    // the recorded session ends after /compact: the interrupt is its last turn-level record
    expect(reconcileLines(recorded)).toMatchObject({ phase: 'interrupted', costUsd: 0.095796, model: 'claude-opus-5-5' })
    // up to the end of the first turn: finished
    const firstEnd = recorded.findIndex((l) => l.includes('"end_turn"'))
    expect(reconcileLines(recorded.slice(0, firstEnd + 1)).phase).toBe('finished')
    // a pending tool use: working
    const firstTool = recorded.findIndex((l) => l.includes('"stop_reason": "tool_use"'))
    expect(reconcileLines(recorded.slice(0, firstTool + 1)).phase).toBe('working')
    expect(reconcileLines([AI_TITLE, CUSTOM_TITLE, AI_TITLE]).title).toEqual({ title: 'My own name', source: 'user' })
    expect(reconcileLines([AI_TITLE]).title).toEqual({ title: 'List repository files', source: 'agent' })
    expect(await reconcile({ transcriptPath: null })).toEqual({ phase: null })
    expect(await reconcile({ transcriptPath: '/nonexistent/x.jsonl' })).toEqual({ phase: null })
    expect((await reconcile({ transcriptPath: FX })).phase).toBe('interrupted')
  })

  it('U-AGT-10 · the watcher emits each appended line’s events once, from the end of the file as it was', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt10-'))
    dirs.push(dir)
    const file = path.join(dir, 't.jsonl')
    fs.writeFileSync(file, `${PLAIN_INTERRUPT}\n`)
    let poke: () => void = () => {}
    const out: AgentEvent[] = []
    const w = watchTranscript({ transcriptPath: file }, (_f, cb) => ((poke = cb), { dispose() {} }), (e) => out.push(e))
    expect(out).toEqual([]) // what was there before is reconcile's
    fs.appendFileSync(file, `${AI_TITLE}\n${PLAIN_INTERRUPT.slice(0, 20)}`)
    poke()
    expect(out).toEqual([{ t: 'meta', title: 'List repository files', titleSource: 'agent' }])
    fs.appendFileSync(file, `${PLAIN_INTERRUPT.slice(20)}\n`)
    poke()
    poke()
    expect(out).toEqual([{ t: 'meta', title: 'List repository files', titleSource: 'agent' }, { t: 'turn.interrupted' }])
    w.dispose()
  })

  it('U-AGT-19 · nothing appended is lost between watchers: disposing reads what came since the last notification (a title written just before Stop), and the next watcher, given the last position, reads what was appended while none watched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt19-'))
    dirs.push(dir)
    const file = path.join(dir, 't.jsonl')
    fs.writeFileSync(file, '')
    const out: AgentEvent[] = []
    // a watcher whose file notification has not arrived yet when the phase changes (fs.watch is asynchronous)
    const silent = () => ({ dispose() {} })
    const w1 = watchTranscript({ transcriptPath: file }, silent, (e) => out.push(e))
    fs.appendFileSync(file, `${AI_TITLE}\n`)
    w1.dispose()
    expect(out, 'the title written before Stop').toEqual([{ t: 'meta', title: 'List repository files', titleSource: 'agent' }])
    // while ready, unwatched: the agent names the conversation; the next turn's watcher starts where w1 stopped
    fs.appendFileSync(file, `${CUSTOM_TITLE}\n`)
    const w2 = watchTranscript({ transcriptPath: file }, silent, (e) => out.push(e), w1.position)
    expect(out.at(-1)).toEqual({ t: 'meta', title: 'My own name', titleSource: 'user' })
    w2.dispose()
    expect(out).toHaveLength(2)
    expect(w2.position).toBe(fs.statSync(file).size)
  })
})
