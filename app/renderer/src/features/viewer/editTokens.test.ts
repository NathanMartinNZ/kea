import fs from 'node:fs'
import { EditorState, type ChangeSpec, type TransactionSpec } from '@codemirror/state'
import { INITIAL } from 'shiki/textmate'
import { describe, expect, it } from 'vitest'
import { HighlightClient, type HighlightJob, type WorkerLike } from './client.ts'
import { EditTokens, type FrameHost, type TokenView } from './editTokens.ts'
import { followEdits, tokensArrived, tokenStore } from './highlight.ts'
import { TokenStore } from './tokens.ts'
import { HighlightEngine } from './worker/engine.ts'
import type { FromWorker, ToWorker } from './worker/protocol.ts'
import { ShikiGrammars } from './worker/shiki.ts'
import { LineTokenizer, splitLines } from './worker/tokenizer.ts'

/** Animation frames the test runs by hand. */
class Frames implements FrameHost {
  private seq = 0
  readonly waiting = new Map<number, () => void>()
  request = (fn: () => void): unknown => {
    this.waiting.set(++this.seq, fn)
    return this.seq
  }
  cancel = (h: unknown): void => void this.waiting.delete(h as number)
  run(): void {
    const fns = [...this.waiting.values()]
    this.waiting.clear()
    for (const f of fns) f()
  }
}

/** The editor that shows the document; `draws` counts the `tokensArrived` it was given. */
class View implements TokenView {
  state: EditorState
  draws = 0
  constructor(doc: string, store: TokenStore) {
    this.state = EditorState.create({ doc, extensions: [tokenStore.of(store)] })
  }
  dispatch(spec: TransactionSpec): void {
    const tr = this.state.update(spec)
    if (tr.effects.some((e) => e.is(tokensArrived))) this.draws++
    this.state = tr.state
  }
}

/** A change made in the editor: the highlight plugin moves the store's tokens, then the controller tells the tokeniser. */
function type(view: View, store: TokenStore, tokens: EditTokens | null, changes: ChangeSpec): void {
  const tr = view.state.update({ changes })
  followEdits(store, tr.changes, tr.startState.doc, tr.newDoc, true)
  view.state = tr.state
  tokens?.changed(tr)
}

/** A client that keeps what it is asked. */
class Client {
  readonly sent: (HighlightJob & { cancelled: boolean })[] = []
  tokenize(job: HighlightJob): { cancel(): void } {
    const s = { ...job, cancelled: false }
    this.sent.push(s)
    return { cancel: () => void (s.cancelled = true) }
  }
  get last(): HighlightJob & { cancelled: boolean } {
    return this.sent.at(-1)!
  }
}

const chunk = (from: number, to: number) => ({ from, to, starts: new Uint32Array(to - from + 1), data: new Uint32Array(0) })
const lineText = (n: number) => `line ${n}`
const line = (view: View, n: number) => view.state.doc.line(n + 1)

