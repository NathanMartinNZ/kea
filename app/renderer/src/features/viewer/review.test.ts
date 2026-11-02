// The warning before unsaved changes are lost and the reviews that ask it, with the bridge, the controller, the
// sessions and the commands stood in for: the user's answers are given by `answerUnsaved` once the warning is up, and
// main's requests arrive through the review host the module installs. The registry and the tab strip are the real ones.
import { EditorState, Text } from '@codemirror/state'
import type { LineEnding } from '@kea/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewHost } from '../../lib/bridge.ts'
import type { FileDocument } from './document.ts'
import type { UnsavedAnswer, UnsavedAsk } from './review.svelte.ts'
import type { UnsavedEntry } from './unsaved.svelte.ts'

const m = vi.hoisted(() => ({
  host: null as ReviewHost | null,
  core: [] as ((up: boolean) => void)[],
  ports: [] as ((port: unknown) => void)[],
  answers: [] as [number, string][],
  counts: [] as number[],
  opened: [] as string[],
  copied: [] as string[],
  copyOk: true,
  discarded: [] as string[],
  toasts: [] as { message: string; action?: { label: string; run: () => void } }[],
  active: null as string | null,
  known: new Set<string>(),
  save: null as ((sessionId: string, path: string, doc: FileDocument) => Promise<void>) | null,
  shownDoc: null as FileDocument | null,
  comparedDoc: null as FileDocument | null,
  closing: [] as boolean[],
  stateChanged: 0,
}))

vi.mock('../../lib/bridge.ts', () => ({
  onRpcPort: (cb: (port: unknown) => void) => {
    m.ports.push(cb)
    return () => {}
  },
  coreConnected: () => false,
  onCoreConnection: (cb: (up: boolean) => void) => {
    m.core.push(cb)
    return () => {}
  },
  setReviewHost: (h: ReviewHost | null) => {
    m.host = h
  },
  answerReview: (reqId: number, a: string) => m.answers.push([reqId, a]),
  setUnsavedCount: (n: number) => m.counts.push(n),
  takeDocuments: async () => null,
}))
vi.mock('./controller.svelte.ts', async () => {
  const u = await import('./unsaved.svelte.ts')
  const viewer = {
    showing: (doc: FileDocument) => doc === m.shownDoc,
    comparing: (doc: FileDocument) => doc === m.comparedDoc,
    setClosing: (on: boolean) => m.closing.push(on),
    saveStateChanged: () => void m.stateChanged++,
  }
  return {
    currentViewer: () => viewer,
    // Don't Save as the controller does it: the document leaves the registry and is no longer closing
    discardDocument: (sessionId: string, path: string) => {
      m.discarded.push(`${sessionId}/${path}`)
      const doc = u.unsavedDoc(sessionId, path)
      u.dropUnsaved(sessionId, path)
      if (doc) doc.closing = false
    },
    saveUnsaved: (sessionId: string, path: string, doc: FileDocument) => (m.save ? m.save(sessionId, path, doc) : Promise.resolve()),
    handedDocument: (e: UnsavedEntry, active: boolean) => ({ path: e.path, active }),
    documentFromHand: () => null,
  }
})
vi.mock('../sessions/state.svelte.ts', () => ({
  activeSessionId: () => m.active,
  selectSession: (id: string) => {
    m.active = id
  },
  sessions: { get: (id: string) => (m.known.has(id) ? { id } : undefined) },
  showToast: (t: { message: string; action?: { label: string; run: () => void } }) => m.toasts.push(t),
  ui: { sheet: null },
}))
vi.mock('../files/state.svelte.ts', () => ({ panel: { discard: null, trash: null, copyIn: null } }))
vi.mock('../sessions/actions.ts', () => ({
  copyText: async (text: string) => {
    m.copied.push(text)
    return m.copyOk
  },
}))
vi.mock('../commands/registry.ts', async () => {
  const { fileTabsState } = await import('../../shell/fileTabs.svelte.ts')
  return {
    commands: {
      // the session's pane opens the file and shows it
      run: (id: string, args: { sessionId: string; path: string }) => {
        if (id !== 'viewer.open') return false
        m.opened.push(`${args.sessionId}/${args.path}`)
        fileTabsState.shown = { sessionId: args.sessionId, path: args.path, mode: 'file' }
        return true
      },
      changed: () => {},
    },
  }
})

