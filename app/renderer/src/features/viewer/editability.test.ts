// Which file documents can be edited, and why not: the rules a read and the window's state give, in the order the
// header names them, and the document's two configurations (editable, read-only), between which its text, selection
// and undo history stay. The controller is imported with the bridge, RPC and clipboard stood in for.
import { undo, undoDepth } from '@codemirror/commands'
import { EditorSelection, EditorState, Text, Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { RpcError, type FileRead, type TextBytes } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditingOptions } from './editing.ts'
import type { FileDocument } from './document.ts'

vi.mock('../../lib/bridge.ts', () => ({
  onRpcPort: () => () => {},
  coreConnected: () => false,
  onCoreConnection: () => () => {},
  setReviewHost: () => {},
  answerReview: () => {},
  setUnsavedCount: () => {},
  takeDocuments: async () => null,
  openExternal: () => {},
}))
const rpc = vi.hoisted(() => ({ call: vi.fn(async (): Promise<unknown> => null) }))
vi.mock('../../lib/rpc.ts', () => ({ call: rpc.call, callNow: () => null, subscribe: () => () => {}, onPortFirst: () => () => {} }))
vi.mock('../sessions/actions.ts', () => ({ copyText: async () => true }))

const { editableAtLoad, readOnlyAtLoad, readOnlyNow, saveUnsaved, sizeText, unwritableReason } = await import('./controller.svelte.ts')
const { fileState, isEditable, setEditable } = await import('./editor.ts')
const { textStats, viewPolicy } = await import('./policy.ts')
const { DocSave } = await import('./saving.ts')
const { EMPTY_VIEW } = await import('./tab.ts')
const { dropUnsaved, setAside, setWindowGoing, trackUnsaved, unsavedEntries } = await import('./unsaved.svelte.ts')

const EDIT: EditingOptions = { eol: 'lf', indent: '  ', aids: [], host: { unsaved: () => false, save: () => {} } }

/** The file view's editor as far as these rules need one: a state that takes transaction specs. */
class StandIn {
  state: EditorState
  constructor(state: EditorState) {
    this.state = state
  }
  dispatch = (spec: TransactionSpec | Transaction): void => {
    this.state = spec instanceof Transaction ? spec.state : this.state.update(spec).state
  }
}

function stateOf(text: string, edit: EditingOptions | null): EditorState {
  const lines = text.split('\n')
  return fileState({ path: 'src/a.ts', lines, eol: 'lf', policy: viewPolicy(textStats(text.length, lines)), store: null, wrap: false, changes: null, edit }, EMPTY_VIEW, null)
}

const read = (o: Partial<FileRead> = {}): FileRead => ({ kind: 'text', size: 10, mtimeMs: 0, link: null, text: null, image: null, openable: true, writable: 'yes', ...o })
const bytes = (o: Partial<TextBytes> = {}): TextBytes => ({ bytes: new Uint8Array(), encoding: 'utf8', invalid: false, eol: 'lf', ...o })

function fileDoc(o: Partial<FileDocument> = {}, unsaved = false): FileDocument {
  const save = new DocSave(Text.of(['a']), { version: 'v1', eol: 'lf', encoding: 'utf8', bom: false, mode: 0o644 })
  const state = EditorState.create({ doc: unsaved ? 'ab' : 'a' })
  save.edited(state.doc)
  return { state, store: null, policy: viewPolicy(textStats(1, ['a'])), lang: null, eol: 'lf', encoding: 'utf8', invalid: false, size: 1, link: null, changes: null, longest: 1, tokenised: -1, stoppedAt: null, bytes: 1, save, readOnly: null, unwritable: null, notText: null, pendingDisk: null, closing: false, colours: null, ...o }
}

afterEach(() => {
  for (const e of unsavedEntries()) dropUnsaved(e.sessionId, e.path)
  setWindowGoing(false)
})

