// The generated Settings sections: what the window draws for the schema's rows. The components are rendered to markup
// with `svelte/server` (no DOM) and read back row by row; the rows are the ones core serves (`settingRows`), so the
// test fails when a key of the schema has no row, a wrong label or a missing allowed value.
import type { Component } from 'svelte'
import { render } from 'svelte/server'
import { describe, expect, it } from 'vitest'
import { AGENT_SETTINGS, parseSettings, protocolOs, SETTING_CONTROLS, SETTINGS, SETTINGS_SECTIONS, settingRows, type AgentInfo, type AgentSettingsExtension, type SettingRow, type SettingsSection } from '@kea/protocol'
import AgentCards from './AgentCards.svelte'
import { agentCards, agentSummary, isModified, optionsOf, parseText, refusal, rowId, sectionRows, shownText, uptimeText } from './model.ts'
import NotificationsNote from './NotificationsNote.svelte'
import Rows from './Rows.svelte'

// Two made-up adapters: the shared agent keys, plus one key of its own each. The window has no schema library, so each
// key borrows the schema (and, for the select, the allowed values) of a key of the same kind.
const aSelect = SETTINGS.find((d) => d.control === 'select' && d.options !== undefined)!
const aToggle = AGENT_SETTINGS.find((d) => d.control === 'toggle')!
const one: AgentSettingsExtension = {
  id: 'one',
  displayName: 'Agent One',
  defaults: {},
  keys: [{ key: 'flavour', schema: aSelect.schema, default: aSelect.default, label: 'Flavour', help: 'How Agent One draws.', section: 'Agents', control: 'select', options: aSelect.options! }],
}
const two: AgentSettingsExtension = {
  id: 'two',
  displayName: 'Agent Two',
  defaults: {},
  keys: [{ key: 'loud', schema: aToggle.schema, default: false, label: 'Loud', section: 'Agents', control: 'toggle' }],
}

const never = () => Promise.resolve()
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
/** A component's markup (Svelte's hydration comments left out); text and attribute values are still escaped: `read` unescapes what it takes. */
const html = (component: Component<any>, props: Record<string, unknown>) => render(component, { props }).body.replace(/<!--[\s\S]*?-->/g, '')

/** The markup of each generated row, by its key, in document order. */
function rowsIn(markup: string): Map<string, string> {
  const out = new Map<string, string>()
  const starts = [...markup.matchAll(/<div class="settings-row gen-row" data-setting="([^"]+)"/g)]
  starts.forEach((m, i) => {
    if (out.has(m[1]!)) throw new Error(`${m[1]} is drawn twice`)
    out.set(m[1]!, markup.slice(m.index, starts[i + 1]?.index ?? markup.length))
  })
  return out
}

/** A row's parts as a person meets them: its label, its control's element, a select's options, its help. */
function read(row: string) {
  const text = (re: RegExp, group = 1) => {
    const m = re.exec(row)
    return m ? unescape(m[group]!) : null
  }
  return {
    label: text(/<label class="settings-label" for="[^"]+">([^<]*)<\/label>/),
    labelFor: text(/<label class="settings-label" for="([^"]+)">/),
    control: /<(input|select|textarea)\b([^>]*)>/.exec(row),
    options: [...row.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => ({ value: unescape(m[1]!), label: unescape(m[2]!) })),
    help: text(/<span class="settings-help" id="[^"]+-help">([^<]*)<\/span>/),
    reset: text(/<button class="link-button gen-reset" aria-label="([^"]+)"/),
    note: text(/<span class="settings-help gen-note" role="status">([^<]*)<\/span>/),
  }
}

const drawSection = (rows: readonly SettingRow[], section: SettingsSection, value: (k: string) => unknown) =>
  rowsIn(html(Rows, { rows: sectionRows(rows, section), value, agents: [{ id: 'one', displayName: 'Agent One' }], onSet: never, onReset: never }))

