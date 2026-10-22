// The perf budgets' timings for the palette (P-UI-2, P-UI-3), installed with the test probes (`__keaProbe.palette`,
// `lib/testProbes.ts`): only when the app runs with `--kea-perf`. Nothing here is used by the app itself.
//
//   timeOpen()     P-UI-2: arm it, press `⌘⇧P`; resolves with keydown → the palette interactive (its input holds the
//                  keyboard), by the one-frame rule: the palette opens between frames, so the moment is the next
//                  frame's start, that frame's paint excluded. `painted` is the start of the frame after it
//   synthetic()    P-UI-3: the palette reads a set of its own (so many sessions, so many commands) instead of the
//                  window's; null gives the window's back. The next opening reads it
//   keystrokes()   P-UI-3: from `true` on, every character typed in the palette is timed from its keydown to the end
//                  of the update that draws the list (matching, the rows, the DOM; its paint excluded); `false` ends
//                  the recording and returns the times
//   usage()        how often the palette ran a command

import { chordText, commandById, COMMANDS, parseShortcut, systemKeys, type SessionGlyph } from '@kea/protocol'
import { chordOf } from '../commands/keys.ts'
import type { CommandSource, SessionSource, Sources } from './data.ts'
import { paletteTiming, setPaletteSources, usage } from './state.svelte.ts'

/** The palette's key on this system (`⌘⇧P`; `Ctrl+Shift+Alt+P` on Linux), as the router matches it. */
function paletteChord(): string | null {
  const k = systemKeys(commandById('view.palette')!)[0]
  const c = k ? parseShortcut(k) : null
  return c ? chordText(c) : null
}

const PALETTE_INPUT = '.palette input'

export interface OpenMark {
  interactive: number
  painted: number
}

function timeOpen(timeoutMs = 5000): Promise<OpenMark> {
  return new Promise((resolve, reject) => {
    let down: number | null = null
    let interactive: number | null = null
    let ticking = true
    // Looked for at each frame's start, not by a focus event (a window that is not the key window, as every test
    // window is, moves `activeElement` without firing one): the palette opens in the task of its keydown, between
    // frames, so the first frame that starts with its input holding the keyboard is the frame that draws it.
    const tick = (t: number): void => {
      if (!ticking) return
      if (down !== null && interactive !== null) return finish(null, { interactive, painted: Math.max(0, t - down) })
      if (down !== null && document.activeElement?.matches(PALETTE_INPUT) === true) interactive = Math.max(0, t - down)
      requestAnimationFrame(tick)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (down === null && chordOf(e) === paletteChord()) down = e.timeStamp
    }
    const timer = setTimeout(() => finish(new Error(`the palette did not open (key seen: ${down !== null})`)), timeoutMs)
    const finish = (err: Error | null, r?: OpenMark): void => {
      ticking = false
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey, true)
      if (err) reject(err)
      else resolve(r as OpenMark)
    }
    window.addEventListener('keydown', onKey, true)
    requestAnimationFrame(tick)
  })
}

const WORDS = ['fix', 'auth', 'redirect', 'flaky', 'test', 'sidebar', 'drag', 'server', 'port', 'palette', 'rank', 'theme', 'contrast', 'worktree', 'prune', 'status', 'hook', 'retry', 'diff', 'viewer', 'scroll', 'restore', 'cache', 'index']
const GLYPHS: readonly SessionGlyph[] = ['idle', 'working', 'unread', 'needsYou', 'detached']

/** A set of the given size (P-UI-3): titles, branches and projects of ordinary words, the same on every run. */
function syntheticSources(n: { sessions: number; commands: number }): Sources {
  const word = (i: number): string => WORDS[i % WORDS.length] as string
  const sessions: SessionSource[] = Array.from({ length: n.sessions }, (_, i) => ({
    id: `synthetic-${i}`,
    title: `${word(i)} ${word(i * 7 + 3)} ${word(i * 13 + 5)} ${i}`,
    branch: `${word(i * 5 + 1)}/${word(i * 3 + 2)}-${word(i * 11 + 7)}-${i}`,
    project: `project-${word(i % 9)}`,
    glyph: GLYPHS[i % GLYPHS.length] as SessionGlyph,
    needsYou: i % 50 === 0,
  }))
  const commands: CommandSource[] = Array.from({ length: n.commands }, (_, i) => {
    const real = COMMANDS[i]
    return real ? { id: real.id, title: real.title, category: real.category } : { id: `synthetic.${i}`, title: `${word(i * 3)} ${word(i * 5 + 1)} ${word(i * 7 + 2)}`.replace(/\b\w/g, (c) => c.toUpperCase()), category: 'View' }
  })
  const titles = new Map(commands.map((c) => [c.id, c.title]))
  return {
    sessions: () => sessions,
    needing: () => sessions.filter((s) => s.needsYou).map((s) => s.id),
    recent: () => sessions.slice(0, 20).map((s) => s.id),
    commands: () => commands,
    projects: () => Array.from({ length: 9 }, (_, i) => ({ id: `synthetic-project-${i}`, name: `project-${word(i)}` })),
    now: (id) => ({ title: titles.get(id) ?? id, shortcut: null, reason: null, remedy: null }),
  }
}

export function paletteProbe() {
  let times: number[] | null = null
  return {
    timeOpen: (timeoutMs?: number): Promise<OpenMark> => timeOpen(timeoutMs),
    synthetic(n: { sessions: number; commands: number } | null): void {
      setPaletteSources(n ? syntheticSources(n) : null)
    },
    keystrokes(record: boolean): number[] {
      const got = times ?? []
      times = record ? [] : null
      paletteTiming.keystroke = record ? (ms) => void times?.push(ms) : null
      return got
    },
    usage: (id: string): number => usage.count(id),
  }
}