describe('which documents are editable', () => {
  it('U-FV-20 · a file document is editable only with editing options; without them it is read-only', () => {
    expect(stateOf('a\nb', null).readOnly).toBe(true)
    expect(isEditable(stateOf('a\nb', null))).toBe(false)
    const s = stateOf('a\nb', EDIT)
    expect(s.readOnly).toBe(false)
    expect(isEditable(s)).toBe(true)
    // typing changes an editable document and is refused in a read-only one
    const typed = (st: EditorState) => st.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' }).state.doc.toString()
    expect(typed(s)).toBe('xa\nb')
    expect(typed(stateOf('a\nb', null))).toBe('a\nb')
  })

  it('U-FV-20 · the document switches between editable and read-only and back, keeping its text, its selection and its undo history', () => {
    const v = new StandIn(stateOf('one\ntwo', EDIT))
    v.dispatch(v.state.update({ changes: { from: 3, insert: '!' }, selection: EditorSelection.cursor(4), userEvent: 'input.type' }))
    expect(undoDepth(v.state)).toBe(1)
    setEditable(v as unknown as EditorView, null)
    expect(v.state.readOnly).toBe(true)
    expect(v.state.doc.toString()).toBe('one!\ntwo')
    expect(v.state.selection.main.head).toBe(4)
    expect(undoDepth(v.state)).toBe(1)
    // read-only: typing is refused and leaves the history alone
    v.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
    expect(v.state.doc.toString()).toBe('one!\ntwo')
    expect(undoDepth(v.state)).toBe(1)
    setEditable(v as unknown as EditorView, EDIT)
    expect(v.state.readOnly).toBe(false)
    expect(undoDepth(v.state)).toBe(1)
    expect(undo(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('one\ntwo')
  })

  it('U-FV-20 · at load: within the full-feature size, valid in its encoding and with one line ending; the reason names the first that fails', () => {
    expect(editableAtLoad(read(), bytes())).toBe(true)
    expect(editableAtLoad(read({ size: L.viewerFullBytes }), bytes())).toBe(true)
    expect(editableAtLoad(read({ size: L.viewerFullBytes + 1 }), bytes())).toBe(false)
    expect(editableAtLoad(read(), bytes({ invalid: true }))).toBe(false)
    expect(editableAtLoad(read(), bytes({ eol: 'mixed' }))).toBe(false)
    for (const eol of ['lf', 'crlf', 'cr'] as const) expect(editableAtLoad(read(), bytes({ eol }))).toBe(true)
    // in order: the size, then the encoding, then the line endings
    const big = { size: L.viewerFullBytes + 1, invalid: true, eol: 'mixed' as const, save: null }
    expect(readOnlyAtLoad(fileDoc(big))).toBe(`over ${sizeText(L.viewerFullBytes)}`)
    expect(readOnlyAtLoad(fileDoc({ ...big, size: 1 }))).toBe('not valid UTF-8')
    expect(readOnlyAtLoad(fileDoc({ ...big, size: 1, encoding: 'utf16le' }))).toBe('not valid UTF-16')
    expect(readOnlyAtLoad(fileDoc({ ...big, size: 1, invalid: false }))).toBe('mixed line endings')
    expect(readOnlyAtLoad(fileDoc({ save: null }))).toBeNull()
  })

  it('U-FV-20 · whether the file can be written back, as the read says', () => {
    expect(unwritableReason(read({ writable: 'yes' }))).toBeNull()
    expect(unwritableReason(read({ writable: 'permission' }))).toBe('no permission')
    expect(unwritableReason(read({ writable: 'git' }))).toBe('inside .git')
    expect(unwritableReason(read({ writable: 'hard-linked' }))).toBe('hard-linked')
    // a read that does not say is not taken as writable
    const { writable: _, ...unsaid } = read()
    expect(unwritableReason(unsaid)).toBe('no permission')
  })

  it('U-FV-20 · now: closing first, then a file that is no longer text, then one that cannot be written back, then the registry’s caps', () => {
    const doc = fileDoc({ closing: true, notText: 'a binary file', unwritable: 'no permission' })
    for (let i = 0; i < L.viewerUnsavedMax; i++) trackUnsaved('s1', `f${i}.ts`, fileDoc({}, true))
    const cap = `${L.viewerUnsavedMax} files have unsaved changes`
    expect(readOnlyNow(doc, 's1', 'a.ts')).toBe('Closing…')
    doc.closing = false
    expect(readOnlyNow(doc, 's1', 'a.ts')).toBe('the file is now a binary file')
    doc.notText = null
    expect(readOnlyNow(doc, 's1', 'a.ts')).toBe('no permission')
    doc.unwritable = null
    expect(readOnlyNow(doc, 's1', 'a.ts')).toBe(cap)
    // a document already in the registry stays editable at the cap
    expect(readOnlyNow(fileDoc({}, true), 's1', 'f0.ts')).toBeNull()
    // the window going (main's review answered): every document, the registry's own included
    setWindowGoing(true)
    expect(readOnlyNow(fileDoc({}, true), 's1', 'f0.ts')).toBe('Closing…')
    setWindowGoing(false)
    // set aside by Don't Save: closing, and still counted
    setAside('s1', 'f0.ts', 'local:1')
    expect(unsavedEntries()[0]?.doc.closing).toBe(true)
    expect(readOnlyNow(doc, 's1', 'a.ts')).toBe(cap)
    dropUnsaved('s1', 'f1.ts')
    expect(readOnlyNow(doc, 's1', 'a.ts')).toBeNull()
  })
})

describe('a save that fails', () => {
  it('U-FV-23 · a save core does not take says so in plain words, never the error it was refused with', async () => {
    rpc.call.mockRejectedValueOnce(new RpcError('invalid_args', 'viewer.save: [ { "origin": "string", "code": "invalid_format" } ]'))
    const doc = fileDoc({}, true)
    await saveUnsaved('s1', 'a.ts', doc)
    expect(doc.save?.phase).toBe('failed')
    expect(doc.save?.failure).toBe('Kea’s core could not save it')
    rpc.call.mockRejectedValueOnce(new RpcError('closed', 'connection closed'))
    await saveUnsaved('s1', 'a.ts', doc)
    expect(doc.save?.failure).toBe('Kea’s core restarted')
  })
})

describe('a save asked for while one is out', () => {
  it('U-FV-23 · ends once the save out and the one queued after it have settled, so the warning’s Save sees the document saved', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const secondSent = deferred<void>()
    rpc.call
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => {
        secondSent.resolve()
        return second.promise
      })
    const doc = fileDoc({}, true)
    const out = saveUnsaved('s1', 'a.ts', doc)
    expect(doc.save?.phase).toBe('saving')
    // the user types on while it is out, then the warning's Save asks for the file to be saved
    const state = (doc.state as EditorState).update({ changes: { from: 2, insert: 'c' } }).state
    doc.state = state
    doc.save?.edited(state.doc)
    let settled = false
    const asked = saveUnsaved('s1', 'a.ts', doc).then(() => {
      settled = true
    })
    first.resolve({ kind: 'saved', version: 'v2' })
    await secondSent.promise
    expect(settled, 'not before the queued save has its answer').toBe(false)
    expect(doc.save?.phase).toBe('saving')
    second.resolve({ kind: 'saved', version: 'v3' })
    await asked
    expect(doc.save?.phase).toBe('clean')
    expect(doc.save?.base.toString()).toBe('abc')
    await out
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve = (_v: T) => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
