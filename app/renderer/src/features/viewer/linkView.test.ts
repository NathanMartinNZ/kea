// Follow Link (`viewer.followLink`): which address it follows from the cursor, its reason when there is none, and its
// key, F12, in the viewer's scope on both systems, passed by the key router to the viewer.
import { EditorSelection, EditorState } from '@codemirror/state'
import { bindings, commandById, COMMANDS, systemKeys } from '@kea/protocol'
import { darwin } from '@kea/protocol/os/darwin'
import { linux } from '@kea/protocol/os/linux'
import { afterAll, describe, expect, it } from 'vitest'
import { routeKey, scopedBinding, setBindings } from '../commands/keys.ts'
import { linkAtCursor } from './linkView.ts'
import { NO_LINK } from './links.ts'

const LINE = 'see (https://x.dev/a). then mailto:me@x.dev'
const at = (pos: number) => linkAtCursor(EditorState.create({ doc: `${LINE}\nnext line`, selection: { anchor: pos } }))

describe('Follow Link', () => {
  afterAll(() => setBindings(bindings()))

  it('U-FV-38 · it follows the address that holds the main cursor or ends at it; anywhere else it is unavailable, with its reason', () => {
    const start = LINE.indexOf('https')
    const end = LINE.indexOf(')')
    // before its first character, inside it, at its end (after its last character)
    for (const pos of [start, start + 5, end]) expect(at(pos)?.text, String(pos)).toBe('https://x.dev/a')
    // before the scheme's run, past what was trimmed, on plain text, on the next line
    for (const pos of [start - 1, end + 1, end + 2, LINE.indexOf('then'), LINE.length + 3]) expect(at(pos), String(pos)).toBeNull()
    expect(at(LINE.length)?.text).toBe('mailto:me@x.dev')
    // an address the link policy refuses is still followed (to offer Copy Link)
    const bidi = EditorState.create({ doc: 'x https://example.com/‮gnp.exe', selection: { anchor: 5 } })
    expect(linkAtCursor(bidi)).toMatchObject({ opens: false, action: { open: false, reason: 'malformed' } })
    // only the main cursor counts
    const two = EditorState.create({ doc: LINE, selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(start + 1)], 0), extensions: EditorState.allowMultipleSelections.of(true) })
    expect(linkAtCursor(two)).toBeNull()
    expect(NO_LINK).toBe('No link at the cursor')
  })

  it('U-FV-38 · F12 on both systems in the viewer tab scope, in the palette and the menu bar (no surface of its own); the router passes it to the viewer, which finds its command', () => {
    expect(commandById('viewer.followLink')).toEqual({ id: 'viewer.followLink', title: 'Follow Link', category: 'Viewer', keys: ['F12'], linuxKeys: ['F12'], keyScope: 'viewer tab' })
    for (const keys of [darwin.keys, linux.keys]) {
      const def = commandById('viewer.followLink')
      expect(def && systemKeys(def, keys)).toEqual(['F12'])
      const table = bindings(COMMANDS, keys)
      expect(table.filter((b) => b.chord === 'f12')).toEqual([{ chord: 'f12', id: 'viewer.followLink', scope: 'viewer tab' }])
      setBindings(table)
      const f12 = { key: 'F12', code: 'F12', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }
      expect(scopedBinding(f12, ['file tab', 'viewer tab'])?.id).toBe('viewer.followLink')
      expect(scopedBinding(f12, ['diff tab', 'viewer tab'])?.id).toBe('viewer.followLink')
      expect(scopedBinding(f12, ['file panel'])).toBeUndefined()
      expect(scopedBinding(f12, [])).toBeUndefined()
      // not the router's: the viewer gets the key
      expect(routeKey(f12, { inTerminal: false, scopes: ['viewer tab'], has: () => true }, keys)).toEqual({ do: 'pass' })
    }
  })
})
