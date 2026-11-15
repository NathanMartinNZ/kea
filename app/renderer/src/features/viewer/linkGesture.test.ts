// The link gesture of a viewer document on each system: which modifier counts, what is underlined, which press is the
// link's, and when a click opens the address or offers to copy one that is not opened.
import type { System } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import { describe, expect, it } from 'vitest'
import { idleGesture, linkModifier, stepGesture, underlined, type Flags, type GestureEvent, type GestureLink, type GestureState, type GestureStep } from './linkGesture.ts'

const SLOP = L.viewerLinkClickSlopPx
const LINK: GestureLink = { from: 4, to: 19, opens: true }
const OTHER: GestureLink = { from: 30, to: 40, opens: true }
const REFUSED: GestureLink = { from: 4, to: 30, opens: false }
const NONE: Flags = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }
/** The link modifier on `system`, with `more`. */
const mod = (system: System, more: Partial<Flags> = {}): Flags => ({ ...NONE, ...(system === 'darwin' ? { metaKey: true } : { ctrlKey: true }), ...more })

/** Runs `events` from the idle state; the last step, and every effect on the way. */
function run(system: System, events: GestureEvent<GestureLink>[]): { last: GestureStep<GestureLink>; effects: GestureStep<GestureLink>['effect'][] } {
  let s: GestureState<GestureLink> = idleGesture()
  let last: GestureStep<GestureLink> = { state: s, take: false, effect: null }
  const effects: GestureStep<GestureLink>['effect'][] = []
  for (const e of events) {
    last = stepGesture(s, e, system, SLOP)
    s = last.state
    if (last.effect) effects.push(last.effect)
  }
  return { last, effects }
}

const press = (flags: Flags, link: GestureLink | null = LINK, o: { x?: number; y?: number; button?: number; detail?: number } = {}): GestureEvent<GestureLink> => ({ kind: 'press', x: o.x ?? 10, y: o.y ?? 10, button: o.button ?? 0, detail: o.detail ?? 1, flags, link })
const release = (link: GestureLink | null = LINK, x = 10, y = 10, button = 0): GestureEvent<GestureLink> => ({ kind: 'release', x, y, button, link })
const move = (flags: Flags, link: GestureLink | null = LINK, x = 10, y = 10): GestureEvent<GestureLink> => ({ kind: 'move', x, y, flags, link })

describe('the link gesture', () => {
  for (const system of ['darwin', 'linux'] as const) {
    it(`U-FV-37 · ${system}: the modifier is read from a mouse event’s own flags (${system === 'darwin' ? '⌘' : 'Ctrl'}, the other flag ignored) or from a key while the pointer rests; without it nothing is underlined`, () => {
      expect(linkModifier(mod(system), system)).toBe(true)
      expect(linkModifier(system === 'darwin' ? { ...NONE, ctrlKey: true } : { ...NONE, metaKey: true }, system)).toBe(false)
      expect(underlined(run(system, [move(mod(system))]).last.state)).toEqual(LINK)
      expect(underlined(run(system, [move(NONE)]).last.state)).toBeNull()
      expect(underlined(run(system, [move(system === 'darwin' ? { ...NONE, ctrlKey: true } : { ...NONE, metaKey: true })]).last.state)).toBeNull()
      // the modifier pressed and released with the pointer resting
      const rest = run(system, [move(NONE, null), { kind: 'key', flags: mod(system), link: LINK }])
      expect(underlined(rest.last.state)).toEqual(LINK)
      expect(underlined(stepGesture(rest.last.state, { kind: 'key', flags: NONE, link: null }, system, SLOP).state)).toBeNull()
      // the pointer leaving, and the window's blur, clear it
      expect(underlined(run(system, [move(mod(system)), { kind: 'leave' }]).last.state)).toBeNull()
      expect(run(system, [move(mod(system)), { kind: 'blur' }]).last.state).toEqual(idleGesture())
    })

    it(`U-FV-37 · ${system}: a modifier press on a link and a release within the slop over it open it once; ⇧ with the modifier opens too`, () => {
      const r = run(system, [move(mod(system)), press(mod(system)), release(LINK, 10 + SLOP, 10)])
      expect(r.effects).toEqual([{ do: 'open', link: LINK }])
      expect(run(system, [press(mod(system))]).last.take).toBe(true)
      // a second release opens nothing
      expect(stepGesture(r.last.state, release(), system, SLOP).effect).toBeNull()
      expect(run(system, [press(mod(system, { shiftKey: true })), release()]).effects).toEqual([{ do: 'open', link: LINK }])
      // while pressed the link stays underlined
      expect(underlined(run(system, [press(mod(system)), move(NONE, null, 11, 10)]).last.state)).toEqual(LINK)
    })

    it(`U-FV-37 · ${system}: a move past the slop, a release over another link or none, and Esc open nothing`, () => {
      expect(run(system, [press(mod(system)), move(mod(system), LINK, 10 + SLOP + 1, 10), release(LINK, 10, 10)]).effects).toEqual([])
      expect(run(system, [press(mod(system)), release(LINK, 10, 10 + SLOP + 1)]).effects).toEqual([])
      expect(run(system, [press(mod(system)), release(OTHER)]).effects).toEqual([])
      expect(run(system, [press(mod(system)), release(null)]).effects).toEqual([])
      expect(run(system, [press(mod(system)), { kind: 'cancel' }, release()]).effects).toEqual([])
      expect(run(system, [press(mod(system)), { kind: 'blur' }, release()]).effects).toEqual([])
      // the release of another button leaves the press alone
      expect(run(system, [press(mod(system)), release(LINK, 10, 10, 2), release()]).effects).toEqual([{ do: 'open', link: LINK }])
    })

    it(`U-FV-37 · ${system}: ⌥ (cursors), a second click, another button, no modifier or no link: the press is the document’s`, () => {
      for (const [what, e] of [
        ['⌥', press(mod(system, { altKey: true }))],
        ['a double-click’s second press', press(mod(system), LINK, { detail: 2 })],
        ['the middle button', press(mod(system), LINK, { button: 1 })],
        ['the right button', press(mod(system), LINK, { button: 2 })],
        ['no modifier', press(NONE)],
        ['no link', press(mod(system), null)],
      ] as const) {
        const r = run(system, [e, release()])
        expect(r.last.take || r.effects.length > 0, what).toBe(false)
        expect(run(system, [e]).last.take, what).toBe(false)
      }
    })

    it(`U-FV-37 · ${system}: a modifier click on an address the link policy refuses opens the text menu with Copy Link at the pointer, never the address`, () => {
      const r = run(system, [move(mod(system), REFUSED), press(mod(system), REFUSED), release(REFUSED, 12, 11)])
      expect(r.effects).toEqual([{ do: 'menu', link: REFUSED, x: 12, y: 11 }])
      expect(underlined(run(system, [move(mod(system), REFUSED)]).last.state)).toEqual(REFUSED)
    })
  }

  it('U-FV-37 · on macOS a ⌃-press is the text menu’s, never the link’s, ⌘ held or not; on Linux ⌃ is the modifier', () => {
    expect(run('darwin', [press({ ...NONE, metaKey: true, ctrlKey: true })]).last.take).toBe(false)
    expect(run('darwin', [press({ ...NONE, ctrlKey: true })]).last.take).toBe(false)
    expect(run('linux', [press({ ...NONE, ctrlKey: true })]).last.take).toBe(true)
    // Super on Linux is the desktop's, not the link's
    expect(run('linux', [press({ ...NONE, metaKey: true })]).last.take).toBe(false)
  })
})
