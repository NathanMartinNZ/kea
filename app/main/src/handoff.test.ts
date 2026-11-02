// The window handoff: what a minimized window rebuilt on Wayland gives the window made in its place.

import { L } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentHandover, WindowHandoff } from './handoff.ts'

const draft = { prompt: 'fix the login redirect loop', isolation: 'worktree', base: { kind: 'default' }, branch: null, agent: 'claude', config: {} }
const PROJECT = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
/** The window being rebuilt (its webContents id). */
const OLD = 3

describe('the window handoff', () => {
  afterEach(() => vi.useRealTimers())

  it('U-PLT-52 · the old window is asked once and its answer, checked, goes to the window made in its place only, as often as its preload asks until its page has started (Electron may run a preload twice as a window loads), then it is let go; an answer that does not parse, comes from another window, comes for another question or comes late hands nothing over; with no answer in window_handoff_timeout_ms the rebuild goes on without one', async () => {
    vi.useFakeTimers()
    const h = new WindowHandoff()
    const asked: number[] = []
    const NEW = 7
    // answered
    let done = h.ask(OLD, (reqId) => asked.push(reqId))
    expect(asked).toHaveLength(1)
    expect(h.answer(OLD, asked[0]! + 1, { drafts: [[PROJECT, draft]] }), 'another question').toBe(false)
    expect(h.answer(OLD + 1, asked[0]!, { drafts: [[PROJECT, draft]] }), 'another window').toBe(false)
    expect(h.answer(OLD, asked[0]!, { drafts: [[PROJECT, draft]] })).toBe(true)
    await done
    expect(h.held).toBe(1)
    expect(h.take(NEW), 'before the new window is named').toBeNull()
    h.giveTo(NEW)
    expect(h.take(NEW)).toEqual({ drafts: [[PROJECT, draft]] })
    expect(h.take(NEW), 'its preload again, before the page started').toEqual({ drafts: [[PROJECT, draft]] })
    expect(h.take(NEW + 1), 'another window').toBeNull()
    h.started(NEW + 1)
    expect(h.held, 'another window’s start lets nothing go').toBe(1)
    h.started(NEW)
    expect([h.take(NEW), h.held], 'let go once its page started (a reload later takes nothing)').toEqual([null, null])
    // an answer that does not parse
    done = h.ask(OLD, (reqId) => asked.push(reqId))
    expect(h.answer(OLD, asked[1]!, { drafts: [[PROJECT, { ...draft, prompt: 3 }]] })).toBe(false)
    await done
    h.giveTo(NEW)
    expect(h.take(NEW)).toBeNull()
    // no answer: the rebuild goes on after the timeout, and a late answer is dropped
    let over = false
    done = h.ask(OLD, (reqId) => asked.push(reqId)).then(() => void (over = true))
    await vi.advanceTimersByTimeAsync(L.windowHandoffTimeoutMs - 1)
    expect(over).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(over).toBe(true)
    expect(h.answer(OLD, asked[2]!, { drafts: [[PROJECT, draft]] }), 'too late').toBe(false)
    h.giveTo(NEW)
    expect(h.take(NEW)).toBeNull()
    // a window that is gone answers nothing: its send throws, and the rebuild goes on at once
    await h.ask(OLD, () => {
      throw new Error('Object has been destroyed')
    })
    h.giveTo(NEW)
    expect(h.take(NEW)).toBeNull()
  })

  it('U-DST-31 · drafts kept across a restart Kea made itself are held for the first window only, until its page has started; the state read for the file is the old window’s answer', async () => {
    const h = new WindowHandoff()
    h.restore({ drafts: [[PROJECT, draft]] } as never)
    expect(h.take(7), 'no window named yet').toBeNull()
    h.giveTo(7)
    expect(h.take(7)).toEqual({ drafts: [[PROJECT, draft]] })
    h.started(7)
    expect(h.take(7)).toBeNull()
    const asked: number[] = []
    const done = h.ask(OLD, (id) => asked.push(id))
    h.answer(OLD, asked[0], { drafts: [[PROJECT, draft]] })
    await done
    expect(h.state).toEqual({ drafts: [[PROJECT, draft]] })
  })
})