/** What kind of element a control kind is drawn as. */
function elementOf(row: SettingRow, drawn: ReturnType<typeof read>): string {
  const attrs = drawn.control?.[2] ?? ''
  if (!drawn.control) return 'nothing'
  if (drawn.control[1] === 'select') return 'select'
  if (drawn.control[1] === 'textarea') return row.control === 'map' ? (attrs.includes('placeholder="NAME=value"') ? 'map' : 'list') : 'list'
  if (attrs.includes('role="switch"')) return 'toggle'
  if (attrs.includes('type="number"')) return 'number'
  return attrs.includes('mono') ? 'path' : 'text'
}

describe('Settings: sections generated from the schema', () => {
  const defaults = parseSettings({}, [one, two]).values
  const all = settingRows([one, two])
  const generated = SETTINGS_SECTIONS.filter((s) => s !== 'file only' && s !== 'Agents')

  it('U-SET-6 · every schema key is one row in its section, with its label, its help and its allowed values; a file-only key is drawn nowhere', () => {
    const seen = new Map<string, SettingsSection>()
    const hidden = new Set(protocolOs.window.hiddenSettings)
    for (const section of generated) {
      const drawn = drawSection(all, section, (k) => defaults.get(k))
      for (const [key, markup] of drawn) {
        expect(seen.has(key), `${key} is drawn in two sections`).toBe(false)
        seen.set(key, section)
        const def = SETTINGS.find((d) => d.key === key)!
        expect(def, `${key} is a key of the schema`).toBeDefined()
        expect(def.section, key).toBe(section)
        const r = read(markup)
        expect(r.label, key).toBe(def.label)
        expect(r.help, key).toBe(def.help ?? null)
        // the label names the control (a click on it, and a screen reader, reach the control)
        expect(markup, key).toContain(` id="${r.labelFor}"`)
        expect(elementOf(all.find((x) => x.fullKey === key)!, r), key).toBe(def.control)
        if (def.control === 'select') {
          // the schema's values in its order (the terminal app: Automatic and this system's, U-PLT-56); a key that
          // names an adapter lists the registered ones, and a value that is none of them (here the default, which names
          // an adapter this test did not register) is shown as it is
          const current = String(defaults.get(key))
          const offered = (v: string) => key !== 'general.terminalApp' || v === 'auto' || protocolOs.window.terminalApps.includes(v)
          const want = def.options ? def.options.filter((o) => offered(o.value)).map((o) => ({ value: o.value, label: o.label })) : [{ value: 'one', label: 'Agent One' }, ...(current === 'one' ? [] : [{ value: current, label: current }])]
          expect(r.options, key).toEqual(want)
        } else expect(r.options, key).toEqual([])
        // at its default a row offers no Reset
        expect(r.reset, key).toBeNull()
      }
      // the section's order is the schema's
      expect([...drawn.keys()], section).toEqual(SETTINGS.filter((d) => d.section === section && d.control !== 'none' && !hidden.has(d.key)).map((d) => d.key))
    }
    // every key of the schema is drawn exactly once, or is one the UI does not draw (file only, a control of `none`, or
    // one this system has no use for)
    for (const def of SETTINGS) {
      if (def.section === 'file only' || def.control === 'none' || hidden.has(def.key)) expect(seen.has(def.key), `${def.key} is not drawn`).toBe(false)
      else expect(seen.get(def.key), def.key).toBe(def.section)
    }
  })

  it('U-SET-6 · the Agents section is one card per registered adapter: the keys every adapter has, then its own; another adapter’s keys are not in it', () => {
    const infos: AgentInfo[] = []
    const cards = agentCards({ rows: all, agents: [one, two].map((a) => ({ id: a.id, displayName: a.displayName })) }, infos)
    const markup = html(AgentCards, { cards, value: (k: string) => defaults.get(k), onSet: never, onReset: never, onCopy: () => {} })
    const starts = [...markup.matchAll(/<section class="agent-card" aria-label="([^"]+)" data-agent="([^"]+)">/g)]
    expect(starts.map((m) => [m[2], m[1]])).toEqual([
      ['one', 'Agent One'],
      ['two', 'Agent Two'],
    ])
    const card = (i: number) => rowsIn(markup.slice(starts[i]!.index, starts[i + 1]?.index ?? markup.length))
    const shared = all.filter((r) => r.agent === 'one' && r.control !== 'none' && r.key !== 'flavour').map((r) => r.key)
    expect(shared.length, 'the keys every adapter has').toBeGreaterThan(0)
    expect([...card(0).keys()]).toEqual([...shared.map((k) => `agents.one.${k}`), 'agents.one.flavour'])
    expect([...card(1).keys()]).toEqual([...shared.map((k) => `agents.two.${k}`), 'agents.two.loud'])
    const flavour = read(card(0).get('agents.one.flavour')!)
    expect(flavour.label).toBe('Flavour')
    expect(flavour.help).toBe('How Agent One draws.')
    expect(flavour.options).toEqual(aSelect.options!.map((o) => ({ value: o.value, label: o.label })))
    expect(elementOf(all.find((r) => r.fullKey === 'agents.two.loud')!, read(card(1).get('agents.two.loud')!))).toBe('toggle')
    // an adapter's keys are drawn in its card only: never in a generated section
    for (const section of generated) for (const key of drawSection(all, section, (k) => defaults.get(k)).keys()) expect(key.startsWith('agents.'), key).toBe(false)
  })

  it('U-SET-6 · a key added to the schema appears with no UI change: one row per control kind, drawn from the row alone; `none` draws nothing', () => {
    const made = (control: SettingRow['control'], extra: Partial<SettingRow> = {}): SettingRow => ({ fullKey: `general.madeUp_${control}`, key: `general.madeUp_${control}`, label: `Made up ${control}`, help: `Help for ${control}.`, section: 'General', control, default: null, ...extra })
    const added: SettingRow[] = [
      made('toggle', { default: false }),
      made('select', { default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }),
      made('number', { default: 3, min: 1, max: 9, integer: true }),
      made('text', { default: '', maxLength: 12 }),
      made('path', { default: null, nullable: true }),
      made('list', { default: [] }),
      made('map', { default: {} }),
      made('none', { default: null }),
    ]
    expect(added.map((r) => r.control).sort(), 'one made-up key per control kind').toEqual([...SETTING_CONTROLS].sort())
    const values: Record<string, unknown> = { 'general.madeUp_number': 3, 'general.madeUp_select': 'a', 'general.madeUp_toggle': false, 'general.madeUp_text': '', 'general.madeUp_list': [], 'general.madeUp_map': {} }
    const before = drawSection(all, 'General', (k) => defaults.get(k))
    const drawn = drawSection([...all, ...added], 'General', (k) => (k in values ? values[k] : k.startsWith('general.madeUp_') ? null : defaults.get(k)))
    // the rows that were there are unchanged, and the new ones follow them
    expect([...drawn.keys()]).toEqual([...before.keys(), ...added.filter((r) => r.control !== 'none').map((r) => r.fullKey)])
    for (const row of added) {
      const markup = drawn.get(row.fullKey)
      if (row.control === 'none') {
        expect(markup, 'a key with no control has no row').toBeUndefined()
        continue
      }
      const r = read(markup!)
      expect(r.label, row.fullKey).toBe(row.label)
      expect(r.help, row.fullKey).toBe(row.help)
      expect(elementOf(row, r), row.fullKey).toBe(row.control)
    }
    const number = read(drawn.get('general.madeUp_number')!).control![2]!
    expect(number).toContain('min="1"')
    expect(number).toContain('max="9"')
    expect(number).toContain('step="1"')
    expect(read(drawn.get('general.madeUp_text')!).control![2]).toContain('maxlength="12"')
    expect(read(drawn.get('general.madeUp_select')!).options).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ])
  })

  it('U-SET-6 · a row whose value differs from the default offers Reset, named for its key; a dangerous-modes switch that is on says in one sentence what it adds', () => {
    const modified: Record<string, unknown> = { 'terminal.fontSize': (defaults.get<number>('terminal.fontSize') ?? 0) + 1, 'agents.one.allowDangerousModes': true }
    const value = (k: string) => (k in modified ? modified[k] : defaults.get(k))
    const terminal = drawSection(all, 'Terminal', value)
    const size = all.find((r) => r.fullKey === 'terminal.fontSize')!
    expect(read(terminal.get('terminal.fontSize')!).reset).toBe(`Reset ${size.label} to its default`)
    // its neighbours are at their defaults: no Reset
    for (const [key, markup] of terminal) if (key !== 'terminal.fontSize') expect(read(markup).reset, key).toBeNull()

    const cards = agentCards({ rows: all, agents: [{ id: 'one', displayName: 'Agent One' }] }, [])
    const draw = (v: (k: string) => unknown) => read(rowsIn(html(AgentCards, { cards, value: v, onSet: never, onReset: never, onCopy: () => {} })).get('agents.one.allowDangerousModes')!)
    const danger = all.find((r) => r.fullKey === 'agents.one.allowDangerousModes')!
    expect(danger.onNote, 'the schema states the sentence').toMatch(/^[^.]+\.$/)
    // off (the default): a plain switch, no note; on: the one sentence, and Reset
    const off = draw((k) => defaults.get(k))
    expect(off.control![2]).toContain('role="switch"')
    expect(off.control![2]).not.toContain('checked')
    expect(off.note).toBeNull()
    const on = draw(value)
    expect(on.control![2]).toContain('checked')
    expect(on.note).toBe(danger.onNote)
    expect(on.reset).toBe(`Reset ${danger.label} to its default`)
  })
})

