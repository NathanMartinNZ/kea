// Svelte's event propagation: while Svelte runs an event's handlers (its root's delegated listener, or a listener added
// with `on`) it defines `event.currentTarget` as a getter over the element it has reached, and deletes the property
// when it is done. V8 keeps that getter in the shape it shares with every later event of the type, so whatever the
// getter's closure still holds outlives the event: with Svelte 5.57.2 the element where propagation stopped (a sheet
// whose Escape handler stops it), and with it the whole closed sheet, until the shape is dropped (L-WT-1: a closed Disk
// sheet, 156 DOM nodes, at one checkpoint in some runs). The patch lets go of the element once the handlers have run.
// No DOM here: the element and the event are plain objects, which is all `on` reads.
import { on } from 'svelte/events'
import { describe, expect, it } from 'vitest'

describe('Svelte event propagation', () => {
  it('U-MEM-29 · once an event has been handled, the currentTarget getter Svelte defined for it holds no element: it answers the document', () => {
    const document = { kind: 'document' }
    const listeners: ((e: unknown) => void)[] = []
    // a sheet with its own listener (`on`), and the input inside it the key was typed in
    const sheet = { kind: 'sheet', ownerDocument: document, addEventListener: (_: string, f: (e: unknown) => void) => listeners.push(f), removeEventListener: () => undefined }
    const input = { kind: 'input', ownerDocument: document }
    let handled = 0
    const off = on(sheet as unknown as Element, 'keydown', () => void handled++)
    // the getter Svelte defines, kept as V8 keeps it in the event's shape after the property is deleted
    let getter: (() => unknown) | undefined
    const event = {
      type: 'keydown',
      target: input,
      composedPath: () => [input, sheet, document],
      get cancelBubble() {
        getter ??= Object.getOwnPropertyDescriptor(this, 'currentTarget')?.get
        return false
      },
    }
    for (const f of listeners) f.call(sheet, event)
    expect(handled, 'the sheet’s listener ran').toBe(1)
    expect(getter, 'Svelte proxied currentTarget while its handlers ran').toBeTypeOf('function')
    expect(Object.getOwnPropertyDescriptor(event, 'currentTarget'), 'and deleted it after').toBeUndefined()
    expect(getter!(), 'what the getter still holds once the event is handled').toBe(document)
    off()
  })
})
