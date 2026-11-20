import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { L, type AgentEvent } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { eventsOfLines, ownsTranscript, reconcile, reconcileLines, watchRoots, watchTranscript } from './transcript.ts'

const FX_DIR = fileURLToPath(new URL('../../../../fixtures/transcripts/antigravity/1.5.13/', import.meta.url))
const fxPath = (name: string) => path.join(FX_DIR, name)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmpDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt59-')))
  dirs.push(d)
  return d
}

describe('antigravity transcript ownership, reconcile and watcher', () => {
  it('U-AGT-59 · watchRoots & ownsTranscript: accepts canonical <brainDir>/<id>/.../*.jsonl and rejects paths outside brainDir, .. traversals, relative paths, and non-.jsonl files', () => {
    const env = { HOME: '/Users/demo' }
    expect(watchRoots(env)).toEqual(['/Users/demo/.gemini/antigravity-cli'])
    expect(watchRoots({})).toEqual([])
    expect(watchRoots({ HOME: 'relative/home' })).toEqual([])

    const valid = '/Users/demo/.gemini/antigravity-cli/brain/a40a7934-365e-4afd-a57a-506cb16fa4e9/.system_generated/logs/transcript.jsonl'
    expect(ownsTranscript(valid, env)).toBe(true)

    // Rejects paths outside <brainDir>, including legacy non-cli path, sibling config files, and traversals
    for (const invalid of [
      '/Users/demo/.gemini/antigravity/brain/a40a7934/.system_generated/logs/transcript.jsonl',
      '/Users/demo/.gemini/antigravity-cli/settings.json',
      '/Users/demo/.gemini/antigravity-cli/history.jsonl',
      '/Users/demo/.gemini/antigravity-cli/brain',
      '/Users/demo/.gemini/antigravity-cli/brain-other/a40a7934/transcript.jsonl',
      '/Users/demo/.gemini/antigravity-cli/brain/a40a7934/../../../other.jsonl',
      '/Users/demo/.gemini/antigravity-cli/brain/../history.jsonl',
      '/Users/demo/.gemini/antigravity-cli/brain/a40a7934/notes.txt',
      '/Users/demo/.gemini/antigravity-cli/brain/a40a7934/transcript.json',
      '.gemini/antigravity-cli/brain/a40a7934/transcript.jsonl',
      '/tmp/transcript.jsonl',
      '',
    ]) {
      expect(ownsTranscript(invalid, env), invalid).toBe(false)
    }

    expect(ownsTranscript(valid, {})).toBe(false)
    expect(ownsTranscript(valid, { HOME: 'relative' })).toBe(false)
  })

  it('U-AGT-59 · reconcile: recorded fixtures and synthetic step states (finished without tool_calls, working with pending tool_calls, USER_INPUT, GENERIC, RUNNING, ERROR, model extraction, corrupt/missing files, and L.transcriptTailBytes cap)', async () => {
    // Recorded fixtures from Antigravity CLI 1.5.13
    expect(await reconcile({ transcriptPath: fxPath('finished.jsonl') })).toEqual({
      phase: 'finished',
      model: 'gemini-3.8-flash-low',
    })
    // Tool confirmation pending: last step is PLANNER_RESPONSE DONE with non-empty tool_calls -> 'working'
    expect(await reconcile({ transcriptPath: fxPath('confirming.jsonl') })).toEqual({
      phase: 'working',
      model: 'gemini-3.8-flash-low',
    })
    // Interrupted turns where a follow-up USER_INPUT (and SYSTEM_MESSAGE) remained at the tail -> 'working'
    expect(await reconcile({ transcriptPath: fxPath('interrupted-ctrlc.jsonl') })).toEqual({
      phase: 'working',
      model: 'gemini-3.8-flash-low',
    })
    expect(await reconcile({ transcriptPath: fxPath('interrupted-esc.jsonl') })).toEqual({
      phase: 'working',
      model: 'gemini-3.8-flash-low',
    })

    // Step state transitions on synthetic line sequences
    const userStep = JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'hi' })
    const runningStep = JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'RUNNING', model: 'gemini-4-neon-high' })
    const toolCallStep = JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-4-neon-high',
      tool_calls: [{ name: 'run_command', args: {} }],
    })
    const genericStep = JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'exit 0' })
    const finishedEmptyTools = JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'claude-sonnet-5-5-high',
      tool_calls: [],
      content: 'All done.',
    })
    const errorStep = JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      status: 'ERROR',
      model: 'claude-sonnet-5-5-high',
    })

    expect(reconcileLines([userStep])).toEqual({ phase: 'working' })
    expect(reconcileLines([userStep, runningStep])).toEqual({ phase: 'working', model: 'gemini-4-neon-high' })
    expect(reconcileLines([userStep, toolCallStep])).toEqual({ phase: 'working', model: 'gemini-4-neon-high' })
    expect(reconcileLines([userStep, toolCallStep, genericStep])).toEqual({ phase: 'working', model: 'gemini-4-neon-high' })
    expect(reconcileLines([userStep, toolCallStep, genericStep, finishedEmptyTools])).toEqual({
      phase: 'finished',
      model: 'claude-sonnet-5-5-high',
    })
    expect(reconcileLines([userStep, finishedEmptyTools, errorStep])).toEqual({
      phase: 'interrupted',
      model: 'claude-sonnet-5-5-high',
    })

    // Missing, empty, or corrupt files
    expect(await reconcile({ transcriptPath: null })).toEqual({ phase: null })
    expect(await reconcile({ transcriptPath: '/nonexistent/path/transcript.jsonl' })).toEqual({ phase: null })
    const dir = tmpDir()
    const emptyFile = path.join(dir, 'empty.jsonl')
    fs.writeFileSync(emptyFile, '')
    expect(await reconcile({ transcriptPath: emptyFile })).toEqual({ phase: null })

    const corruptFile = path.join(dir, 'corrupt.jsonl')
    fs.writeFileSync(corruptFile, 'not-json\n[1,2,3]\n{"unterminated":\n')
    expect(await reconcile({ transcriptPath: corruptFile })).toEqual({ phase: null })

    // Corrupt line followed by a valid line still reconciles the valid line
    const mixedFile = path.join(dir, 'mixed.jsonl')
    fs.writeFileSync(mixedFile, `not-json\n${finishedEmptyTools}\n`)
    expect(await reconcile({ transcriptPath: mixedFile })).toEqual({
      phase: 'finished',
      model: 'claude-sonnet-5-5-high',
    })

    // Tail cap L.transcriptTailBytes: an old model before the tail window is not read, while the tail records are reconciled
    const hugeFile = path.join(dir, 'huge.jsonl')
    const earlyRecord = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'ancient-early-model',
      content: 'early',
    })
    const fillerLine = JSON.stringify({
      step_index: 1,
      type: 'GENERIC',
      status: 'DONE',
      content: 'x'.repeat(4096),
    })
    const fillerCount = Math.ceil((L.transcriptTailBytes + 16384) / (fillerLine.length + 1))
    const tailRecord = JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'final answer without model field',
    })
    fs.writeFileSync(hugeFile, `${earlyRecord}\n${Array.from({ length: fillerCount }, () => fillerLine).join('\n')}\n${tailRecord}\n`)
    expect(fs.statSync(hugeFile).size).toBeGreaterThan(L.transcriptTailBytes)
    const hugeRes = await reconcile({ transcriptPath: hugeFile })
    expect(hugeRes).toEqual({ phase: 'finished' })
    expect(hugeRes.model).toBeUndefined()
  })

  it('U-AGT-59 · watchTranscript: starts at file end by default, emits meta model events on appended PLANNER_RESPONSE lines, flushes on dispose, and resumes from previous position', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'transcript.jsonl')
    const initial = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-3.8-flash-low',
      content: 'initial',
    })
    fs.writeFileSync(file, `${initial}\n`)

    let onChange: () => void = () => {}
    const out: AgentEvent[] = []
    const w1 = watchTranscript(
      { transcriptPath: file },
      (_f, cb) => {
        onChange = cb
        return { dispose() {} }
      },
      (e) => out.push(e),
    )
    // Pre-existing lines before watchTranscript started are not re-emitted
    expect(out).toEqual([])

    // Appending a USER_INPUT and a partial PLANNER_RESPONSE line
    const userLine = JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'next' })
    const plannerLine = JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-4-neon-xhigh',
      content: 'reply',
    })
    fs.appendFileSync(file, `${userLine}\n${plannerLine.slice(0, 25)}`)
    onChange()
    expect(out).toEqual([])

    // Completing the partial line triggers the meta event
    fs.appendFileSync(file, `${plannerLine.slice(25)}\n`)
    onChange()
    expect(out).toEqual([{ t: 'meta', model: 'gemini-4-neon-xhigh' }])

    // Appending another line just before dispose() flushes on dispose even without an fs.watch notification
    const beforeDispose = JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'claude-opus-5-5-high',
      content: 'flushed on dispose',
    })
    fs.appendFileSync(file, `${beforeDispose}\n`)
    w1.dispose()
    w1.dispose() // idempotent
    expect(out).toEqual([
      { t: 'meta', model: 'gemini-4-neon-xhigh' },
      { t: 'meta', model: 'claude-opus-5-5-high' },
    ])

    // Appending while no watcher is active, then resuming from w1.position
    const whileUnwatched = JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-4-argon-high',
      content: 'while unwatched',
    })
    fs.appendFileSync(file, `${whileUnwatched}\n`)
    const w2 = watchTranscript({ transcriptPath: file }, () => ({ dispose() {} }), (e) => out.push(e), w1.position)
    expect(out.at(-1)).toEqual({ t: 'meta', model: 'gemini-4-argon-high' })
    w2.dispose()
    expect(w2.position).toBe(fs.statSync(file).size)

    // Null transcriptPath returns a no-op watcher at `from ?? 0`
    const noop = watchTranscript({ transcriptPath: null }, () => ({ dispose() {} }), () => {}, 42)
    expect(noop.position).toBe(42)
    noop.dispose()
    expect(eventsOfLines(['not json', JSON.stringify({ type: 'USER_INPUT', model: 'ignored' })])).toEqual([])
  })
})
