// The text menu's items: what a field, a viewer document and other selected text offer, with each system's keys.

import { describe, expect, it } from 'vitest'
import { darwin } from '@kea/protocol/os/darwin'
import { linux } from '@kea/protocol/os/linux'
import { textMenuItems, type TextTarget } from './textMenu.ts'

const at = (o: Partial<TextTarget>): TextTarget => ({ kind: 'field', editable: true, hasSelection: true, secret: false, ...o })
const rows = (t: TextTarget, os: 'darwin' | 'linux' = 'darwin') => textMenuItems(t, os, os === 'darwin' ? darwin.keys : linux.keys).map((i) => [i.label, i.shortcut, i.disabled ? i.reason : null])

describe('the text menu', () => {
  it('U-KB-19 · a field offers Cut, Copy, Paste and Select All with its own keys; a document Copy and Select All; other text Copy while something is selected', () => {
    expect(rows(at({}))).toEqual([
      ['Cut', '⌘X', null],
      ['Copy', '⌘C', null],
      ['Paste', '⌘V', null],
      ['Select All', '⌘A', null],
    ])
    // Linux: the field's own Ctrl keys, which the key router leaves to it
    expect(rows(at({}), 'linux').map((r) => r[1])).toEqual(['Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'Ctrl+A'])
    // nothing selected: Cut and Copy say so; a read-only field takes no cut or paste; a password is never copied
    expect(rows(at({ hasSelection: false })).map((r) => r[2])).toEqual(['Nothing is selected', 'Nothing is selected', null, null])
    expect(rows(at({ editable: false })).map((r) => r[2])).toEqual(['This field is read-only', null, 'This field is read-only', null])
    expect(rows(at({ secret: true })).map((r) => r[2])).toEqual(['A password is not copied', 'A password is not copied', null, null])
    // the viewer's document: Copy and Select All
    expect(rows(at({ kind: 'document', editable: false }))).toEqual([
      ['Copy', '⌘C', null],
      ['Select All', '⌘A', null],
    ])
    expect(rows(at({ kind: 'document', editable: false, hasSelection: false }))[0]).toEqual(['Copy', '⌘C', 'Nothing is selected'])
    // other text: Copy while something is selected, else no menu at all
    expect(rows(at({ kind: 'text', editable: false }), 'linux')).toEqual([['Copy', 'Ctrl+C', null]])
    expect(rows(at({ kind: 'text', editable: false, hasSelection: false }))).toEqual([])
  })
})