describe('Settings: what a row shows and writes', () => {
  const row = (control: SettingRow['control'], extra: Partial<SettingRow> = {}): SettingRow => ({ fullKey: `x.${control}`, key: `x.${control}`, label: control, section: 'General', control, default: null, ...extra })

  it('U-SET-9 · a control’s text and the value it stands for: a number or nothing, a list a line each, a map as NAME=value lines, an emptied optional path as a reset; text with no reading as its kind is refused at the row before anything is written', () => {
    expect(parseText(row('number'), ' 14 ')).toEqual({ value: 14 })
    expect(parseText(row('number'), '1.25')).toEqual({ value: 1.25 })
    for (const bad of ['', '  ', 'abc', '1e999', '12px']) expect(parseText(row('number'), bad), bad).toEqual({ error: 'Enter a number' })
    expect(parseText(row('list'), ' --a \n\n--b=1\n')).toEqual({ value: ['--a', '--b=1'] })
    expect(parseText(row('list'), '')).toEqual({ value: [] })
    // a map: the name is trimmed, the value kept as typed (it may hold `=` and spaces)
    expect(parseText(row('map'), 'A=1\n B = x=y \n\n')).toEqual({ value: { A: '1', B: ' x=y ' } })
    expect(parseText(row('map'), 'A=1\nnonsense')).toEqual({ error: '“nonsense” is not NAME=value' })
    expect(parseText(row('map'), '=1')).toEqual({ error: '“=1” is not NAME=value' })
    expect(parseText(row('path', { nullable: true }), '  ')).toEqual({ reset: true })
    expect(parseText(row('path', { nullable: true }), ' /a/b ')).toEqual({ value: '/a/b' })
    // a text that may not be empty goes to core as it is: the schema's message comes back to the row
    expect(parseText(row('text'), '')).toEqual({ value: '' })
    // what a control shows for a stored value reads back as that value
    expect(shownText(row('list'), ['a', 'b'])).toBe('a\nb')
    expect(shownText(row('map'), { A: '1', B: 'x=y' })).toBe('A=1\nB=x=y')
    expect(shownText(row('path'), null)).toBe('')
    expect(shownText(row('number'), 1.2)).toBe('1.2')
    for (const [r, v] of [[row('list'), ['a', 'b c']], [row('map'), { A: '1', B: 'x=y' }], [row('number'), 13]] as const) expect(parseText(r, shownText(r, v))).toEqual({ value: v })
    // modified means different from the default, by value
    expect(isModified(row('list', { default: [] }), [])).toBe(false)
    expect(isModified(row('map', { default: {} }), { A: '1' })).toBe(true)
    expect(isModified(row('path', { default: null }), undefined)).toBe(false)
    // core's refusal names the key first; the row shows the rest, the schema's own words
    const size = row('number', { fullKey: 'terminal.fontSize' })
    expect(refusal(size, new Error('terminal.fontSize: Too big: expected number to be <=72'))).toBe('Too big: expected number to be <=72')
    expect(refusal(size, new Error('settings.json does not parse'))).toBe('settings.json does not parse')
    expect(rowId(row('text', { fullKey: 'agents.one.extraArgs' }))).toBe('setting-agents-one-extraArgs')
    // a select names the registered adapters when its values are theirs
    expect(optionsOf(row('select', { optionsFrom: 'agents' }), [{ id: 'one', displayName: 'Agent One' }])).toEqual([{ value: 'one', label: 'Agent One' }])
  })

  it('U-SET-9 · an agent’s card says what was detected or that it is not installed; a holder’s uptime in its two largest units; the notifications note shows only while the permission is denied', () => {
    const info = (over: Partial<AgentInfo>): AgentInfo => ({ id: 'one', displayName: 'Agent One', state: 'ready', version: '1.2.3', path: '/opt/bin/one', loggedIn: true, notice: null, installCommand: 'install one', loginCommand: 'one login', rightButtonMenu: false, options: {} as AgentInfo['options'], defaults: {}, detectedAt: 1, order: 0, ...over })
    expect(agentSummary(null)).toEqual({ state: 'detecting', lines: ['Looking for it…'] })
    expect(agentSummary(info({}))).toEqual({ state: 'installed', lines: ['Version 1.2.3 · Signed in'] })
    expect(agentSummary(info({ state: 'outdated', loggedIn: false, notice: 'Older than Kea was tested with' }))).toEqual({ state: 'installed', lines: ['Version 1.2.3 · Signed out', 'Older than Kea was tested with'] })
    expect(agentSummary(info({ loggedIn: null, version: null }))).toEqual({ state: 'installed', lines: [] })
    expect(agentSummary(info({ state: 'missing', path: null, version: null }))).toEqual({ state: 'missing', lines: ['Not installed'] })
    expect(agentSummary(info({ state: 'pseudo' }))).toEqual({ state: 'none', lines: [] })
    // the card: the path and the lines when installed; "Not installed" with the install command to copy when not
    const cards = (i: AgentInfo) => html(AgentCards, { cards: [{ id: 'one', displayName: 'Agent One', info: i, rows: [] }], value: () => null, onSet: never, onReset: never, onCopy: () => {} })
    const installed = cards(info({}))
    expect(installed).toContain('data-agent-state="installed"')
    expect(installed).toContain('/opt/bin/one')
    expect(installed).not.toContain('install one')
    const missing = cards(info({ state: 'missing', path: null, version: null }))
    expect(missing).toContain('Not installed')
    expect(missing).toContain('install one')
    expect(missing).toContain('aria-label="Copy the install command for Agent One"')
    expect(cards(info({ loggedIn: false }))).toContain('aria-label="Copy the sign-in command for Agent One"')

    const [s, min, h, d] = [1000, 60_000, 3_600_000, 86_400_000]
    expect(uptimeText(null, 0)).toBe('')
    expect(uptimeText(0, 4 * s)).toBe('4 s')
    expect(uptimeText(0, 59 * s + 999)).toBe('59 s')
    expect(uptimeText(0, 5 * min + 30 * s)).toBe('5 min')
    expect(uptimeText(0, 3 * h)).toBe('3 h')
    expect(uptimeText(0, 3 * h + 20 * min)).toBe('3 h 20 min')
    expect(uptimeText(0, 2 * d + 5 * h + 59 * min)).toBe('2 d 5 h')
    expect(uptimeText(0, 2 * d)).toBe('2 d')
    expect(uptimeText(10 * s, 0), 'a clock that went back').toBe('0 s')

    expect(html(NotificationsNote, { denied: false, onOpen: () => {} }).trim()).toBe('')
    const note = html(NotificationsNote, { denied: true, onOpen: () => {} })
    expect(note).toContain('data-notifications="denied"')
    expect(note).toMatch(/<button class="link-button"[^>]*>Notification Settings…<\/button>/)
  })
})
