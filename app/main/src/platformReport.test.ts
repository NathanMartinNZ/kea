// The platform report as main keeps it: assembled at each core's start and on each change, and handed to core
// only when that core has not had it.
import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@kea/kit'
import type { PlatformLine, PlatformReport } from '@kea/protocol'
import { PlatformReports } from './platformReport.ts'

const line = (id: PlatformLine['id'], value: string, fix: string | null = null): PlatformLine => ({ id, label: id, value, fix })

describe('the platform report main keeps', () => {
  it('U-PLT-45 · assembled as each core starts and again on each change, kept as the last; core is sent it only when it differs from what that core has, a new core gets it whatever was sent before, and with no core ready it waits for one; a report that cannot be made keeps the last; the log names the lines that have a fix, never their words', () => {
    let tray = 'a tray icon'
    let fail = false
    const build = (): PlatformReport => {
      if (fail) throw new Error('/proc is gone')
      return { system: 'linux', version: 'Linux 6.8.0', arch: 'arm64', lines: [line('trayHost', tray, tray === 'none' ? 'Install your desktop’s AppIndicator support.' : null)] }
    }
    let coreUp = false
    const sent: PlatformReport[] = []
    const log = createMemoryLogger()
    const reports = new PlatformReports({ build, send: (r) => coreUp && sent.push(r) > 0, log })

    // no core yet: assembled and kept, nothing sent
    expect(reports.assemble('window')?.lines[0]?.value).toBe('a tray icon')
    expect(sent).toHaveLength(0)
    expect(reports.latest?.lines[0]?.value).toBe('a tray icon')

    // the core becomes ready: it gets the report; the same report again is not sent again
    coreUp = true
    reports.coreReady()
    reports.assemble('gpu')
    reports.assemble('window')
    expect(sent).toHaveLength(1)

    // a capability changes: the new report goes once
    tray = 'none'
    reports.assemble('services')
    reports.assemble('services')
    expect(sent.map((r) => r.lines[0]?.value)).toEqual(['a tray icon', 'none'])
    expect(sent[1]?.lines[0]?.fix).toBe('Install your desktop’s AppIndicator support.')

    // a restarted core knows nothing: it gets the report though it is the one sent last
    reports.coreReady()
    expect(sent).toHaveLength(3)
    expect(sent[2]).toEqual(sent[1])

    // core away when the report changes: kept, and the next core gets it
    coreUp = false
    tray = 'a tray icon'
    reports.assemble('services')
    expect(sent).toHaveLength(3)
    coreUp = true
    reports.coreReady()
    expect(sent.at(-1)?.lines[0]?.value).toBe('a tray icon')

    // a report that cannot be made: the last one stays, and the failure is logged
    fail = true
    expect(reports.assemble('watchLimit')).toEqual(sent.at(-1))
    expect(log.entries.some((e) => e.msg === 'platform report not assembled' && e.why === 'watchLimit')).toBe(true)

    // the log: one line per change, with the ids of the lines that have a fix, not their text
    const changes = log.entries.filter((e) => e.msg === 'platform report')
    expect(changes.map((e) => [e.why, e.fixes])).toEqual([
      ['window', []],
      ['services', ['trayHost']],
      ['services', []],
    ])
    expect(JSON.stringify(log.entries)).not.toContain('AppIndicator')

    // a system without the capability gives none: nothing kept or sent
    const none = new PlatformReports({ build: () => null, send: () => true, log })
    expect(none.assemble('coreReady')).toBeNull()
    expect(none.latest).toBeNull()
  })
})
