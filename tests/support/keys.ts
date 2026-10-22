// Keys in the app-level tests: written as a Mac presses them (Playwright's `Meta+t`, as the commands' macOS keys in
// packages/protocol/src/commands.ts) and pressed as this system's (on Linux, the commands' Linux keys). One
// translation for every suite, so a test reads the same on both systems and the keys it presses are the ones a person
// there would.
//
// `sysKey`: a key of the app's (a command's binding, the composer's, the palette's): the command whose Mac key it is
// gives its key here; a key no command has follows the Linux rule (`⌘` alone → `Ctrl+Shift`). `textKey`: a text
// field's own editing keys, which are the system's (⌘A → Ctrl+A, ⌘↓ → Ctrl+End), not the app's.
import { chordText, COMMANDS, parseChord, parseShortcut, systemKeys, toAccelerator, type Chord } from '../../packages/protocol/src/commands.ts'
import { protocolOs, type ProtocolOs } from '../../packages/protocol/src/os/index.ts'

/** Playwright's key names → a chord's (commands.ts `Chord.key`). */
const FROM_PLAYWRIGHT: Readonly<Record<string, string>> = {
  Enter: 'enter',
  Backspace: 'backspace',
  Tab: 'tab',
  Escape: 'escape',
  Space: 'space',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
}
/** A chord's keys → Playwright's (punctuation by its key code, so Shift does not change which key is meant). */
const TO_PLAYWRIGHT: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(FROM_PLAYWRIGHT).map(([pw, k]) => [k, pw]))

/** A Playwright key press (`Meta+Shift+BracketRight`, `Meta+t`) as a chord; throws for one it cannot read. */
export function chordOf(press: string): Chord {
  const parts = press.split('+')
  // `Meta++` names the plus key itself
  const last = press.endsWith('++') ? '+' : (parts.pop() as string)
  if (press.endsWith('++')) parts.splice(-2)
  const c: Chord = { cmd: false, ctrl: false, alt: false, shift: false, key: '' }
  for (const m of parts) {
    if (m === 'Meta') c.cmd = true
    else if (m === 'Control') c.ctrl = true
    else if (m === 'Alt') c.alt = true
    else if (m === 'Shift') c.shift = true
    else throw new Error(`keys: ${press} has a modifier this file does not know (${m})`)
  }
  const code = /^(?:Key([A-Z])|Digit(\d))$/.exec(last)
  if (code) c.key = (code[1] ?? code[2] ?? '').toLowerCase()
  else if (/^F([1-9]|1[0-9])$/.test(last)) c.key = last.toLowerCase()
  else if (FROM_PLAYWRIGHT[last]) c.key = FROM_PLAYWRIGHT[last] as string
  else if ([...last].length === 1) c.key = last.toLowerCase()
  else throw new Error(`keys: ${press} names a key this file does not know (${last})`)
  return c
}

/** A chord as Playwright presses it: `Control`, `Shift`, `Alt`, `Meta`, then the key. */
export function pressOf(c: Chord): string {
  const key = TO_PLAYWRIGHT[c.key] ?? (/^f([1-9]|1[0-9])$/.test(c.key) ? c.key.toUpperCase() : c.key)
  return [c.ctrl && 'Control', c.shift && 'Shift', c.alt && 'Alt', c.cmd && 'Meta', key].filter(Boolean).join('+')
}

/**
 * The app's key `press` (written as on a Mac) as this system presses it. A command's binding gives the command's key
 * here, at the same place in its list (`⌘1` → the first of `jumpTo`'s); keys no command binds (the composer's ⌘↵ and
 * ⌘1…4, the palette's ⌘↵) take the Linux rule, `⌘` alone becoming the primary modifier. On macOS every key is
 * itself. `os`: the system whose keys to give (this one's unless a test asks for another's).
 */