const { answerUnsaved, closeAsking, dropUnsavedUnder, lostLine, orphanUnsavedFiles, reviewUnsaved, reviewView, withDiscards } = await import('./review.svelte.ts')
const { DocSave } = await import('./saving.ts')
const { textStats, viewPolicy } = await import('./policy.ts')
const { fileTabsOf, fileTabsState } = await import('../../shell/fileTabs.svelte.ts')
const { dropUnsaved, isUnsaved, trackUnsaved, unsavedEntries, unsavedEntry, windowGoing } = await import('./unsaved.svelte.ts')

/** A file document read as `base` that the user has changed to `now`. */
function fileDoc(base: string, now: string, eol: LineEnding = 'lf'): FileDocument {
  const lines = base.split('\n')
  const save = new DocSave(Text.of(lines), { version: 'v1', eol, encoding: 'utf8', bom: false, mode: 0o644 })
  const state = EditorState.create({ doc: now })
  save.edited(state.doc)
  return { state, store: null, policy: viewPolicy(textStats(base.length, lines)), lang: null, eol, encoding: 'utf8', invalid: false, size: base.length, link: null, changes: null, longest: 0, tokenised: -1, stoppedAt: null, bytes: base.length, save, readOnly: null, unwritable: null, notText: null, pendingDisk: null, closing: false, colours: null }
}

const unsaved = (sessionId: string, path: string, now = 'changed', eol: LineEnding = 'lf'): FileDocument => {
  const doc = fileDoc('text', now, eol)
  trackUnsaved(sessionId, path, doc)
  return doc
}

/** Kea's core connects (true) or goes away (false), as the bridge tells it. */
function core(up: boolean): void {
  for (const cb of m.core) cb(up)
  if (up) for (const cb of m.ports) cb({})
}

/** Wait, over microtasks only, until `cond` holds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (cond()) return
    await Promise.resolve()
  }
  throw new Error(`still waiting: ${what}`)
}

/** The warning once it is up. */
async function asked(): Promise<UnsavedAsk> {
  await until(() => reviewView.ask !== null, 'the warning')
  return reviewView.ask as UnsavedAsk
}

/** Answer the warning once it is up; the file it asked about. */
async function reply(a: UnsavedAnswer): Promise<string> {
  const q = await asked()
  answerUnsaved(a)
  return `${q.sessionId}/${q.path}`
}

/** A save that writes the file: the document is clean and leaves the registry. */
async function saveOk(sessionId: string, path: string, doc: FileDocument): Promise<void> {
  const call = doc.save?.begin(doc.state?.doc ?? Text.empty)
  doc.save?.settle(call?.id ?? 0, { kind: 'saved', version: 'v2' }, doc.state?.doc ?? Text.empty)
  trackUnsaved(sessionId, path, doc)
}

/** A save that is refused: the document stays unsaved, with its notice. */
async function saveRefused(sessionId: string, path: string, doc: FileDocument): Promise<void> {
  const call = doc.save?.begin(doc.state?.doc ?? Text.empty)
  doc.save?.settle(call?.id ?? 0, { kind: 'refused', reason: 'permission' }, doc.state?.doc ?? Text.empty)
  trackUnsaved(sessionId, path, doc)
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve = (_v: T) => {}
  let reject = (_e: unknown) => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  Object.assign(m, { answers: [], counts: [], opened: [], copied: [], copyOk: true, discarded: [], toasts: [], active: 's1', save: saveOk, shownDoc: null, comparedDoc: null, closing: [], stateChanged: 0 })
  m.known = new Set(['s1', 's2'])
  fileTabsState.shown = null
  fileTabsState.bySession = new Map()
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    queueMicrotask(() => cb(0))
    return 0
  })
  core(true)
})

afterEach(async () => {
  answerUnsaved('cancel')
  for (let i = 0; i < 50; i++) await Promise.resolve()
  for (const e of unsavedEntries()) dropUnsaved(e.sessionId, e.path)
  vi.unstubAllGlobals()
})