describe('the unsaved files handed over', () => {
  afterEach(() => vi.useRealTimers())

  const doc = (path: string) => ({ sessionId: 'S1', path, text: 'let a = 2\n', base: 'let a = 1\n', version: 'a'.repeat(64), eol: 'lf', encoding: 'utf8', bom: false, mode: 0o644, selection: [{ anchor: 8, head: 9 }], marks: [], state: 'dirty', deleted: false, sent: null, active: true })

  it('U-FV-29 · the old window’s unsaved files, checked, are held for the window made in its place alone and taken once, which the rebuild waits for; closing or failing the new window abandons it; an answer over the caps, a late one or none at all hands nothing over, and a window with none answers an empty list', async () => {
    vi.useFakeTimers()
    const h = new DocumentHandover()
    const asked: number[] = []
    let answer = h.ask(OLD, (reqId) => asked.push(reqId))
    expect(h.answer(OLD, asked[0]! + 1, { documents: [doc('a.ts')] }), 'another question').toBe(false)
    expect(h.answer(OLD, asked[0]!, { documents: [doc('a.ts'), doc('b.ts')] })).toBe(true)
    const docs = await answer
    expect(docs?.documents.map((d) => d.path)).toEqual(['a.ts', 'b.ts'])
    let taken = h.give(7, docs!)
    expect(h.count).toBe(2)
    expect(h.take(8), 'another window').toBeNull()
    expect(h.take(7)).toEqual(docs)
    expect(await taken).toBe(true)
    expect([h.take(7), h.count], 'taken once').toEqual([null, 0])
    // abandoned: the new window closed or failed to load first, or the old one stopped responding
    taken = h.give(9, docs!)
    h.abandon()
    expect([await taken, h.take(9)]).toEqual([false, null])

    // none to give: an empty list; over the caps: refused
    answer = h.ask(OLD, (reqId) => asked.push(reqId))
    expect(h.answer(OLD, asked[1]!, null)).toBe(true)
    expect(await answer).toEqual({ documents: [] })
    answer = h.ask(OLD, (reqId) => asked.push(reqId))
    const many = Array.from({ length: L.viewerUnsavedMax + 2 }, (_, i) => doc(`f${i}.ts`))
    expect(h.answer(OLD, asked[2]!, { documents: many })).toBe(false)
    expect(await answer).toBeNull()
    answer = h.ask(OLD, (reqId) => asked.push(reqId))
    expect(h.answer(OLD, asked[3]!, { documents: [{ ...doc('a.ts'), selection: Array.from({ length: L.viewerCursorMax + 1 }, () => ({ anchor: 0, head: 0 })) }] })).toBe(false)
    expect(await answer).toBeNull()
    // no answer in window_handoff_timeout_ms, then a late one: nothing
    answer = h.ask(OLD, (reqId) => asked.push(reqId))
    await vi.advanceTimersByTimeAsync(L.windowHandoffTimeoutMs)
    expect(await answer).toBeNull()
    expect(h.answer(OLD, asked[4]!, { documents: [doc('a.ts')] })).toBe(false)
    // a window that cannot be asked
    expect(
      await h.ask(OLD, () => {
        throw new Error('Object has been destroyed')
      }),
    ).toBeNull()
  })

  it('U-FV-29 · the answer is taken only from the window asked; a document whose text, base or the text a save sent is over viewer_max_bytes, or with more than viewer_marks_max marks, hands nothing over; the new window has window_rebuild_take_ms from when they are held to take them, or the rebuild is abandoned and a late take gets nothing, and until it takes them they wait for it alone', async () => {
    vi.useFakeTimers()
    const h = new DocumentHandover()
    const asked: number[] = []
    let answer = h.ask(OLD, (reqId) => asked.push(reqId))
    expect(h.answer(OLD + 1, asked[0]!, { documents: [doc('a.ts')] }), 'another window').toBe(false)
    expect(h.answer(OLD, asked[0]!, { documents: [doc('a.ts')] })).toBe(true)
    const docs = (await answer)!
    // the caps: each refused, each at its limit taken
    const over = 'x'.repeat(L.viewerMaxBytes + 1)
    const span = { from: 0, to: 1 }
    const mark = { doc: span, base: span }
    for (const [field, bad, ok] of [
      ['text', { text: over }, { text: over.slice(1) }],
      ['base', { base: over }, { base: over.slice(1) }],
      ['sent', { sent: over }, { sent: over.slice(1) }],
      ['marks', { marks: Array.from({ length: L.viewerMarksMax + 1 }, () => mark) }, { marks: Array.from({ length: L.viewerMarksMax }, () => mark) }],
    ] as const) {
      answer = h.ask(OLD, (reqId) => asked.push(reqId))
      expect(h.answer(OLD, asked.at(-1), { documents: [{ ...doc('a.ts'), ...bad }] }), `${field} over its cap`).toBe(false)
      expect(await answer).toBeNull()
      answer = h.ask(OLD, (reqId) => asked.push(reqId))
      expect(h.answer(OLD, asked.at(-1), { documents: [{ ...doc('a.ts'), ...ok }] }), `${field} at its cap`).toBe(true)
      expect((await answer)?.documents).toHaveLength(1)
    }

    // the new window does not take them in time: abandoned, and the old window keeps them
    let done = false
    const taken = h.give(7, docs).then((t) => ((done = true), t))
    expect([h.waitsFor(7), h.waitsFor(8)]).toEqual([true, false])
    await vi.advanceTimersByTimeAsync(L.windowRebuildTakeMs - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect([await taken, h.take(7), h.waitsFor(7), h.count]).toEqual([false, null, false, 0])
    // taken in time: the deadline is gone with it
    const inTime = h.give(9, docs)
    expect(h.take(9)).toEqual(docs)
    await vi.advanceTimersByTimeAsync(L.windowRebuildTakeMs)
    expect([await inTime, h.waitsFor(9)]).toEqual([true, false])
    expect(vi.getTimerCount(), 'no timer left').toBe(0)
  })
})