describe('the colours of a document the user edits', () => {
  it('U-FV-26 · changes go to the worker at most once per animation frame, with the line edits since the last request and the change count; tokens are drawn once per frame', () => {
    const store = new TokenStore()
    const view = new View(Array.from({ length: 20 }, (_, n) => lineText(n)).join('\n'), store)
    const frames = new Frames()
    const client = new Client()
    const tokens = new EditTokens({ doc: 'doc', lang: 'typescript', store, client, frames })
    // nothing is asked before the document is on screen; then at once, from the top
    expect(client.sent).toHaveLength(0)
    tokens.show(view)
    expect(client.sent).toHaveLength(1)
    expect(client.last).toMatchObject({ doc: 'doc', lang: 'typescript', text: view.state.doc.toString(), budgetMs: null, edit: { since: null, count: 0, edits: [], applied: 0 } })
    // chunks go into the store as they come and are drawn in the next frame, once
    const first = client.last
    first.onChunk(chunk(0, 5))
    first.onChunk(chunk(5, 20))
    expect(store.lines).toBe(20)
    expect(view.draws).toBe(0)
    frames.run()
    expect(view.draws).toBe(1)
    first.onDone({ stoppedAt: null, failed: null })
    expect(tokens.settled).toBe(true)

    // three changes before a frame, the last at two cursors: one request in the frame, its edits numbered in the text
    // the last request carried
    type(view, store, tokens, { from: line(view, 2).from, insert: 'a' })
    type(view, store, tokens, { from: line(view, 9).to, insert: '\nb' })
    type(view, store, tokens, [
      { from: line(view, 14).from, insert: 'c' },
      { from: line(view, 17).from, insert: 'd' },
    ])
    expect(tokens.settled).toBe(false)
    expect(client.sent).toHaveLength(1)
    expect(frames.waiting.size).toBe(1)
    frames.run()
    expect(client.sent).toHaveLength(2)
    const second = client.last
    expect(second.text).toBe(view.state.doc.toString())
    expect(second.edit).toEqual({
      since: 0,
      count: 3,
      edits: [
        { from: 2, to: 3, lines: 1 },
        { from: 9, to: 10, lines: 2 },
        { from: 13, to: 14, lines: 1 },
        { from: 16, to: 17, lines: 1 },
      ],
      applied: 2,
    })
    // nothing more until the text changes again
    frames.run()
    expect(client.sent).toHaveLength(2)

    // a chunk that comes after the text changed is numbered for the old text: dropped, and the next request says how
    // many of the last one's were put
    second.onChunk(chunk(2, 3))
    type(view, store, tokens, { from: 0, insert: 'e' })
    const version = store.version
    second.onChunk(chunk(9, 11))
    expect(store.version).toBe(version)
    second.onDone({ stoppedAt: null, failed: null })
    expect(tokens.settled).toBe(false)
    frames.run()
    expect(client.last.edit).toEqual({ since: 3, count: 4, edits: [{ from: 0, to: 1, lines: 1 }], applied: 1 })
    // a worker recycled sends the request again from the top: what it had put counts no more
    const third = client.last
    third.onChunk(chunk(0, 1))
    third.onRestart?.()
    third.onChunk(chunk(0, 5))
    third.onChunk(chunk(5, 10))

    // hidden: the request is cancelled and no frame is left waiting; shown again, it is asked for again
    type(view, store, tokens, { from: line(view, 4).from, insert: 'f' })
    expect(frames.waiting.size).toBe(1)
    tokens.hide()
    expect(third.cancelled).toBe(true)
    expect(frames.waiting.size).toBe(0)
    tokens.show(view)
    expect(client.last.edit).toEqual({ since: 4, count: 5, edits: [{ from: 4, to: 5, lines: 1 }], applied: 2 })
    client.last.onDone({ stoppedAt: null, failed: null })
    expect(tokens.settled).toBe(true)
    // a settled document shown again asks for nothing
    tokens.hide()
    tokens.show(view)
    expect(client.sent).toHaveLength(4)

    // a text the tokeniser did not follow (a change it was not told of): the next request starts from the top
    type(view, store, null, { from: 0, insert: 'g' })
    type(view, store, tokens, { from: 0, insert: 'h' })
    frames.run()
    expect(client.last.edit).toMatchObject({ since: null, edits: [] })
    expect(client.last.text).toBe(view.state.doc.toString())
    client.last.onDone({ stoppedAt: null, failed: null })
    type(view, store, null, { from: 0, insert: 'i' })
    tokens.hide()
    tokens.show(view)
    expect(client.last.edit).toMatchObject({ since: null, edits: [] })

    // while the editor shows another document nothing is drawn; disposed, nothing more is asked
    const other = new View('other', new TokenStore())
    tokens.hide()
    tokens.show(other)
    client.last.onChunk(chunk(0, 1))
    frames.run()
    expect(other.draws).toBe(0)
    const draws = view.draws
    tokens.dispose()
    expect(client.last.cancelled).toBe(true)
    const asked = client.sent.length
    type(view, store, tokens, { from: 0, insert: 'j' })
    tokens.show(view)
    frames.run()
    expect(client.sent).toHaveLength(asked)
    expect(view.draws).toBe(draws)
  })

  it('U-FV-26 · through the worker: random typing at several cursors, coalesced per frame and changed while runs are under way, leaves the colours of a whole-file run', async () => {
    const grammars = new ShikiGrammars()
    const limits = { firstLines: 5, chunkLines: 7, lineMax: 20_000, lineMs: 500, docsMax: 4 }
    const tick = () => new Promise<void>((r) => setImmediate(r))
    let requests = 0
    /** The engine in this process, its messages crossing later and in order, as a worker's do. */
    class EngineWorker implements WorkerLike {
      onmessage: ((e: { data: FromWorker }) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      private readonly engine = new HighlightEngine(
        {
          grammar: (lang) => grammars.grammar(lang),
          roleOf: () => grammars.roleOf(),
          grammars: () => grammars.count(),
          post: (m) => void setImmediate(() => this.onmessage?.({ data: m })),
          now: () => 0,
          yield: tick,
        },
        limits,
      )
      postMessage(m: ToWorker): void {
        if (m.t === 'tokenize') requests++
        setImmediate(() => this.engine.handle(m))
      }
      terminate(): void {}
    }
    const client = new HighlightClient({ spawn: () => new EngineWorker() })
    client.setVisible(true)
    const text = fs.readFileSync('tests/support/app.ts', 'utf8').split('\n').slice(0, 250).join('\n')
    const store = new TokenStore()
    const view = new View(text, store)
    const frames = new Frames()
    const tokens = new EditTokens({ doc: 'typed', lang: 'typescript', store, client, frames })
    tokens.show(view)

    let seed = 11
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return (seed >>> 8) % n
    }
    const pos = () => rnd(view.state.doc.length + 1)
    for (let frame = 0; frame < 60; frame++) {
      for (let n = rnd(4); n > 0; n--) {
        const kind = rnd(6)
        if (kind === 0) {
          const from = pos()
          type(view, store, tokens, { from, to: Math.min(view.state.doc.length, from + rnd(60)) })
        } else if (kind === 1) type(view, store, tokens, { from: pos(), insert: ['/*', '*/', '`', '"', "'"][rnd(5)] })
        else if (kind === 2) type(view, store, tokens, { from: pos(), insert: 'const pasted = {\n  a: 1,\n}\n' })
        else {
          const at = [...new Set([pos(), pos(), pos()])].sort((a, b) => a - b)
          type(view, store, tokens, at.map((from) => ({ from, insert: ['a', ' ', '\n', 'xy'][kind - 3] })))
        }
      }
      const before = requests
      frames.run()
      expect(requests - before).toBeLessThanOrEqual(1)
      // the worker gets on with it for a while; nothing is asked between frames
      const asked = requests
      for (let n = rnd(12); n > 0; n--) await tick()
      expect(requests).toBe(asked)
    }
    for (let i = 0; i < 10_000 && !(tokens.settled && frames.waiting.size === 0); i++) {
      frames.run()
      await tick()
    }
    expect(tokens.settled).toBe(true)
    const lines = splitLines(view.state.doc.toString())
    const whole = new TokenStore()
    whole.put(new LineTokenizer((await grammars.grammar('typescript'))!, grammars.roleOf(), limits).run(lines, 0, lines.length, INITIAL).chunk)
    const differing: number[] = []
    const tokensOf = (s: TokenStore, n: number) => {
      const t = s.line(n)
      return t ? [...t.data.subarray(t.from, t.to)].join() : null
    }
    for (let n = 0; n < lines.length; n++) if (tokensOf(store, n) !== tokensOf(whole, n)) differing.push(n)
    expect(differing).toEqual([])
    expect(store.lines).toBe(lines.length)
    expect(view.draws).toBeGreaterThan(0)
    client.dispose()
  })
})
