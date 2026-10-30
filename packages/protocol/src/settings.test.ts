import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { allSettingDefs, parseSettings, SETTINGS, type AgentSettingsExtension, type SettingsSection } from './settings.ts'

const claude: AgentSettingsExtension = {
  id: 'claude',
  displayName: 'Claude Code',
  defaults: { model: 'default', permissionMode: 'manual' },
  keys: [
    {
      key: 'renderer',
      schema: z.enum(['agent-default', 'fullscreen', 'classic']),
      default: 'agent-default',
      label: 'Claude renderer',
      section: 'Agents',
      control: 'select',
      options: [
        { value: 'agent-default', label: 'Agent default' },
        { value: 'fullscreen', label: 'Fullscreen' },
        { value: 'classic', label: 'Classic' },
      ],
    },
  ],
}

describe('settings schema', () => {
  it('U-SET-1 · defaults apply when the file is empty', () => {
    const { values, notices } = parseSettings({}, [claude])
    expect(notices).toEqual([])
    for (const d of SETTINGS) expect(values.get(d.key)).toEqual(d.default)
    expect(values.agent('claude').defaults).toEqual({ model: 'default', permissionMode: 'manual' })
    expect(values.get('agents.claude.renderer')).toBe('agent-default')
  })

  it('U-SET-1 · an invalid value falls back per key with a notice; valid neighbours are kept', () => {
    const { values, notices } = parseSettings({ terminal: { fontSize: 'huge', fontFamily: 'Berkeley Mono' }, general: { onQuit: 'explode' } }, [claude])
    expect(values.get('terminal.fontSize')).toBe(13)
    expect(values.get('terminal.fontFamily')).toBe('Berkeley Mono')
    expect(values.get('general.onQuit')).toBe('menuBar')
    expect(notices.map((n) => n.key).sort()).toEqual(['general.onQuit', 'terminal.fontSize'])
  })

  it('U-SET-1 · unknown keys are ignored by validation (the file editor preserves them)', () => {
    const { values, notices } = parseSettings({ mystery: { x: 1 }, terminal: { zzz: true } }, [])
    expect(notices).toEqual([])
    expect(() => values.get('mystery.x')).toThrow()
  })

  it('U-SET-1 · agent defaults merge the user’s over the adapter’s', () => {
    const { values } = parseSettings({ agents: { claude: { defaults: { model: 'fable', effort: 'high' } } } }, [claude])
    expect(values.agent('claude').defaults).toEqual({ model: 'fable', effort: 'high', permissionMode: 'manual' })
  })

  it('U-SET-3 · every key is a complete row descriptor: label, section, a valid default and a control', () => {
    const sections: SettingsSection[] = ['General', 'Terminal', 'Agents', 'Notifications', 'Files', 'Updates', 'file only']
    const defs = allSettingDefs([claude])
    for (const d of defs) {
      expect(d.label.length, d.fullKey).toBeGreaterThan(0)
      expect(sections, d.fullKey).toContain(d.section)
      expect(d.schema.safeParse(d.default).success, d.fullKey).toBe(true)
      // A key the UI does not render is either file-only or edited by a custom control (agent defaults).
      if (d.section === 'file only') expect(d.control, d.fullKey).toBe('none')
      // Agent keys sit in the Agents section; global keys never do.
      expect(d.section === 'Agents', d.fullKey).toBe(d.agent !== undefined)
    }
    expect(new Set(defs.map((d) => d.fullKey)).size).toBe(defs.length)
  })

  it('U-SET-3 · a select lists every allowed value exactly once (or names its run-time source), and nothing else', () => {
    for (const d of allSettingDefs([claude])) {
      if (d.control !== 'select') {
        expect(d.options ?? d.optionsFrom, d.fullKey).toBeUndefined()
        continue
      }
      expect(!!d.options !== !!d.optionsFrom, `${d.fullKey}: options xor optionsFrom`).toBe(true)
      if (!d.options) continue
      const values = d.options.map((o) => o.value)
      expect(new Set(values).size, d.fullKey).toBe(values.length)
      for (const o of d.options) {
        expect(o.label.length, d.fullKey).toBeGreaterThan(0)
        expect(d.schema.safeParse(o.value).success, `${d.fullKey}=${o.value}`).toBe(true)
      }
      expect(values, d.fullKey).toContain(d.default)
      // For an enum schema the list is complete: no allowed value is missing from the UI.
      const enumValues = (d.schema as { options?: unknown }).options
      if (Array.isArray(enumValues)) expect([...values].sort(), d.fullKey).toEqual([...enumValues].sort())
    }
  })

  it('U-SET-3 · adapter keys appear under their agent after the shared agent keys', () => {
    const defs = allSettingDefs([claude]).filter((d) => d.agent === 'claude')
    expect(defs.at(-1)?.fullKey).toBe('agents.claude.renderer')
    expect(defs.map((d) => d.key)).toEqual(['command', 'defaults', 'allowDangerousModes', 'extraArgs', 'env', 'throughLoginShell', 'renderer'])
  })

  it('U-SET-10 · the Updates section holds the switch for checking by itself, a toggle on by default, which only Settings › About draws', () => {
    const rows = allSettingDefs([claude]).filter((d) => d.section === 'Updates')
    expect(rows.map((d) => d.fullKey)).toEqual(['updates.check'])
    expect(rows[0]).toMatchObject({ control: 'toggle', default: true, label: 'Check for updates automatically' })
    expect(rows[0]!.help).toMatch(/no identifier and no cookie/)
  })

  it('U-SET-11 · every setting in the table is named as a string by code outside the table and the tests, so no row of Settings is a switch that does nothing', () => {
    // keys that are stored and shown without a reader, each with the reason
    const unread: Record<string, string> = {}
    const root = path.resolve(import.meta.dirname, '../../..')
    const skip = new Set(['node_modules', 'dist', 'out', 'target', '.svelte-kit', 'generated'])
    const text: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!skip.has(e.name)) walk(path.join(dir, e.name))
        } else if (/\.(ts|svelte)$/.test(e.name) && !/\.test\./.test(e.name)) {
          // the table's own rows do not count as a reader
          text.push(fs.readFileSync(path.join(dir, e.name), 'utf8').split('\n').filter((l) => !/^\s*\{ key: '/.test(l)).join('\n'))
        }
      }
    }
    for (const top of ['app', 'packages']) for (const pkg of fs.readdirSync(path.join(root, top))) if (fs.existsSync(path.join(root, top, pkg, 'src'))) walk(path.join(root, top, pkg, 'src'))
    const all = text.join('\n')
    const dead = SETTINGS.map((d) => d.key).filter((k) => !all.includes(`'${k}'`) && !all.includes(`"${k}"`) && !(k in unread))
    expect(dead).toEqual([])
    // an entry whose key has a reader is removed from the list
    expect(Object.keys(unread).filter((k) => all.includes(`'${k}'`) || all.includes(`"${k}"`))).toEqual([])
  })
})