describe('the review of unsaved files', () => {
  it('U-FV-24 · the file on screen is asked first, then the others of its session, then the other sessions’, each put on screen before it is asked', async () => {
    unsaved('s1', 'a.ts')
    unsaved('s2', 'b.ts')
    unsaved('s1', 'c.ts')
    unsaved('s2', 'd.ts')
    m.active = 's2'
    fileTabsState.shown = { sessionId: 's2', path: 'd.ts', mode: 'file' }
    const handed: string[] = []
    const done = reviewUnsaved({ kind: 'window' }, (e) => handed.push(`${e.sessionId}/${e.path}`))
    const order: string[] = []
    for (let i = 0; i < 4; i++) {
      const q = await asked()
      order.push(`${q.sessionId}/${q.path}`)
      // the file asked about is the one on screen, in its session
      expect(m.opened.at(-1)).toBe(order.at(-1))
      expect(m.active).toBe(q.sessionId)
      answerUnsaved('dontSave')
    }
    expect(order).toEqual(['s2/d.ts', 's2/b.ts', 's1/a.ts', 's1/c.ts'])
    expect(await done).toBe(true)
    expect(handed).toEqual(order)
  })

  it('U-FV-24 · Save saves the file and goes on; a save that does not end saved stops the review there, the file on screen with its notice', async () => {
    const a = unsaved('s1', 'a.ts')
    const b = unsaved('s1', 'b.ts')
    const saved: FileDocument[] = []
    m.save = async (s, p, doc) => {
      saved.push(doc)
      await (doc === a ? saveOk : saveRefused)(s, p, doc)
    }
    const handed: string[] = []
    const done = reviewUnsaved({ kind: 'sessions', ids: new Set(['s1']) }, (e) => handed.push(e.path))
    expect(await reply('save')).toBe('s1/a.ts')
    expect(isUnsaved('s1', 'a.ts')).toBe(false)
    expect(await reply('save')).toBe('s1/b.ts')
    expect(await done).toBe(false)
    expect(saved).toEqual([a, b])
    expect(isUnsaved('s1', 'b.ts')).toBe(true)
    expect(m.opened).toEqual(['s1/a.ts', 's1/b.ts', 's1/b.ts'])
    expect(handed).toEqual([])
  })

  it('U-FV-24 · Don’t Save hands the file to the action; Copy All copies the text with the file’s line ending and is Don’t Save; Cancel stops', async () => {
    unsaved('s1', 'a.ts', 'one\ntwo', 'crlf')
    unsaved('s1', 'b.ts')
    unsaved('s1', 'c.ts')
    const handed: string[] = []
    const done = reviewUnsaved({ kind: 'window' }, (e) => handed.push(e.path))
    await reply('copyAll')
    expect(m.copied).toEqual(['one\r\ntwo'])
    await reply('dontSave')
    expect(await reply('cancel')).toBe('s1/c.ts')
    expect(await done).toBe(false)
    expect(handed).toEqual(['a.ts', 'b.ts'])
    // a copy that fails is not Don't Save
    m.copyOk = false
    const again = reviewUnsaved({ kind: 'file', sessionId: 's1', path: 'c.ts' }, (e) => handed.push(e.path))
    await reply('copyAll')
    expect(await again).toBe(false)
    expect(handed).toEqual(['a.ts', 'b.ts'])
  })

  it('U-FV-24 · Copy All replaces Save while Kea’s core is restarting and for a file whose session is gone, which is not put on screen', async () => {
    unsaved('s1', 'a.ts')
    core(false)
    let done = reviewUnsaved({ kind: 'window' }, () => {})
    expect((await asked()).cannotSave).toBe('Kea’s core is restarting')
    answerUnsaved('cancel')
    await done
    core(true)
    done = reviewUnsaved({ kind: 'window' }, () => {})
    expect((await asked()).cannotSave).toBeNull()
    answerUnsaved('cancel')
    await done
    // the session went
    m.known.delete('s1')
    orphanUnsavedFiles((id) => m.known.has(id))
    m.opened = []
    done = reviewUnsaved({ kind: 'orphans' }, () => {})
    expect(await asked()).toMatchObject({ path: 'a.ts', orphan: true, cannotSave: 'Its session is gone' })
    expect(m.opened).toEqual([])
    answerUnsaved('cancel')
    await done
  })

  it('U-FV-24 · withDiscards: Don’t Save’s documents are set aside while the action runs and dropped when it happens; other sessions’ are not asked', async () => {
    const a = unsaved('s1', 'a.ts')
    const b = unsaved('s1', 'b.ts')
    unsaved('s2', 'c.ts')
    m.shownDoc = b
    const during: (string | null)[] = []
    const action = vi.fn(async () => {
      during.push(unsavedEntry('s1', 'a.ts')?.aside ?? null, unsavedEntry('s1', 'b.ts')?.aside ?? null)
      expect([a.closing, b.closing]).toEqual([true, true])
      return true
    })
    const done = withDiscards({ kind: 'sessions', ids: new Set(['s1']) }, action)
    expect([await reply('dontSave'), await reply('dontSave')].sort()).toEqual(['s1/a.ts', 's1/b.ts'])
    expect(await done).toBe(true)
    expect(action).toHaveBeenCalledTimes(1)
    expect(during[0]).toMatch(/^local:/)
    expect(during[1]).toBe(during[0])
    // the document on screen showed "Closing…" while it was set aside
    expect(m.closing).toEqual([true])
    expect(m.discarded.sort()).toEqual(['s1/a.ts', 's1/b.ts'])
    expect(unsavedEntries().map((e) => `${e.sessionId}/${e.path}`)).toEqual(['s2/c.ts'])
  })

  it('U-FV-24 · a document on screen under Compare is set aside and given back as one in the file view is: its line says “Closing…” while the action runs', async () => {
    const a = unsaved('s1', 'a.ts')
    m.comparedDoc = a
    const action = deferred<boolean>()
    const done = withDiscards({ kind: 'sessions', ids: new Set(['s1']) }, () => action.promise)
    expect(await reply('dontSave')).toBe('s1/a.ts')
    await until(() => m.closing.length > 0, 'the document set aside')
    expect(m.closing).toEqual([true])
    action.resolve(false)
    expect(await done).toBe(false)
    expect(m.closing).toEqual([true, false])
    expect(a.closing).toBe(false)
    expect(isUnsaved('s1', 'a.ts')).toBe(true)
  })

  it('U-FV-24 · withDiscards over a path asks about the file at it and the files under it, and no other (a rename or move onto it)', async () => {
    unsaved('s1', 'lib/b.ts')
    unsaved('s1', 'lib/b.ts.orig')
    unsaved('s1', 'dir/x.ts')
    unsaved('s1', 'dir/sub/y.ts')
    unsaved('s2', 'lib/b.ts')
    const action = vi.fn(async () => true)
    const one = withDiscards({ kind: 'under', sessionId: 's1', path: 'lib/b.ts' }, action)
    expect(await reply('dontSave')).toBe('s1/lib/b.ts')
    expect(await one).toBe(true)
    const all = withDiscards({ kind: 'under', sessionId: 's1', path: 'dir' }, action)
    expect([await reply('dontSave'), await reply('dontSave')].sort()).toEqual(['s1/dir/sub/y.ts', 's1/dir/x.ts'])
    expect(await all).toBe(true)
    expect(unsavedEntries().map((e) => `${e.sessionId}/${e.path}`).sort()).toEqual(['s1/lib/b.ts.orig', 's2/lib/b.ts'])
  })

  it('U-FV-24 · withDiscards gives the documents back, unsaved, when the action does not happen, rejects or the review is cancelled; a tab that went comes back pinned', async () => {
    const a = unsaved('s1', 'a.ts')
    m.shownDoc = a
    const scope = { kind: 'sessions', ids: new Set(['s1']) } as const
    let done = withDiscards(scope, async () => false)
    await reply('dontSave')
    expect(await done).toBe(false)
    expect(unsavedEntry('s1', 'a.ts')).toMatchObject({ doc: a, aside: null })
    expect(a.closing).toBe(false)
    expect(m.closing).toEqual([true, false])
    expect(fileTabsOf('s1').tabs.map((t) => ({ path: t.path, mode: t.mode, pinned: t.pinned }))).toEqual([{ path: 'a.ts', mode: 'file', pinned: true }])
    // a rejection is the action not happening
    done = withDiscards(scope, () => Promise.reject(new Error('refused')))
    await reply('dontSave')
    expect(await done).toBe(false)
    expect(unsavedEntry('s1', 'a.ts')?.aside).toBeNull()
    // Cancel on the second file: the first, already answered, is given back and the action never runs
    const b = unsaved('s1', 'b.ts')
    const action = vi.fn(async () => true)
    done = withDiscards(scope, action)
    expect(await reply('dontSave')).toBe('s1/a.ts')
    expect(a.closing).toBe(true)
    expect(await reply('cancel')).toBe('s1/b.ts')
    expect(await done).toBe(false)
    expect(action).not.toHaveBeenCalled()
    expect([a.closing, b.closing]).toEqual([false, false])
    expect(unsavedEntries().map((e) => e.aside)).toEqual([null, null])
    expect(m.discarded).toEqual([])
  })

  it('U-FV-24 · withDiscards refuses to start while Kea’s core is disconnected and says so; with nothing unsaved in its scope the action runs as it is', async () => {
    unsaved('s1', 'a.ts')
    core(false)
    const action = vi.fn(async () => true)
    expect(await withDiscards({ kind: 'window' }, action)).toBe(false)
    expect(action).not.toHaveBeenCalled()
    expect(reviewView.ask).toBeNull()
    expect(m.toasts.map((t) => t.message)).toEqual(['Kea’s core is restarting: nothing was closed. Try again once it is back.'])
    expect(isUnsaved('s1', 'a.ts')).toBe(true)
    // nothing of s2 is unsaved: nothing to ask, and the action's own outcome
    expect(await withDiscards({ kind: 'sessions', ids: new Set(['s2']) }, action)).toBe(true)
    expect(await withDiscards({ kind: 'sessions', ids: new Set(['s2']) }, () => Promise.reject(new Error('refused')))).toBe(false)
    // back: it asks
    core(true)
    const done = withDiscards({ kind: 'window' }, action)
    await reply('dontSave')
    expect(await done).toBe(true)
    expect(isUnsaved('s1', 'a.ts')).toBe(false)
  })

  it('U-FV-24 · a document set aside while its action runs is unsaved to any other review: a quit meanwhile asks about it again, offering Copy All, not Save', async () => {
    const a = unsaved('s1', 'a.ts')
    const deleting = deferred<boolean>()
    const done = withDiscards({ kind: 'sessions', ids: new Set(['s1']) }, () => deleting.promise)
    await reply('dontSave')
    await until(() => a.closing, 'the document set aside')
    const handed: string[] = []
    const quit = reviewUnsaved({ kind: 'window' }, (e) => handed.push(e.path))
    // its Save would do nothing while it is set aside: Copy All is offered instead
    expect((await asked()).cannotSave).toBe('It is being closed')
    expect(await reply('dontSave')).toBe('s1/a.ts')
    expect(await quit).toBe(true)
    expect(handed).toEqual(['a.ts'])
    deleting.resolve(false)
    expect(await done).toBe(false)
    expect(unsavedEntry('s1', 'a.ts')).toMatchObject({ doc: a, aside: null })
  })

  it('U-FV-24 · closing a tab asks only when its file has unsaved changes: Don’t Save drops the text and closes, Cancel keeps both', async () => {
    let closed = 0
    await closeAsking('s1', 'clean.ts', () => closed++)
    expect(closed).toBe(1)
    expect(reviewView.ask).toBeNull()
    unsaved('s1', 'a.ts')
    let done = closeAsking('s1', 'a.ts', () => closed++)
    await reply('cancel')
    await done
    expect(closed).toBe(1)
    expect(isUnsaved('s1', 'a.ts')).toBe(true)
    done = closeAsking('s1', 'a.ts', () => closed++)
    await reply('dontSave')
    await done
    expect(closed).toBe(2)
    expect(m.discarded).toEqual(['s1/a.ts'])
    expect(isUnsaved('s1', 'a.ts')).toBe(false)
  })

  it('U-FV-24 · Trash and Discard Changes name the unsaved changes they lose and drop them; files of a gone session are named in a toast', () => {
    unsaved('s1', 'src/login.ts')
    expect(lostLine('s1', 'src/login.ts')).toBe('Your unsaved changes to login.ts will be lost.')
    expect(lostLine('s1', 'src')).toBe('Your unsaved changes to login.ts will be lost.')
    unsaved('s1', 'src/sub/b.ts')
    expect(lostLine('s1', 'src')).toBe('Your unsaved changes to 2 files will be lost.')
    expect(lostLine('s1', 'srcx')).toBeNull()
    expect(lostLine('s2', 'src')).toBeNull()
    fileTabsState.bySession = new Map([['s1', { tabs: [{ id: 'file:src/login.ts', path: 'src/login.ts', mode: 'file', pinned: true, seen: 1, view: { scroll: null, selection: null, folds: [] }, goto: null }], seq: 1 }]])
    dropUnsavedUnder('s1', 'src', true)
    expect(unsavedEntries()).toEqual([])
    expect(fileTabsOf('s1').tabs).toEqual([])
    // orphans: one is named with Copy, several with Review
    unsaved('s2', 'one.ts', 'x\ny', 'crlf')
    orphanUnsavedFiles((id) => id === 's1')
    expect(m.toasts.map((t) => [t.message, t.action?.label])).toEqual([['one.ts had unsaved changes in a session that is gone', 'Copy']])
    unsaved('s3', 'two.ts')
    unsaved('s3', 'three.ts')
    orphanUnsavedFiles((id) => id === 's1')
    expect(m.toasts.map((t) => [t.message, t.action?.label])[1]).toEqual(['2 files had unsaved changes in sessions that are gone', 'Review'])
  })
})

