import { describe, expect, it } from 'vitest'
import { outsidePaths, scrubber } from './diagnostics.ts'
import { darwin } from './os/darwin.ts'
import { protocolOs } from './os/index.ts'
import { linux } from './os/linux.ts'
import { isAvailable, need, notAvailable, NotAvailableError, platformLineText, platformSection, scrubbedReport, systemOf, unavailable, zPlatformReport, type PlatformReport } from './platform.ts'
import { isChildToMain, isMainToChild } from './process.ts'

describe('the OS layer', () => {
  it('U-PLT-11 · the shared vocabulary: systems, "not available" with its reason, the report schema', () => {
    expect([systemOf('darwin'), systemOf('linux')]).toEqual(['darwin', 'linux'])
    expect(() => systemOf('win32')).toThrow(/macOS and Linux only/)
    const missing = notAvailable('Not here yet.')
    expect(isAvailable(missing)).toBe(false)
    expect(isAvailable({ label: () => '' })).toBe(true)
    expect(() => need(missing)).toThrow(NotAvailableError)
    expect(() => need(missing)).toThrow('Not here yet.')
    const layer = { system: 'linux' as const, a: missing, b: { run: () => 0 } }
    expect(unavailable(layer)).toEqual([{ capability: 'a', reason: 'Not here yet.' }])
    const line = { id: 'trayHost', label: 'Background', value: 'the menu bar', fix: null }
    expect(zPlatformReport.safeParse({ system: 'darwin', version: 'macOS 27.0', arch: 'arm64', lines: [line] }).success).toBe(true)
    expect(zPlatformReport.safeParse({ system: 'darwin', version: 'macOS 27.0', arch: 'arm64', lines: [line, line] }).success, 'a line twice').toBe(false)
    expect(zPlatformReport.safeParse({ system: 'win32', version: 'x', arch: 'x', lines: [] }).success).toBe(false)
    expect(zPlatformReport.safeParse({ system: 'linux', version: 'x', arch: 'x', lines: [{ ...line, id: 'nope' }] }).success).toBe(false)
  })

  it("U-PLT-11 · protocol's layer: chosen once for this system; both systems have every capability (Linux's keys too)", () => {
    expect(protocolOs).toBe(systemOf(process.platform) === 'linux' ? linux : darwin) // os-ok: the layer of the system this runs on (both run this suite)
    expect(unavailable(darwin)).toEqual([])
    expect(unavailable(linux)).toEqual([])
    expect(need(darwin.keys).label({ key: 'p', cmd: true, shift: true, alt: false, ctrl: false })).toBe('⇧⌘P')
    expect(need(linux.keys).label({ key: 'p', cmd: false, shift: true, alt: false, ctrl: true })).toBe('Ctrl+Shift+P')
  })
})

describe('the platform report shown', () => {
  // a report as Linux makes one in a dev checkout: a line without a fix, two with one, the sandbox's naming a path in the user's home
  const HOME = '/home/ktest'
  const helper = `${HOME}/kea-src/node_modules/electron/dist/chrome-sandbox`
  const report: PlatformReport = {
    system: 'linux',
    version: 'Linux 6.8.0-49-generic',
    arch: 'arm64',
    lines: [
      { id: 'desktop', label: 'Desktop', value: 'ubuntu:GNOME, Wayland', fix: null },
      { id: 'admission', label: 'Session isolation', value: "checked by Kea's executable, but with ptrace_scope 0 any of your processes can trace it", fix: 'Run `sudo sysctl -w kernel.yama.ptrace_scope=1`' },
      { id: 'rendererSandbox', label: 'Window sandbox', value: 'off: the window runs without Chromium’s sandbox', fix: `Start Kea without --no-sandbox; if Chromium cannot start its sandbox, run sudo chown root:root ${helper} and sudo chmod 4755 ${helper}.` },
    ],
  }

  it('U-PLT-44 · the report as text (Copy Diagnostics): the system, then each line as label and value, its fix after it only where it is not the full answer; scrubbed, no path is left, in the text or in a status report’s copy; main → core carries a report only when it is one, core → main the inotify limit as held or not', () => {
    const asIs = (t: string): string => t
    expect(platformLineText(report.lines[0]!)).toBe('Desktop: ubuntu:GNOME, Wayland')
    expect(platformLineText(report.lines[1]!)).toBe("Session isolation: checked by Kea's executable, but with ptrace_scope 0 any of your processes can trace it. Fix: Run `sudo sysctl -w kernel.yama.ptrace_scope=1`")
    expect(platformSection(report, asIs)).toEqual(['## Platform', 'Linux 6.8.0-49-generic · arm64', ...report.lines.map(platformLineText)])
    expect(platformSection(null, asIs)).toEqual(['## Platform', 'not known yet: main has not sent the platform report'])

    // scrubbed as a text without paths is: the helper's path goes, the command between backticks stays (it names no path)
    const scrub = scrubber({ home: '/home/ktest/.kea-dev', roots: [HOME] })
    const text = platformSection(report, scrub).join('\n')
    expect(text).not.toContain(HOME)
    expect(outsidePaths(text)).toEqual([])
    expect(text).toContain('Fix: Run `sudo sysctl -w kernel.yama.ptrace_scope=1`')
    expect(text).toContain('Desktop: ubuntu:GNOME, Wayland')
    const copy = scrubbedReport(report, scrub)
    expect(zPlatformReport.safeParse(copy).success).toBe(true)
    expect(JSON.stringify(copy)).not.toContain(HOME)
    expect(copy.lines.map((l) => [l.id, l.fix === null])).toEqual(report.lines.map((l) => [l.id, l.fix === null]))
    expect(copy.lines[0]).toEqual(report.lines[0])

    // what crosses between main and core
    expect(isMainToChild({ k: 'platform', report })).toBe(true)
    for (const bad of [null, {}, { ...report, system: 'win32' }, { ...report, lines: [report.lines[0], report.lines[0]] }, { ...report, lines: [{ ...report.lines[0], fix: '' }] }]) expect(isMainToChild({ k: 'platform', report: bad }), JSON.stringify(bad)).toBe(false)
    expect(isChildToMain({ k: 'watchLimit', held: true })).toBe(true)
    expect(isChildToMain({ k: 'watchLimit', held: false })).toBe(true)
    expect(isChildToMain({ k: 'watchLimit', held: 1 })).toBe(false)
    expect(isChildToMain({ k: 'watchLimit' })).toBe(false)
  })
})
