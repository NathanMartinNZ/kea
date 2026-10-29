import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { need, PLATFORM_LINES, systemOf, unavailable, zPlatformReport } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { darwin } from './darwin.ts'
import { mainOs, type ReportInput } from './index.ts'
import { linux } from './linux.ts'

describe("main's OS layer", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  /** What main gathers for the report, as a Mac with a GPU gives it. */
  const input = (o: Partial<ReportInput>): ReportInput => ({ version: '27.0.0', arch: 'arm64', resourcesDir: '', execPath: '/Applications/Kea.app/Contents/MacOS/Kea', webgl2: 'enabled', trayHost: true, notificationService: true, rendererPid: null, corePid: null, idle: 'system', watchLimitHeld: null, display: 'quartz', desktopId: 'dev.kea.app', displayScale: 2, ...o })
  const resources = (installKind?: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-plt-'))
    dirs.push(d)
    if (installKind !== undefined) fs.writeFileSync(path.join(d, 'install-kind'), installKind)
    return d
  }

  it('U-PLT-55 · a Mac without WebGL2 (a virtual machine, a GPU Chromium blocks): the terminal line names the DOM renderer and carries no fix, as every macOS line is the full answer; Linux’s carries the GPU driver fix', () => {
    for (const webgl2 of ['disabled_off', 'unavailable_software', '']) {
      const report = need(darwin.report).platform(input({ resourcesDir: resources('mac\n'), webgl2 }))
      const line = report.lines.find((l) => l.id === 'terminalRenderer')!
      expect(line.value, webgl2).toMatch(/^xterm's DOM renderer/)
      expect(report.lines.map((l) => l.fix), webgl2).toEqual(report.lines.map(() => null))
    }
    const lin = need(linux.report).platform(input({ webgl2: 'disabled_off', display: 'x11' })).lines.find((l) => l.id === 'terminalRenderer')!
    expect(lin.fix).toMatch(/GPU driver/)
  })

  it('U-PLT-11 · the macOS platform report: schema-valid, its lines in the order About shows them, each the full answer; the install kind as recorded', () => {
    const report = need(darwin.report).platform(input({ resourcesDir: resources('mac\n') }))
    expect(zPlatformReport.parse(report)).toEqual(report)
    expect([report.system, report.version, report.arch]).toEqual(['darwin', 'macOS 27.0.0', 'arm64'])
    const ids = report.lines.map((l) => l.id)
    expect(ids).toEqual(PLATFORM_LINES.filter((id) => ids.includes(id)))
    expect(ids).toEqual(['installKind', 'holderDetach', 'admission', 'rendererSandbox', 'terminalRenderer', 'trayHost', 'notifications'])
    expect(report.lines.map((l) => l.fix)).toEqual(ids.map(() => null))
    expect(report.lines.find((l) => l.id === 'installKind')!.value).toBe('mac')
    // a dev build or `pnpm kea:install` records none; a file that names no kind counts as none
    for (const dir of [resources(), resources('apt\n')]) {
      expect(need(darwin.installKind).read(dir)).toBeNull()
      expect(need(darwin.report).platform(input({ resourcesDir: dir })).lines[0]!.value).toMatch(/^by hand/)
    }
  })

  it("U-PLT-11 · main's layer: chosen once for this system; macOS has every capability; each one Linux lacks says why in one sentence", () => {
    expect(mainOs).toBe(systemOf(process.platform) === 'linux' ? linux : darwin) // os-ok: the layer of the system this runs on (both systems run this suite)
    expect(unavailable(darwin)).toEqual([])
    expect(unavailable(linux).length).toBeGreaterThan(0)
    for (const u of unavailable(linux)) expect(u.reason, u.capability).toMatch(/^[A-Z][^\n]*\.$/)
  })
})