describe('main’s requests', () => {
  const host = (): ReviewHost => m.host as ReviewHost

  it('U-FV-24 · a request is reviewed and answered proceed; every document is read-only until the last ticket settles; went: false gives the documents back, went: true drops them', async () => {
    const a = unsaved('s1', 'a.ts')
    const b = unsaved('s2', 'b.ts')
    host().review(1, 'quit')
    await reply('dontSave')
    await reply('dontSave')
    await until(() => m.answers.length === 1, 'the answer')
    expect(m.answers).toEqual([[1, 'proceed']])
    expect(windowGoing()).toBe(true)
    expect(m.stateChanged).toBe(1)
    expect(unsavedEntries().map((e) => e.aside)).toEqual(['main:1', 'main:1'])
    // main counted this window as proceeding for another request too: two tickets out
    host().decided(2, 'proceed')
    host().closeDone(1, false)
    expect(unsavedEntries().map((e) => e.aside)).toEqual([null, null])
    expect([a.closing, b.closing]).toEqual([false, false])
    expect(windowGoing()).toBe(true)
    host().closeDone(2, false)
    expect(windowGoing()).toBe(false)
    // a ticket settles once
    host().closeDone(2, true)
    expect(m.discarded).toEqual([])
    // the next request goes ahead: its documents are dropped
    host().review(3, 'close')
    await reply('dontSave')
    await reply('dontSave')
    await until(() => m.answers.length === 2, 'the answer')
    host().closeDone(3, true)
    expect(m.discarded.sort()).toEqual(['s1/a.ts', 's2/b.ts'])
    expect(unsavedEntries()).toEqual([])
    expect(windowGoing()).toBe(false)
  })

  it('U-FV-24 · Cancel answers cancel and gives back what the review set aside; a review that breaks answers cancel too', async () => {
    const a = unsaved('s1', 'a.ts')
    unsaved('s1', 'b.ts')
    host().review(4, 'quit')
    await reply('dontSave')
    await reply('cancel')
    await until(() => m.answers.length === 1, 'the answer')
    expect(m.answers).toEqual([[4, 'cancel']])
    expect(windowGoing()).toBe(false)
    expect([a.closing, unsavedEntry('s1', 'a.ts')?.aside]).toEqual([false, null])
    // a save that throws inside the review
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    m.save = () => Promise.reject(new Error('broken'))
    host().review(5, 'reload')
    await reply('dontSave')
    await reply('save')
    await until(() => m.answers.length === 2, 'the answer')
    expect(m.answers[1]).toEqual([5, 'cancel'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(unsavedEntries().map((e) => e.aside)).toEqual([null, null])
    expect(windowGoing()).toBe(false)
    warn.mockRestore()
  })

  it('U-FV-24 · main deciding cancel while the window reviews closes the warning, gives back what was set aside and sends no answer', async () => {
    const a = unsaved('s1', 'a.ts')
    unsaved('s1', 'b.ts')
    host().review(6, 'quit')
    await reply('dontSave')
    await asked()
    expect(a.closing).toBe(true)
    host().decided(6, 'cancel')
    expect(reviewView.ask).toBeNull()
    await until(() => !a.closing, 'the document given back')
    expect(unsavedEntries().map((e) => e.aside)).toEqual([null, null])
    expect(m.answers).toEqual([])
    expect(windowGoing()).toBe(false)
  })

  it('U-FV-24 · main is told the unsaved count on each change; the low-memory banner shows only while there are unsaved files; a rebuilt window is given them', () => {
    expect(host().giveDocuments()).toBeNull()
    unsaved('s1', 'a.ts')
    expect(m.counts.at(-1)).toBe(1)
    unsaved('s2', 'b.ts')
    fileTabsState.shown = { sessionId: 's2', path: 'b.ts', mode: 'file' }
    expect(host().giveDocuments()).toEqual({ documents: [{ path: 'a.ts', active: false }, { path: 'b.ts', active: true }] })
    host().lowMemory()
    expect(reviewView.lowMemory).toBe(true)
    dropUnsaved('s1', 'a.ts')
    expect(reviewView.lowMemory).toBe(true)
    dropUnsaved('s2', 'b.ts')
    expect(m.counts.slice(-3)).toEqual([2, 1, 0])
    expect(reviewView.lowMemory).toBe(false)
    host().lowMemory()
    expect(reviewView.lowMemory).toBe(false)
  })
})
