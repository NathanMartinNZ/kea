// The window's registry of unsaved documents: what is in it, its caps, its keys as files move, orphans, documents set
// aside by Don't Save, and what the window draws from it. Documents are built by hand (a state and a save state).
import { EditorState, Text } from '@codemirror/state'
import { L } from '@kea/protocol/limits'
import { afterEach, describe, expect, it } from 'vitest'
import { hasUnsaved, type FileDocument } from './document.ts'
import { marks, setMarks } from './marks.ts'
import { textStats, viewPolicy } from './policy.ts'
import { DocSave } from './saving.ts'
import {
  asideFor,
  capReason,
  dropUnsaved,
  isUnsaved,
  moveUnsaved,
  onUnsavedCount,
  orphanUnsaved,
  setAside,
  setHistoryWeigher,
  setWindowGoing,
  trackUnsaved,
  unsavedBytes,
  unsavedCount,
  unsavedDoc,
  unsavedEntries,
  unsavedEntry,
  unsavedKey,
  unsavedStats,
  unsavedView,
  windowGoing,
} from './unsaved.svelte.ts'

/** A file document read as `base`; `now`, when given, is what the user has typed since (dirty). */
function fileDoc(base: string, now?: string): FileDocument {
  const lines = base.split('\n')
  const save = new DocSave(Text.of(lines), { version: 'v1', eol: 'lf', encoding: 'utf8', bom: false, mode: 0o644 })
  const state = EditorState.create({ doc: now ?? base })
  if (now !== undefined) save.edited(state.doc)
  return {
    state,
    store: null,
    policy: viewPolicy(textStats(base.length, lines)),
    lang: null,
    eol: 'lf',
    encoding: 'utf8',
    invalid: false,
    size: base.length,
    link: null,
    changes: null,
    longest: 0,
    tokenised: -1,
    stoppedAt: null,
    bytes: base.length,
    save,
    readOnly: null,
    unwritable: null,
    notText: null,
    pendingDisk: null,
    closing: false,
    colours: null,
  }
}

/** The user undoes back to the file's text. */
function undoAll(doc: FileDocument): void {
  doc.state = EditorState.create({ doc: doc.save?.base ?? '' })
  doc.save?.edited(doc.state.doc)
}

const dirty = (sessionId: string, path: string, base = 'a', now = 'ab'): FileDocument => {
  const doc = fileDoc(base, now)
  trackUnsaved(sessionId, path, doc)
  return doc
}

afterEach(() => {
  for (const e of unsavedEntries()) dropUnsaved(e.sessionId, e.path)
  setHistoryWeigher(() => 0)
  onUnsavedCount(null)
  setWindowGoing(false)
})