export function sysKey(press: string, os: Pick<ProtocolOs, 'keys'> = protocolOs): string {
  const chord = chordOf(press)
  const text = chordText(chord)
  const here = new Set<string>()
  for (const def of COMMANDS) {
    const mac = def.keys ?? []
    const i = mac.findIndex((k) => {
      const c = parseShortcut(k)
      return c !== null && chordText(c) === text
    })
    if (i < 0) continue
    const k = systemKeys(def, os.keys)[i]
    if (k === undefined) throw new Error(`keys: ${def.id} has ${mac[i]} on macOS and no key at its place here`)
    here.add(chordText(parseShortcut(k) as Chord))
  }
  if (here.size > 1) throw new Error(`keys: ${press} is several commands' with different keys here (${[...here].join(', ')}): press the one meant`)
  // the same chord here (every key on macOS): as the test wrote it
  const same = (c: Chord) => (chordText(c) === text ? press : pressOf(c))
  if (here.size === 1) return same(parseChord([...here][0] as string) as Chord)
  if (!chord.cmd) return press
  // no command's: ⌘ alone → the primary modifier (a key with ⌘ and Shift has no rule)
  const primary = os.keys.primaryMods
  if (chord.shift && primary.shift && !primary.cmd) throw new Error(`keys: ${press} is no command's, and ⌘⇧ keys have no Linux rule: press this system's key`)
  return same({ ...chord, cmd: primary.cmd, ctrl: primary.ctrl || chord.ctrl, shift: primary.shift || chord.shift })
}

/**
 * A key's label as a test writes it (as a Mac shows it: `⌘R`, `⌘⇧N`, `↵`) as this system shows it: on macOS itself;
 * elsewhere the label of the key `sysKey` presses for it (`Ctrl+Shift+R`, `Enter`).
 */
export function sysLabel(mac: string, os: Pick<ProtocolOs, 'keys' | 'system'> = protocolOs): string {
  if (os.system === 'darwin') return mac
  const chord = parseShortcut(mac)
  if (!chord) throw new Error(`keys: ${mac} is not a key label this file can read`)
  return os.keys.label(chordOf(sysKey(pressOf(chord), os)))
}

/** The menu bar's accelerator for a key a test writes as a Mac shows it (`⌘,`): `Cmd+,` on macOS, `Ctrl+Shift+,` on Linux. */
export function sysAccel(mac: string, os: Pick<ProtocolOs, 'keys' | 'system'> = protocolOs): string {
  const a = toAccelerator(sysLabel(mac, os))
  if (a === null) throw new Error(`keys: ${mac} has no accelerator`)
  return a
}

/** A key press as a page's `keydown` sees it: its modifiers, and `KeyboardEvent.key` in lower case (`n`, `enter`). */
export type PageKey = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string }

/**
 * The app's key `press` (written as on a Mac) as a page's `keydown` sees it on this system, for a probe in the page
 * that waits for that key (`⌘N` is Ctrl+Shift+N on Linux, so a probe testing `metaKey` never sees it there). Passed
 * into `page.evaluate`, and matched by `e.metaKey === k.meta && … && e.key.toLowerCase() === k.key`.
 */
export function pageKey(press: string, os: Pick<ProtocolOs, 'keys'> = protocolOs): PageKey {
  const c = chordOf(sysKey(press, os))
  return { meta: c.cmd, ctrl: c.ctrl, alt: c.alt, shift: c.shift, key: c.key }
}

/** A text field's editing keys on Linux (Chromium's, CodeMirror's), for the Mac keys the tests press. */
const LINUX_TEXT_KEYS: Readonly<Record<string, string>> = {
  'Meta+a': 'Control+a',
  'Meta+c': 'Control+c',
  'Meta+v': 'Control+v',
  'Meta+x': 'Control+x',
  'Meta+z': 'Control+z',
  'Meta+ArrowUp': 'Control+Home',
  'Meta+ArrowDown': 'Control+End',
  'Meta+ArrowLeft': 'Home',
  'Meta+ArrowRight': 'End',
  // Linux has no key that deletes to the start of the line in a text field: the word before the caret
  'Meta+Backspace': 'Control+Backspace',
}

/** A text field's own editing key `press` (written as on a Mac) as this system's: it is the system's, not the app's. */
export function textKey(press: string, system: ProtocolOs['system'] = protocolOs.system): string {
  if (system !== 'linux') return press
  const k = LINUX_TEXT_KEYS[press]
  if (!k) throw new Error(`keys: no Linux text-editing key is known for ${press}`)
  return k
}

/** The modifier a click holds for its other action (a terminal link, a palette row): `⌘` on macOS, `Ctrl` on Linux. */
export const MOD_CLICK: 'Meta' | 'Control' = protocolOs.keys.modClick({ metaKey: true, ctrlKey: false }) ? 'Meta' : 'Control'

/** Whether a terminal here turns the Mac's text-editing keys (⌘←, ⌘→, ⌘⌫) into the shell's: macOS only. */
export const TERMINAL_TEXT_KEYS: boolean = Object.keys(protocolOs.keys.terminalText).length > 0
