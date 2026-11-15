// The text menu's items: what a field, a viewer document and other selected text offer, with each system's keys; a
// web address's items; the keys and presses that open it.

import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { darwin } from '@kea/protocol/os/darwin'
import { linux } from '@kea/protocol/os/linux'
import { linkAt, linkAtCursor, textLinkOf } from '../viewer/linkView.ts'
import { menuKey, pointerMenu, textMenuItems, type TextLink, type TextTarget } from './textMenu.ts'

const at = (o: Partial<TextTarget>): TextTarget => ({ kind: 'field', editable: true, hasSelection: true, secret: false, ...o })
const rows = (t: TextTarget, os: 'darwin' | 'linux' = 'darwin') => textMenuItems(t, os, os === 'darwin' ? darwin.keys : linux.keys).map((i) => [i.label, i.shortcut, i.disabled ? i.reason : null])

describe('the text menu', () => {
  it('U-KB-19 · a field and an editable document offer Cut, Copy, Paste and Select All with a field’s keys; a read-only document Copy and Select All; other text Copy while something is selected', () => {
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
    // a document that can be edited offers what a field does
    expect(rows(at({ kind: 'document' }), 'linux')).toEqual([
      ['Cut', 'Ctrl+X', null],
      ['Copy', 'Ctrl+C', null],
      ['Paste', 'Ctrl+V', null],
      ['Select All', 'Ctrl+A', null],
    ])
    expect(rows(at({ kind: 'document', hasSelection: false })).map((r) => r[2])).toEqual(['Nothing is selected', 'Nothing is selected', null, null])
    // other text: Copy while something is selected, else no menu at all
    expect(rows(at({ kind: 'text', editable: false }), 'linux')).toEqual([['Copy', 'Ctrl+C', null]])
    expect(rows(at({ kind: 'text', editable: false, hasSelection: false }))).toEqual([])
  })
})

describe('the text menu on a web address', () => {
  const OPENS: TextLink = { kind: 'url', text: 'https://x.dev/a', url: 'https://x.dev/a' }
  const REFUSED: TextLink = { kind: 'url', text: 'https://example.com/‮gnp.exe', url: null }
  const labels = (t: TextTarget, os: 'darwin' | 'linux' = 'darwin') => textMenuItems(t, os, os === 'darwin' ? darwin.keys : linux.keys).map((i) => (i.separator ? '—' : i.label))

  it('U-FV-36 · Open Link and Copy Link come first, then a separator and the document’s own items; an address that is not opened offers Copy Link without Open Link; a click on one, or Follow Link at one, offers Copy Link alone', () => {
    expect(labels(at({ kind: 'document', editable: false, hasSelection: false, link: OPENS }))).toEqual(['Open Link', 'Copy Link', '—', 'Copy', 'Select All'])
    expect(labels(at({ kind: 'document', link: OPENS }), 'linux')).toEqual(['Open Link', 'Copy Link', '—', 'Cut', 'Copy', 'Paste', 'Select All'])
    expect(labels(at({ kind: 'document', editable: false, link: REFUSED }))).toEqual(['Copy Link', '—', 'Copy', 'Select All'])
    expect(labels(at({ kind: 'document', editable: false, link: REFUSED, linkOnly: true }))).toEqual(['Copy Link'])
    // the link's items carry no key; the document's keep theirs
    const items = textMenuItems(at({ kind: 'document', editable: false, link: OPENS }), 'darwin', darwin.keys)
    expect(items.slice(0, 2).map((i) => [i.id, i.shortcut ?? null, i.disabled ?? false])).toEqual([
      ['openLink', null, false],
      ['copyLink', null, false],
    ])
    expect(items[3]).toMatchObject({ id: 'copy', shortcut: '⌘C' })
    // no link: the menu as before
    expect(labels(at({ kind: 'document', editable: false, link: null }))).toEqual(['Copy', 'Select All'])
  })

  it('U-FV-36 · Copy Link copies the address as it reads in the text, trimmed; Open Link opens what the link policy gives', () => {
    const state = EditorState.create({ doc: 'see [docs](https://x.dev/a?b=1).' })
    const link = linkAt(state, state.doc.toString().indexOf('x.dev'))
    expect(link && textLinkOf(link)).toEqual({ kind: 'url', text: 'https://x.dev/a?b=1', url: 'https://x.dev/a?b=1' })
    // the policy's own form (a lower-case host) is what opens; the text stays as written
    const upper = EditorState.create({ doc: 'HTTPS://X.DEV/A' })
    expect(textLinkOf(linkAt(upper, 3) as NonNullable<ReturnType<typeof linkAt>>)).toEqual({ kind: 'url', text: 'HTTPS://X.DEV/A', url: 'https://x.dev/A' })
    const bidi = EditorState.create({ doc: 'https://example.com/‮gnp.exe' })
    expect(textLinkOf(linkAt(bidi, 3) as NonNullable<ReturnType<typeof linkAt>>)).toEqual({ kind: 'url', text: 'https://example.com/‮gnp.exe', url: null })
    // the keyboard's menu takes the address at the cursor
    const cursor = EditorState.create({ doc: 'a https://x.dev/a b', selection: { anchor: 9 } })
    expect(linkAtCursor(cursor)?.text).toBe('https://x.dev/a')
  })

  it('U-FV-36 · the keyboard’s menu: the Menu key alone and ⇧F10 open it at the cursor; with another modifier they do not', () => {
    const k = (key: string, o: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => menuKey({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o })
    expect(k('ContextMenu')).toBe(true)
    expect(k('F10', { shiftKey: true })).toBe(true)
    expect(k('F10')).toBe(false)
    expect(k('F10', { shiftKey: true, metaKey: true })).toBe(false)
    expect(k('F10', { shiftKey: true, ctrlKey: true })).toBe(false)
    expect(k('ContextMenu', { ctrlKey: true })).toBe(false)
    expect(k('ContextMenu', { altKey: true })).toBe(false)
    expect(k('ContextMenu', { shiftKey: true })).toBe(false)
    expect(k('F12')).toBe(false)
  })

  it('U-FV-36 · a contextmenu from the pointer opens where the pointer is: the right button on both systems, and on macOS a ⌃-click read as a press', () => {
    for (const os of ['darwin', 'linux'] as const) {
      expect(pointerMenu({ button: 2, ctrlKey: false }, os)).toBe(true)
      // one the keyboard sent (on a field, where Chromium sends one)
      expect(pointerMenu({ button: 0, ctrlKey: false }, os)).toBe(false)
    }
    expect(pointerMenu({ button: 0, ctrlKey: true }, 'darwin')).toBe(true)
    expect(pointerMenu({ button: 0, ctrlKey: true }, 'linux')).toBe(false)
  })
})
