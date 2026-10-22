import { describe, expect, it } from 'vitest'
import type { Banner, SettingsStatus } from '@kea/protocol'
import { bannerLines, settingsBanner } from './banners.ts'

const status = (over: Partial<SettingsStatus> = {}): SettingsStatus => ({ path: '/srv/kea-home/settings.json', exists: true, error: null, notices: [], ...over })
const banner = (over: Partial<Banner>): Banner => ({ kind: 'gitMissing', source: 'git', severity: 'error', message: 'git was not found.', fix: 'Install Xcode Command Line Tools: xcode-select --install', at: 1, ...over })

describe('the banner strip', () => {
  it('U-BANNER-1 · a settings parse error names its line and column and offers the file; fallback notices are one warning; core’s banners follow, errors first then oldest; nothing to say is no strip', () => {
    expect(settingsBanner(null)).toBeNull()
    expect(settingsBanner(status())).toBeNull()
    expect(bannerLines(status(), [])).toEqual([])

    const broken = settingsBanner(status({ error: { message: 'Property expected', line: 12, column: 5, offset: 200 } }))
    expect(broken).toMatchObject({ key: 'settings', severity: 'error', opensSettings: true })
    expect(broken!.message).toBe('settings.json has an error at line 12, column 5: Property expected.')
    expect(broken!.fix).toContain('last good settings')

    const notices = [
      { key: 'terminal.fontSize', message: 'terminal.fontSize: too small — using the default' },
      { key: 'general.sessionOrder', message: 'general.sessionOrder: invalid value — using the default' },
    ]
    expect(settingsBanner(status({ notices: notices.slice(0, 1) }))).toMatchObject({ severity: 'warning', message: notices[0]!.message })
    expect(settingsBanner(status({ notices }))!.message).toBe(`${notices[0]!.message} (and 1 more)`)

    const lines = bannerLines(status({ notices: notices.slice(0, 1) }), [
      banner({ kind: 'diskFull', source: 'ptyhost', severity: 'warning', message: 'The disk is full.', fix: null, at: 1 }),
      banner({ kind: 'notDetached', source: 'ptyhost', severity: 'error', message: 'Terminals are not detached.', at: 3 }),
      banner({ kind: 'gitMissing', at: 2 }),
    ])
    expect(lines.map((l) => l.key)).toEqual(['settings', 'gitMissing', 'notDetached', 'diskFull'])
    expect(lines.filter((l) => l.opensSettings).map((l) => l.key)).toEqual(['settings'])
    expect(lines[1]!.fix).toContain('xcode-select')
  })
})
