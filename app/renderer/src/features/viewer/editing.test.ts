// An editable document's keys and limits, at the level of the editor state: a stand-in view (a state and somewhere to
// send its transactions) runs the commands, so no DOM is needed. The find bar's part of Esc needs a real view and is
// left to the end-to-end suite.
import { defaultKeymap, insertNewlineAndIndent, isolateHistory, moveLineUp, simplifySelection, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, Text, Transaction } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { COMMANDS, chordText, parseShortcut, protocolOs, type KeyScope } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import { describe, expect, it } from 'vitest'
import { capSelection, codeMirrorChord, documentKeymap, editing, fileLineEnding, indentStringOf, insertIndent, setFileLineEnding, type EditingHost, type EditingOptions } from './editing.ts'
import { fileState } from './editor.ts'
import { undoHistory } from './history.ts'
import { textStats, viewPolicy } from './policy.ts'
import { fromDisk } from './readonly.ts'
import { saveText } from './saving.ts'
import { EMPTY_VIEW } from './tab.ts'

/** What a command needs of an editor: the state, and somewhere to send its transactions. */
class StandIn {
  state: EditorState
  constructor(state: EditorState) {
    this.state = state
  }
  // a field, not a method: CodeMirror's commands take it apart from the object
  dispatch = (tr: Transaction): void => {
    this.state = tr.state
  }
}
const run = (cmd: (v: EditorView) => boolean, v: StandIn): boolean => cmd(v as unknown as EditorView)

const host = (unsaved = false): EditingHost => ({ unsaved: () => unsaved, save: () => {} })

/** An editable document as the viewer builds one. */
function editable(doc: string, o: { indent?: string; unsaved?: boolean; selection?: EditorSelection } = {}): StandIn {
  return new StandIn(EditorState.create({ doc, ...(o.selection ? { selection: o.selection } : {}), extensions: editing({ eol: 'lf', indent: o.indent ?? '  ', aids: [], host: host(o.unsaved) }) }))
}

/** Every key binding of a state, in precedence order. */
const bindingsOf = (state: EditorState): KeyBinding[] => state.facet(keymap).flat()
const named = (b: KeyBinding): string[] => [b.key, b.mac, b.linux].filter((k): k is string => k !== undefined)

/** CodeMirror's keys that Kea's own commands own. */
const KEAS = ['Alt-ArrowUp', 'Alt-ArrowDown', 'Escape', 'Mod-Enter', 'Mod-i', 'Mod-[', 'Mod-]']

/** The key scopes the keyboard can be in while it is in a file document; the others' keys are never the router's there. */
const DOCUMENT_SCOPES: readonly (KeyScope | undefined)[] = [undefined, 'viewer tab', 'file tab', 'Markdown file', 'editable file']

/** The Linux chords of the command table, with the commands (and scopes) that bind them. */
function linuxTable(): Map<string, { id: string; scope: KeyScope | undefined }[]> {
  const out = new Map<string, { id: string; scope: KeyScope | undefined }[]>()
  for (const def of COMMANDS)
    for (const k of def.linuxKeys ?? []) {
      const c = parseShortcut(k)
      if (!c) continue
      const chord = chordText(c)
      out.set(chord, [...(out.get(chord) ?? []), { id: def.id, scope: def.keyScope }])
    }
  return out
}

