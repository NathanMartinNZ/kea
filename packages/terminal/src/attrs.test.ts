import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { sgrOf, type Attrs } from './attrs.ts'
import { internals, newMirror, newTerminal, write, type HeadlessTerminal } from './test-support.ts'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

function terminal(): HeadlessTerminal {
  const t = newTerminal('mirror', 20, 4)
  cleanup.push(() => t.dispose())
  return t
}

/** One SGR parameter as written: plain numbers, colours in both forms, underline styles, and some nonsense. */
const param = fc.oneof(
  fc.constantFrom('', '0', '1', '2', '3', '4', '5', '7', '8', '9', '21', '22', '23', '24', '25', '27', '28', '29', '39', '49', '53', '55', '59', '221', '222'),
  fc.integer({ min: 30, max: 49 }).map(String),
  fc.integer({ min: 90, max: 107 }).map(String),
  fc.tuple(fc.constantFrom('38', '48', '58'), fc.integer({ min: 0, max: 255 })).map(([t, n]) => `${t};5;${n}`),
  fc.tuple(fc.constantFrom('38', '48', '58'), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })).map(([t, r, g, b]) => `${t};2;${r};${g};${b}`),
  fc.tuple(fc.constantFrom('38', '48', '58'), fc.integer({ min: 0, max: 255 })).map(([t, n]) => `${t}:5:${n}`),
  fc.tuple(fc.constantFrom('38', '48', '58'), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })).map(([t, r, g]) => `${t}:2::${r}:${g}:7`),
  fc.integer({ min: 0, max: 7 }).map((n) => `4:${n}`),
  fc.constantFrom('4:', '38;5', '38;2;1', '48:2:1:2', '58;9;3', '38'),
)
const sgr = fc.array(param, { maxLength: 6 }).map((ps) => `\x1b[${ps.join(';')}m`)
const step = fc.oneof(sgr, sgr, fc.constantFrom('\x1b[1"q', '\x1b[2"q', '\x1b[0"q', '\x1b7', '\x1b8', '\x1b[s', '\x1b[u', '\x1b[?1048h', '\x1b[?1048l', '\x1b[?1049h', '\x1b[?1049l', '\x1b[!p', 'x'))

describe('character attributes', () => {
  it('U-PTY-3 · property: the mode tracker follows SGR, DECSCA and the saved cursor’s attributes as xterm.js does', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 24 }), async (steps) => {
        const m = newMirror(20, 4)
        try {
          await m.write(steps.join(''))
          const x = internals(m.term)
          const tracked = m.kit.modes.state()
          expect(tracked.attrs).toEqual(x.attrs)
          for (const k of ['normal', 'alt'] as const) expect({ fg: tracked.saved[k].fg, bg: tracked.saved[k].bg }, k).toEqual({ fg: x.saved[k].fg, bg: x.saved[k].bg })
        } finally {
          m.dispose()
        }
      }),
      { numRuns: 300 },
    )
  })

  it('U-PTY-3 · property: the SGR written for an attribute state sets exactly that state on a fresh terminal', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(sgr, { maxLength: 8 }), fc.boolean(), async (steps, protect) => {
        const src = terminal()
        await write(src, steps.join('') + (protect ? '\x1b[1"q' : ''))
        const a: Attrs = internals(src).attrs
        // from a state with every field set, so nothing is right by accident
        const busy = '\x1b[3;31;48;5;9;4:3;58;5;2m\x1b[1"q'
        const dst = terminal()
        await write(dst, busy + sgrOf(a))
        expect(internals(dst).attrs).toEqual(a)
        const saved = terminal()
        await write(saved, busy + sgrOf(a, false))
        expect({ fg: internals(saved).attrs.fg, bg: internals(saved).attrs.bg }, 'without the extended fields, fg and bg are still exact').toEqual({ fg: a.fg, bg: a.bg })
      }),
      { numRuns: 300 },
    )
  })
})
