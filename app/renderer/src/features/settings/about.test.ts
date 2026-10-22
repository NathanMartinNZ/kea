// Settings › About draws what this build is and the platform report: each line as its label and value, and only a line
// that is not the full answer with the warning dot and its fix under it.
import { render } from 'svelte/server'
import { describe, expect, it } from 'vitest'
import type { PlatformReport } from '@kea/protocol'
import { buildFacts, textParts } from './about.ts'

const { default: AboutView } = await import('./AboutView.svelte')

const BUILD = { version: '0.2.0', arch: 'arm64', commit: '57e6b69-dirty', date: '2026-10-20' }

/** What a line of the page holds: its label and value, whether it has the dot, and its fix as drawn (markup), if any. */
function lines(markup: string): { id: string; label: string; value: string; dot: boolean; fix: string | null }[] {
  // Svelte's hydration marks (`<!--[-->`) are no part of what is drawn
  const drawn = markup.replace(/<!--[^>]*-->/g, '')
  return [...drawn.matchAll(/<div class="settings-row about-line"[^>]*data-platform-line="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)].map(([, id, body]) => ({
    id: id!,
    label: /<span class="settings-label">([^<]*)<\/span>/.exec(body!)?.[1] ?? '',
    value: (/<span class="about-text">([^<]*)<\/span>/.exec(body!) ?? /<span class="about-value">([^<]*)<\/span>/.exec(body!))?.[1] ?? '',
    dot: body!.includes('about-dot'),
    fix: /data-platform-fix[^>]*>([\s\S]*?)<\/span>$/.exec(body!.trim())?.[1] ?? null,
  }))
}

describe('Settings › About', () => {
  it('U-PLT-43 · About draws the version, commit and build date, then the system and every line of the report as label and value; a line that is the full answer has no dot and no fix, one that is not leads with the dot and has its fix under it, a command in it as code; while reading, before main has sent it, and when core cannot be asked it says so', () => {
    const mac: PlatformReport = {
      system: 'darwin',
      version: 'macOS 27.0.0',
      arch: 'arm64',
      lines: [
        { id: 'installKind', label: 'Installed', value: 'mac', fix: null },
        { id: 'holderDetach', label: 'Terminals', value: 'each in a process of its own that macOS keeps when Kea quits', fix: null },
        { id: 'terminalRenderer', label: 'Terminal drawing', value: 'WebGL, on the GPU', fix: null },
      ],
    }
    const page = render(AboutView, { props: { build: BUILD, report: mac } }).body
    expect(page).toMatch(/data-version[^>]*>Kea 0\.2\.0</)
    expect(page).toMatch(/data-commit[^>]*>57e6b69-dirty</)
    expect(page).toMatch(/data-build-date[^>]*>2026-10-20</)
    expect(lines(page)).toEqual([
      { id: 'system', label: 'System', value: 'macOS 27.0.0 · arm64', dot: false, fix: null },
      ...mac.lines.map((l) => ({ id: l.id, label: l.label, value: l.value, dot: false, fix: null })),
    ])
    expect(page).not.toContain('data-fix="shown"')

    // a line that is not the full answer: the dot, the value, the fix under it with its command as code
    const linux: PlatformReport = {
      system: 'linux',
      version: 'Linux 6.8.0-49-generic',
      arch: 'arm64',
      lines: [
        { id: 'desktop', label: 'Desktop', value: 'ubuntu:GNOME, Wayland', fix: null },
        { id: 'admission', label: 'Session isolation', value: 'checked by Kea’s executable, but with ptrace_scope 0 any of your processes can trace it', fix: 'Run `sudo sysctl -w kernel.yama.ptrace_scope=1`' },
        { id: 'logout', label: 'After you log out', value: 'sessions end at your last logout, as on macOS', fix: 'Run `loginctl enable-linger` to keep sessions running after you log out' },
      ],
    }
    const drawn = lines(render(AboutView, { props: { build: BUILD, report: linux } }).body)
    expect(drawn.map((l) => [l.id, l.dot])).toEqual([
      ['system', false],
      ['desktop', false],
      ['admission', true],
      ['logout', true],
    ])
    expect(drawn.find((l) => l.id === 'desktop')!.fix).toBeNull()
    expect(drawn.find((l) => l.id === 'admission')!.fix).toBe('Run <code>sudo sysctl -w kernel.yama.ptrace_scope=1</code>')
    expect(drawn.find((l) => l.id === 'logout')!.fix).toBe('Run <code>loginctl enable-linger</code> to keep sessions running after you log out')
    expect(drawn.find((l) => l.id === 'admission')!.value).toBe(linux.lines[1]!.value)

    // the states before there are lines to draw
    expect(render(AboutView, { props: { build: BUILD, report: undefined } }).body).toContain('data-platform="reading"')
    expect(render(AboutView, { props: { build: BUILD, report: null } }).body).toContain('data-platform="none"')
    expect(render(AboutView, { props: { build: BUILD, report: null, error: 'core is restarting' } }).body).toMatch(/data-platform="failed"[^>]*>Couldn’t read the platform report: core is restarting</)
    // a build made outside a checkout knows no commit (the unit tests' own build defines neither)
    expect(buildFacts({ version: '0.2.0', arch: 'x64' })).toEqual({ version: '0.2.0', arch: 'x64', commit: null, date: null })
    const unknown = render(AboutView, { props: { build: { ...BUILD, commit: null, date: null }, report: mac } }).body
    expect(unknown).toMatch(/data-commit[^>]*>not known: built outside a git checkout</)
    expect(unknown).toMatch(/data-build-date[^>]*>not known</)

    // a sentence's commands, between backticks; one that is never closed stays as written
    expect(textParts('Run `a b` then `c`.')).toEqual([
      { text: 'Run ', code: false },
      { text: 'a b', code: true },
      { text: ' then ', code: false },
      { text: 'c', code: true },
      { text: '.', code: false },
    ])
    expect(textParts('no command')).toEqual([{ text: 'no command', code: false }])
    expect(textParts('an `open one')).toEqual([
      { text: 'an ', code: false },
      { text: '`open one', code: false },
    ])
  })
})