describe('the editable document', () => {
  it('U-FV-25 · the document keymap leaves Kea’s own keys alone: change stepping, Open in Editor, Indent Less / More and Esc', () => {
    for (const onLinux of [false, true]) {
      const kept = documentKeymap(onLinux)
      for (const b of kept) for (const k of named(b)) expect(KEAS, `${k} on ${onLinux ? 'Linux' : 'macOS'}`).not.toContain(k)
    }
    // on macOS nothing else of CodeMirror's is left out
    const kept = new Set(documentKeymap(false))
    expect(defaultKeymap.filter((b) => !kept.has(b)).map((b) => b.key)).toEqual(KEAS)
  })

  it('U-FV-25 · on Linux every defaultKeymap chord is checked against the command table: one the router takes in a file document is left out, one of another context stays', () => {
    const table = linuxTable()
    const kept = new Set(documentKeymap(true))
    const dropped: string[] = []
    const keptInTable: string[] = []
    for (const b of defaultKeymap) {
      const name = b.linux ?? b.key
      if (name === undefined) {
        // a macOS-only binding (Emacs keys, ⌘←): Linux has no such key
        expect(kept.has(b), String(b.mac)).toBe(true)
        continue
      }
      const chords = [codeMirrorChord(name, false), b.shift ? codeMirrorChord(`Shift-${name}`, false) : null].filter((c): c is string => c !== null)
      const rows = chords.flatMap((c) => table.get(c) ?? [])
      const routers = rows.filter((r) => DOCUMENT_SCOPES.includes(r.scope))
      const keas = KEAS.includes(name) || (b.key !== undefined && KEAS.includes(b.key))
      expect.soft(kept.has(b), `${name} (${chords.join(', ')}: ${rows.map((r) => r.id).join(', ') || 'no command'})`).toBe(!keas && routers.length === 0)
      if (!kept.has(b)) dropped.push(`${name} ${routers.map((r) => r.id).join(' ')}`.trim())
      else if (rows.length > 0) keptInTable.push(`${name} ${rows.map((r) => `${r.id} [${r.scope}]`).join(' ')}`)
    }
    expect(dropped).toEqual([
      'Alt-ArrowUp viewer.previousChange',
      'Alt-ArrowDown viewer.nextChange',
      'Escape',
      'Mod-Enter',
      'Mod-i',
      'Mod-[ viewer.indentLess',
      'Mod-] viewer.indentMore',
      'Shift-Mod-k terminal.clear',
    ])
    // keys of a context the document is never in: ↵ is a newline with its indentation, Delete deletes at every cursor
    expect(keptInTable).toEqual(['Shift-Mod-\\ viewer.toggleDiffLayout [diff tab]', 'Enter session.resume [detached overlay]', 'Delete files.trash [file panel]'])
  })

  it('U-FV-25 · ↵ is a newline with its line’s indentation in an editable document on both systems, and the tab strip’s (it pins a preview) in a read-only one', () => {
    const enter = (bs: readonly KeyBinding[]) => bs.filter((b) => b.key === 'Enter').map((b) => b.run)
    expect(enter(documentKeymap(false))).toEqual([insertNewlineAndIndent])
    expect(enter(documentKeymap(true))).toEqual([insertNewlineAndIndent])
    const lines = ['if (a) {', '  b', '}']
    const of = (edit: EditingOptions | null) => fileState({ path: 'a.ts', lines, eol: 'lf', policy: viewPolicy(textStats(16, lines)), store: null, wrap: false, changes: null, edit }, EMPTY_VIEW, { line: 2, col: 4 })
    expect(enter(bindingsOf(of(null)))).toEqual([])
    const v = new StandIn(of({ eol: 'lf', indent: '  ', aids: [], host: host() }))
    expect(enter(bindingsOf(v.state))).toEqual([insertNewlineAndIndent])
    insertNewlineAndIndent(v)
    expect(v.state.doc.toString()).toBe('if (a) {\n  b\n  \n}')
  })

  it('U-FV-25 · a CodeMirror key name as the key router writes the chord', () => {
    expect(codeMirrorChord('Mod-s', true)).toBe('cmd+s')
    expect(codeMirrorChord('Mod-s', false)).toBe('ctrl+s')
    expect(codeMirrorChord('Shift-Mod-k', false)).toBe('ctrl+shift+k')
    expect(codeMirrorChord('Ctrl-Cmd-ArrowUp', true)).toBe('cmd+ctrl+up')
    expect(codeMirrorChord('Meta-Control-Alt-x', false)).toBe('cmd+ctrl+alt+x')
    // an upper-case letter is typed with Shift
    expect(codeMirrorChord('Alt-A', false)).toBe('alt+shift+a')
    expect(codeMirrorChord('Mod-[', false)).toBe('ctrl+[')
    expect(codeMirrorChord('Mod--', false)).toBe('ctrl+-')
    expect(codeMirrorChord('Enter', false)).toBe('enter')
    expect(codeMirrorChord('Shift-Delete', false)).toBe('shift+delete')
    expect(codeMirrorChord('Space', false)).toBe('space')
    expect(codeMirrorChord('PageDown', false)).toBe('pagedown')
    // what the router has no name for
    expect(codeMirrorChord('Hyper-a', false)).toBeNull()
    expect(codeMirrorChord('F13', false)).toBeNull()
  })

  it('U-FV-25 · Tab puts one indent unit at each cursor with nothing selected and indents the selected lines otherwise; ⇧Tab outdents', () => {
    const tab = bindingsOf(editable('').state).find((b) => b.key === 'Tab') as KeyBinding
    expect(tab.run).toBe(insertIndent)
    // a cursor in the middle of a line: the unit is typed there, not at the line's start
    let v = editable('ab\ncd', { selection: EditorSelection.single(1) })
    expect(run(insertIndent, v)).toBe(true)
    expect(v.state.doc.toString()).toBe('a  b\ncd')
    expect(v.state.selection.main.head).toBe(3)
    // a cursor on each line: each gets one
    v = editable('ab\ncd', { indent: '\t', selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(5)]) })
    run(insertIndent, v)
    expect(v.state.doc.toString()).toBe('ab\t\ncd\t')
    // a selection over two lines: both lines are indented, their text untouched
    v = editable('ab\ncd\nef', { selection: EditorSelection.single(1, 4) })
    run(insertIndent, v)
    expect(v.state.doc.toString()).toBe('  ab\n  cd\nef')
    run(tab.shift as (v: EditorView) => boolean, v)
    expect(v.state.doc.toString()).toBe('ab\ncd\nef')
    // a read-only state is left alone
    const ro = new StandIn(EditorState.create({ doc: 'ab', extensions: EditorState.readOnly.of(true) }))
    expect(run(insertIndent, ro)).toBe(false)
    expect(ro.state.doc.toString()).toBe('ab')
  })

  it('U-FV-25 · Esc collapses several cursors; with one it is the strip’s (the tab closes) unless the file has unsaved changes, when it does nothing more', () => {
    const escOf = (v: StandIn) => {
      const all = bindingsOf(v.state).filter((b) => b.key === 'Escape')
      expect(all).toHaveLength(1)
      return all[0]?.run as (v: EditorView) => boolean
    }
    const cursors = EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3), EditorSelection.cursor(6)], 1)
    const many = editable('ab\ncd\nef', { selection: cursors })
    expect(run(escOf(many), many)).toBe(true)
    expect(many.state.selection.ranges.map((r) => r.head)).toEqual([3])
    // the same as CodeMirror's own
    const again = editable('ab\ncd\nef', { selection: cursors })
    run(simplifySelection as (v: EditorView) => boolean, again)
    expect(again.state.selection.eq(many.state.selection)).toBe(true)
    // one cursor, nothing unsaved: not handled, so the strip closes the tab
    const clean = editable('ab', { selection: EditorSelection.single(1) })
    expect(run(escOf(clean), clean)).toBe(false)
    // one cursor, unsaved changes: handled and nothing happens (no warning, no close)
    const dirty = editable('ab', { unsaved: true, selection: EditorSelection.single(1) })
    expect(run(escOf(dirty), dirty)).toBe(true)
    expect(dirty.state.doc.toString()).toBe('ab')
    expect(dirty.state.selection.main.head).toBe(1)
  })

  it('U-FV-25 · ⌥↑ / ⌥↓ are not the document’s (they step through the changes); the move-line keys move the line', () => {
    const v = editable('one\ntwo\nthree', { selection: EditorSelection.single(5) })
    const all = bindingsOf(v.state)
    for (const k of ['Alt-ArrowUp', 'Alt-ArrowDown']) expect(all.filter((b) => named(b).includes(k)), k).toEqual([])
    const up = protocolOs.system === 'linux' ? 'Ctrl-Alt-ArrowUp' : 'Ctrl-Cmd-ArrowUp'
    const move = all.find((b) => b.key === up)
    expect(move?.run).toBe(moveLineUp)
    run(move?.run as (v: EditorView) => boolean, v)
    expect(v.state.doc.toString()).toBe('two\none\nthree')
  })

  it('U-FV-25 · at most L.viewerCursorMax selection ranges: the main one and the nearest are kept', () => {
    const at = (...heads: number[]) => heads.map((h) => EditorSelection.cursor(h))
    expect(capSelection(at(0, 10, 20), 1, 3)).toBeNull()
    const capped = capSelection(at(0, 10, 20, 30, 40), 2, 3) as EditorSelection
    expect(capped.ranges.map((r) => r.head)).toEqual([10, 20, 30])
    expect(capped.main.head).toBe(20)
    const end = capSelection(at(0, 10, 20, 30, 40), 4, 2) as EditorSelection
    expect(end.ranges.map((r) => r.head)).toEqual([30, 40])
    expect(end.main.head).toBe(40)
    // in the document: a selection with more ranges than the cap keeps the cap's worth around its main range
    const n = L.viewerCursorMax + 10
    const v = editable('x'.repeat(n * 2))
    const ranges = Array.from({ length: n }, (_, i) => EditorSelection.cursor(i * 2))
    v.dispatch(v.state.update({ selection: EditorSelection.create(ranges, n - 1) }))
    expect(v.state.selection.ranges).toHaveLength(L.viewerCursorMax)
    expect(v.state.selection.main.head).toBe((n - 1) * 2)
    expect(v.state.selection.ranges[0]?.head).toBe((n - L.viewerCursorMax) * 2)
  })

  it('U-FV-24 · typing and pasting stop at L.viewerEditMaxChars; deleting, the file’s own text and an undo past it go through, and the text still saves', () => {
    const cap = L.viewerEditMaxChars
    const v = new StandIn(EditorState.create({ doc: 'x'.repeat(cap - 1), extensions: [editing({ eol: 'lf', indent: '  ', aids: [], host: host() }), undoHistory()] }))
    // each change its own undo step
    const type = (from: number, to: number, insert: string) => v.dispatch(v.state.update({ changes: { from, to, insert }, userEvent: 'input.type', annotations: isolateHistory.of('full') }))
    type(0, 0, 'ab')
    expect(v.state.doc.length).toBe(cap - 1)
    v.dispatch(v.state.update({ changes: { from: 0, insert: 'pasted' }, userEvent: 'input.paste' }))
    expect(v.state.doc.length).toBe(cap - 1)
    type(0, 0, 'a')
    expect(v.state.doc.length).toBe(cap)
    // a replacement that keeps the length, and a deletion
    type(0, 1, 'b')
    expect(v.state.doc.sliceString(0, 1)).toBe('b')
    type(0, 10, '')
    expect(v.state.doc.length).toBe(cap - 10)
    // the agent's text from disk is never refused
    v.dispatch(v.state.update({ changes: { from: v.state.doc.length, insert: 'z'.repeat(20) }, annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)] }))
    expect(v.state.doc.length).toBe(cap + 10)
    // undoing the deletion takes the document past the cap: allowed, and saved whole
    expect(undo(v as unknown as EditorView)).toBe(true)
    expect(v.state.doc.length).toBe(cap + 20)
    expect(saveText(v.state.doc, 'lf')).toHaveLength(cap + 20)
  })

  it('U-FV-25 · the indent unit: a tab when lines are indented with tabs, else the smallest run of spaces, else the language’s', () => {
    const of = (s: string, fallback = '    ') => indentStringOf(Text.of(s.split('\n')), fallback)
    expect(of('a\n\tb')).toBe('\t')
    expect(of('a\n    b\n  c\n      d')).toBe('  ')
    // a comment's continuation (one space) is not a level; a line of spaces says nothing
    expect(of('/**\n * a\n */\nf() {\n   x\n}')).toBe('   ')
    expect(of('a\n     \nb')).toBe('    ')
    expect(of('a\nb', '\t')).toBe('\t')
    expect(of('a\n            b')).toBe(' '.repeat(8))
    // only the first L.highlightChunkLines lines are read
    expect(of(`${'x\n'.repeat(L.highlightChunkLines)}\ty`, '  ')).toBe('  ')
  })

  it('U-FV-25 · copy, cut and a drag give the file’s line ending; the document itself has none', () => {
    const filters = (eol: 'lf' | 'crlf' | 'cr') => EditorState.create({ extensions: fileLineEnding(eol) }).facet(EditorView.clipboardOutputFilter)
    const s = EditorState.create({ doc: 'a\nb' })
    expect(filters('lf')).toEqual([])
    expect(filters('crlf').map((f) => f('a\nb\n', s))).toEqual(['a\r\nb\r\n'])
    expect(filters('cr').map((f) => f('a\nb', s))).toEqual(['a\rb'])
    // an editable document splits pasted text on any line ending
    const v = editable('')
    v.dispatch(v.state.update({ changes: { from: 0, insert: 'x\r\ny\rz\nw' }, userEvent: 'input.paste' }))
    expect(v.state.doc.lines).toBe(4)
    expect(v.state.lineBreak).toBe('\n')
    // the file's ending changes (a merge took the file's): copy and cut give the new one
    const view = { state: EditorState.create({ doc: 'a\nb', extensions: fileLineEnding('lf') }), dispatch(spec: object) { this.state = this.state.update(spec).state } }
    setFileLineEnding(view as unknown as EditorView, 'crlf')
    expect(view.state.facet(EditorView.clipboardOutputFilter).map((f) => f('a\nb', view.state))).toEqual(['a\r\nb'])
  })
})