describe('the unsaved registry', () => {
  it('U-FV-24 · a document is in the registry while it has unsaved text (dirty, saving, failed) and leaves when it is saved or undone back', () => {
    const doc = fileDoc('a')
    trackUnsaved('s1', 'a.ts', doc)
    expect(isUnsaved('s1', 'a.ts')).toBe(false)
    doc.state = EditorState.create({ doc: 'ab' })
    doc.save?.edited(doc.state.doc)
    trackUnsaved('s1', 'a.ts', doc)
    expect(isUnsaved('s1', 'a.ts')).toBe(true)
    expect(unsavedDoc('s1', 'a.ts')).toBe(doc)
    // a save in flight keeps it; the answer settles it
    const call = doc.save?.begin(doc.state.doc)
    expect(doc.save?.phase).toBe('saving')
    trackUnsaved('s1', 'a.ts', doc)
    expect(unsavedStats()).toMatchObject({ docs: 1, saving: 1 })
    doc.save?.settle(call?.id ?? 0, { kind: 'refused', reason: 'permission' }, doc.state.doc)
    trackUnsaved('s1', 'a.ts', doc)
    expect(doc.save?.phase).toBe('failed')
    expect(isUnsaved('s1', 'a.ts')).toBe(true)
    expect(unsavedStats().saving).toBe(0)
    // undone back to the file's text: nothing is unsaved
    undoAll(doc)
    trackUnsaved('s1', 'a.ts', doc)
    expect(isUnsaved('s1', 'a.ts')).toBe(false)
    expect(unsavedCount()).toBe(0)
  })

  it('U-FV-24 · a document with a marked place is unsaved even when its text is the file’s again, so a later change of the file is merged with it, never read over it', () => {
    const doc = fileDoc('a\nb')
    doc.state = EditorState.create({ doc: 'a\nb', extensions: marks() }).update({ effects: setMarks.of([{ doc: { from: 2, to: 3 }, base: { from: 2, to: 3 } }]) }).state
    doc.save?.edited(doc.state.doc)
    expect(doc.save?.phase).toBe('clean')
    expect(hasUnsaved(doc)).toBe(true)
    trackUnsaved('s1', 'a.ts', doc)
    expect(isUnsaved('s1', 'a.ts')).toBe(true)
  })

  it('U-FV-24 · another document of the same file does not take the entry unless it has unsaved text; a new one keeps the orphan and aside marks', () => {
    const doc = dirty('s1', 'a.ts')
    // a clean read of the same file (another document object) leaves the user's text alone
    trackUnsaved('s1', 'a.ts', fileDoc('a'))
    expect(unsavedDoc('s1', 'a.ts')).toBe(doc)
    setAside('s1', 'a.ts', 'local:1')
    orphanUnsaved((id) => id !== 's1')
    const next = fileDoc('a', 'abc')
    trackUnsaved('s1', 'a.ts', next)
    expect(unsavedEntry('s1', 'a.ts')).toMatchObject({ doc: next, orphan: true, aside: 'local:1' })
    // set aside, a document stays in the registry even with nothing left unsaved: it is still to be dropped or given back
    next.closing = true
    undoAll(next)
    trackUnsaved('s1', 'a.ts', next)
    expect(isUnsaved('s1', 'a.ts')).toBe(true)
  })

  it('U-FV-24 · the caps: at L.viewerUnsavedMax documents one more file opens read-only, documents in the registry stay editable, and set-aside documents count', () => {
    for (let i = 1; i < L.viewerUnsavedMax; i++) dirty('s1', `f${i}.ts`)
    expect(capReason('s1', 'new.ts')).toBeNull()
    dirty('s2', 'last.ts')
    expect(unsavedCount()).toBe(L.viewerUnsavedMax)
    expect(capReason('s1', 'new.ts')).toBe(`${L.viewerUnsavedMax} files have unsaved changes`)
    expect(capReason('s1', 'f1.ts')).toBeNull()
    expect(capReason('s2', 'last.ts')).toBeNull()
    // Don't Save for an action that has not happened yet: the document still counts
    setAside('s1', 'f1.ts', 'local:1')
    expect(capReason('s1', 'new.ts')).not.toBeNull()
    dropUnsaved('s1', 'f1.ts')
    expect(capReason('s1', 'new.ts')).toBeNull()
  })

  it('U-FV-24 · the byte cap counts each document’s text, its last saved text and its undo history’s estimate', () => {
    const doc = dirty('s1', 'a.ts', 'abc', 'abcd')
    setHistoryWeigher((d) => (d === doc ? 10 : 0))
    expect(unsavedBytes()).toBe(3 + 4 + 10)
    expect(unsavedStats()).toEqual({ docs: 1, bytes: 17, saving: 0 })
    // a quarter of the cap each (text, last saved text and history together): the fourth closes the registry
    const quarter = L.viewerUnsavedBytes / 4
    const heavy = new Set<FileDocument>()
    setHistoryWeigher((d) => (heavy.has(d) ? quarter : 0))
    dropUnsaved('s1', 'a.ts')
    for (let i = 1; i <= 3; i++) heavy.add(dirty('s1', `big${i}.ts`))
    expect(capReason('s1', 'new.ts')).toBeNull()
    heavy.add(dirty('s1', 'big4.ts'))
    expect(unsavedBytes()).toBeGreaterThanOrEqual(L.viewerUnsavedBytes)
    expect(capReason('s1', 'new.ts')).toBe('4 files have unsaved changes')
    expect(capReason('s1', 'big4.ts')).toBeNull()
  })

  it('U-FV-24 · a file moved or renamed takes its document to the new path, every file under a moved folder too; other sessions’ stay', () => {
    const a = dirty('s1', 'src/a.ts')
    const b = dirty('s1', 'src/sub/b.ts')
    const other = dirty('s1', 'srcx.ts')
    const elsewhere = dirty('s2', 'src/a.ts')
    setAside('s1', 'src/a.ts', 'local:1')
    moveUnsaved('s1', (p) => (p === 'src' || p.startsWith('src/') ? `lib${p.slice(3)}` : p))
    expect(unsavedDoc('s1', 'lib/a.ts')).toBe(a)
    expect(unsavedDoc('s1', 'lib/sub/b.ts')).toBe(b)
    expect(unsavedDoc('s1', 'srcx.ts')).toBe(other)
    expect(unsavedDoc('s2', 'src/a.ts')).toBe(elsewhere)
    expect(isUnsaved('s1', 'src/a.ts')).toBe(false)
    expect(unsavedEntry('s1', 'lib/a.ts')).toMatchObject({ path: 'lib/a.ts', aside: 'local:1' })
    expect([...unsavedView.files].sort()).toEqual([unsavedKey('s1', 'lib/a.ts'), unsavedKey('s1', 'lib/sub/b.ts'), unsavedKey('s1', 'srcx.ts'), unsavedKey('s2', 'src/a.ts')].sort())
    // a single file renamed
    moveUnsaved('s1', (p) => (p === 'srcx.ts' ? 'renamed.ts' : p))
    expect(unsavedDoc('s1', 'renamed.ts')).toBe(other)
    expect(unsavedCount()).toBe(4)
  })

  it('U-FV-24 · a session that is gone leaves its documents as orphans: kept and counted, named once, and no longer the sidebar’s', () => {
    dirty('s1', 'a.ts')
    dirty('s2', 'b.ts')
    dirty('s2', 'c.ts')
    expect([...unsavedView.sessions].sort()).toEqual(['s1', 's2'])
    const gone = orphanUnsaved((id) => id === 's1')
    expect(gone.map((e) => e.path)).toEqual(['b.ts', 'c.ts'])
    expect(gone.every((e) => e.orphan)).toBe(true)
    expect(unsavedCount()).toBe(3)
    expect([...unsavedView.sessions]).toEqual(['s1'])
    expect(unsavedView.files.has(unsavedKey('s2', 'b.ts'))).toBe(true)
    // already orphans: not named again
    expect(orphanUnsaved((id) => id === 's1')).toEqual([])
  })

  it('U-FV-24 · Don’t Save sets a document aside for its action: closing, still in the registry, found by the action, and given back with null', () => {
    const a = dirty('s1', 'a.ts')
    const b = dirty('s1', 'b.ts')
    setAside('s1', 'a.ts', 'local:1')
    setAside('s1', 'b.ts', 'main:7')
    expect(a.closing).toBe(true)
    expect(asideFor('local:1').map((e) => e.doc)).toEqual([a])
    expect(asideFor('main:7').map((e) => e.doc)).toEqual([b])
    expect(asideFor('local:2')).toEqual([])
    expect(isUnsaved('s1', 'a.ts')).toBe(true)
    setAside('s1', 'a.ts', null)
    expect(a.closing).toBe(false)
    expect(unsavedEntry('s1', 'a.ts')?.aside).toBeNull()
    expect(asideFor('local:1')).toEqual([])
    // a file with nothing unsaved has nothing to set aside
    setAside('s1', 'none.ts', 'local:1')
    expect(asideFor('local:1')).toEqual([])
    // the window going (main's review answered) is the registry's to say
    setWindowGoing(true)
    expect(windowGoing()).toBe(true)
  })

  it('U-FV-24 · what the window draws follows the registry, changed only when it changes, and main is told the count on each change', () => {
    const told: number[] = []
    dirty('s0', 'early.ts')
    onUnsavedCount((n) => told.push(n))
    expect(told).toEqual([1])
    const a = dirty('s1', 'a.ts')
    expect(unsavedView.count).toBe(2)
    const sessions = unsavedView.sessions
    const files = unsavedView.files
    // the same document again: nothing changes, nothing is told
    trackUnsaved('s1', 'a.ts', a)
    expect(unsavedView.sessions).toBe(sessions)
    expect(unsavedView.files).toBe(files)
    // another file of a session already listed: the files change, the sessions do not
    dirty('s1', 'b.ts')
    expect(unsavedView.sessions).toBe(sessions)
    expect(unsavedView.files).not.toBe(files)
    expect([...unsavedView.files]).toEqual([unsavedKey('s0', 'early.ts'), unsavedKey('s1', 'a.ts'), unsavedKey('s1', 'b.ts')])
    dropUnsaved('s1', 'a.ts')
    dropUnsaved('s1', 'nothing.ts')
    expect(told).toEqual([1, 2, 3, 2])
    expect(unsavedView.count).toBe(2)
    expect(unsavedEntries().map((e) => e.path)).toEqual(['early.ts', 'b.ts'])
  })
})
