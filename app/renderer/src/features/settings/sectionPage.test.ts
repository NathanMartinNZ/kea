// The generated Settings pages draw the rows as this system offers them: core's description (`settings.describe`: on
// Linux no backup row, and the terminal app offers Automatic and this system's apps) once core has answered, and
// the schema's own rows until then, which already leave out what this system never has. So Linux's General page never
// shows "Exclude build folders from Time Machine" or macOS's terminal apps.
import { render } from 'svelte/server'
import { describe, expect, it, vi } from 'vitest'
import { protocolOs, settingRows, type SettingsDescription } from '@kea/protocol'
import { darwin as protocolDarwin } from '@kea/protocol/os/darwin'
import { linux as protocolLinux } from '@kea/protocol/os/linux'
import { sectionRows } from './model.ts'

// core, as the window's RPC: `settings.describe` answers with `core.answer`; no store sends anything
const core = vi.hoisted(() => ({ asked: [] as string[], answer: null as SettingsDescription | null }))
vi.mock('../../lib/rpc.ts', () => ({
  call: (method: string) => {
    core.asked.push(method)
    return core.answer ? Promise.resolve(core.answer) : new Promise(() => {})
  },
  callNow: () => null,
  onPortFirst: () => () => {},
  rpcStats: () => ({ subscriptions: 0, pendingCalls: 0 }),
  subscribe: () => () => {},
}))

const { describeSettings } = await import('./state.svelte.ts')
const { default: SectionPage } = await import('./SectionPage.svelte')

const BACKUP = 'general.excludeBuildDirsFromBackup'
const keysIn = (markup: string) => [...markup.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]!)
const optionsOf = (markup: string, key: string) => {
  const start = markup.indexOf(`data-setting="${key}"`)
  const row = markup.slice(start, markup.indexOf('data-setting="', start + 1) >>> 0 || markup.length)
  return [...row.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]!)
}

describe("Settings draws this system's rows", () => {
  // before U-PLT-38, which has core answer: this one draws the page as it is before any answer
  it('U-PLT-56 · before core answers, the Terminal app select offers Automatic and this system’s apps only: macOS’s never lists Konsole or GNOME Terminal, Linux’s never iTerm or Terminal', () => {
    expect(protocolDarwin.window.terminalApps).toEqual(['ghostty', 'iterm', 'warp', 'kitty', 'wezterm', 'alacritty', 'terminal'])
    expect(protocolLinux.window.terminalApps).toEqual(['ghostty', 'kitty', 'wezterm', 'alacritty', 'konsole', 'ptyxis', 'gnome-terminal', 'x-terminal-emulator'])
    const apps = (os: typeof protocolOs) => settingRows([], os).find((r) => r.key === 'general.terminalApp')?.options?.map((o) => o.value)
    expect(apps(protocolDarwin)).toEqual(['auto', ...protocolDarwin.window.terminalApps])
    expect(apps(protocolLinux)).toEqual(['auto', ...protocolLinux.window.terminalApps])
    const before = render(SectionPage, { props: { section: 'General' } }).body
    expect(optionsOf(before, 'general.terminalApp')).toEqual(['auto', ...protocolOs.window.terminalApps])
  })

  it("U-PLT-38 · a generated page draws core's rows once core answers (this system's terminal apps, no backup row on Linux); the schema's own until then, without the backup row on Linux", async () => {
    // what never applies on a system is left out of its schema rows: the backup exclusion on Linux
    expect(protocolLinux.window.hiddenSettings).toContain(BACKUP)
    expect(protocolDarwin.window.hiddenSettings).not.toContain(BACKUP)
    const own = settingRows([])
    expect(own.some((r) => r.key === BACKUP)).toBe(!protocolOs.window.hiddenSettings.includes(BACKUP))

    // before core answers: the schema's own rows
    const before = render(SectionPage, { props: { section: 'General' } }).body
    expect(keysIn(before)).toEqual(sectionRows(own, 'General').map((r) => r.fullKey))

    // core's answer, as a system that keeps no backup row and offers two terminal apps
    const app = own.find((r) => r.key === 'general.terminalApp')!
    core.answer = {
      rows: own.filter((r) => r.key !== BACKUP).map((r) => (r === app ? { ...r, options: [{ value: 'auto', label: 'Automatic' }, { value: 'konsole', label: 'Konsole' }] } : r)),
      agents: [],
    }
    await describeSettings()
    const after = render(SectionPage, { props: { section: 'General' } }).body
    expect(keysIn(after)).not.toContain(BACKUP)
    expect(optionsOf(after, 'general.terminalApp')).toEqual(['auto', 'konsole'])
    expect(core.asked).toEqual(['settings.describe'])
  })
})
