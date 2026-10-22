// The release checks on both systems, the readers of Linux's package listings, and what the linters may say.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareListing, elfMachine, filesNaming, filesUnder, foreignElves, machineNeedles, modeOf, parseRpmListing, parseTarListing } from './checks.ts'
import { acceptedFor, ACCEPTED_LINTIAN, ACCEPTED_RPMLINT, lintProblems } from './os/linuxLint.ts'

describe('package checks', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-chk-'))
    dirs.push(d)
    return d
  }
  const elf = (machine: number) => {
    const b = Buffer.alloc(64)
    b.writeUInt32BE(0x7f454c46, 0)
    b.writeUInt16LE(machine, 18)
    return b
  }

  // No shipped file names the build machine: its home, its user as a folder, its host (short and full; names under
  // three characters and `localhost` are not looked for). Every ELF is the target's machine.
  it('U-PACK-37 · nothing names the build machine; every ELF is the target’s; the listing has the packages’ modes and root owns it all', () => {
    expect(machineNeedles({ home: '/home/builder/', user: 'builder', host: 'box-7.example.net' })).toEqual(['/home/builder', '/builder/', 'box-7.example.net', 'box-7'])
    expect(machineNeedles({ home: '/', user: 'me', host: 'localhost' })).toEqual([])
    const d = tmp()
    fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(d, 'a', 'clean.node'), Buffer.concat([Buffer.from('lib\0'), Buffer.from('/home/other/x')]))
    fs.writeFileSync(path.join(d, 'a', 'b', 'dirty.node'), Buffer.concat([Buffer.alloc(100), Buffer.from('/home/builder/src/x.cc\0')]))
    fs.writeFileSync(path.join(d, 'host.txt'), 'built on box-7 today')
    expect(filesUnder(d)).toEqual(['a/b/dirty.node', 'a/clean.node', 'host.txt'])
    expect(filesNaming(d, machineNeedles({ home: '/home/builder', user: 'builder', host: 'box-7.example.net' }))).toEqual(['a/b/dirty.node names this machine ("/home/builder")', 'host.txt names this machine ("box-7")'])

    fs.writeFileSync(path.join(d, 'arm'), elf(183))
    fs.writeFileSync(path.join(d, 'x64'), elf(62))
    expect(elfMachine(path.join(d, 'arm'))).toBe(183)
    expect(elfMachine(path.join(d, 'host.txt'))).toBeNull()
    expect(foreignElves(d, 'arm64')).toEqual({ wrong: ['x64 is built for ELF machine 62, not arm64 (183)'], count: 2 })

    expect(modeOf('-rwsr-xr-x')).toBe(0o4755)
    expect(modeOf('drwxr-xr-x')).toBe(0o755)
    expect(modeOf('-rw-r--r--')).toBe(0o644)
    expect(modeOf('-rwSr-sr-T')).toBe(0o7654)
    expect(() => modeOf('crw-------')).toThrow(/not a mode/)
    const tar = parseTarListing(
      [
        'drwxr-xr-x root/root         0 2026-10-21 12:00 kea-app-0.1.0-linux-arm64/',
        'drwxr-xr-x root/root         0 2026-10-21 12:00 kea-app-0.1.0-linux-arm64/opt/',
        '-rwsr-xr-x root/root     12345 2026-10-21 12:00 kea-app-0.1.0-linux-arm64/opt/Kea/chrome-sandbox',
        '-rw-r--r-- root/root         9 2026-10-21 12:00 kea-app-0.1.0-linux-arm64/opt/Kea/a file with spaces',
      ].join('\n'),
      1,
    )
    expect(tar).toEqual([
      { path: '/opt', mode: 0o755, owner: 'root', group: 'root', dir: true },
      { path: '/opt/Kea/chrome-sandbox', mode: 0o4755, owner: 'root', group: 'root', dir: false },
      { path: '/opt/Kea/a file with spaces', mode: 0o644, owner: 'root', group: 'root', dir: false },
    ])
    expect(parseTarListing('drwxr-xr-x root/root 0 2026-10-21 12:00 ./\n-rwxr-xr-x root/root 5 2026-10-21 12:00 ./opt/Kea/kea-app')).toEqual([{ path: '/opt/Kea/kea-app', mode: 0o755, owner: 'root', group: 'root', dir: false }])
    expect(parseRpmListing('-rwsr-xr-x root root /opt/Kea/chrome-sandbox\ndrwxr-xr-x root root /opt/Kea\n')).toEqual([
      { path: '/opt/Kea/chrome-sandbox', mode: 0o4755, owner: 'root', group: 'root', dir: false },
      { path: '/opt/Kea', mode: 0o755, owner: 'root', group: 'root', dir: true },
    ])

    const staged = [
      { path: '/opt/Kea', mode: 0o755, dir: true },
      { path: '/opt/Kea/chrome-sandbox', mode: 0o4755, dir: false },
    ]
    const sys = (p: string) => !p.startsWith('/opt/Kea')
    const ok = [
      { path: '/opt', mode: 0o755, owner: 'root', group: 'root', dir: true },
      { path: '/opt/Kea', mode: 0o755, owner: 'root', group: 'root', dir: true },
      { path: '/opt/Kea/chrome-sandbox', mode: 0o4755, owner: 'root', group: 'root', dir: false },
    ]
    expect(compareListing(staged, ok, { systemDirs: sys })).toEqual([])
    expect(compareListing(staged, [ok[1]!, { ...ok[2]!, mode: 0o755, owner: 'builder' }, { path: '/opt/Kea/stray', mode: 0o644, owner: 'root', group: 'root', dir: false }, { ...ok[0]!, mode: 0o775 }], { systemDirs: sys })).toEqual([
      '/opt/Kea/chrome-sandbox has mode 755, not 4755',
      '/opt/Kea/chrome-sandbox is owned by builder:root, not root:root',
      '/opt/Kea/stray is in the package but was not staged',
      '/opt has mode 775, not 755',
    ])
    expect(compareListing(staged, [ok[1]!], { systemDirs: sys })).toEqual(['/opt/Kea/chrome-sandbox is missing'])
  })

  // lintian's and rpmlint's errors and warnings stop the run unless their tag is accepted (with its reason, in
  // tools/pack); information, pedantic and summary lines are not problems.
  it('U-PACK-38 · lintian and rpmlint: an error or warning stops the run unless its tag is accepted', () => {
    const lintian = ['E: kea-app: embedded-library libz [opt/Kea/kea-app]', 'W: kea-app: no-manual-page [usr/bin/kea-app]', 'I: kea-app: description-synopsis-might-not-be-phrased-properly', 'P: kea-app: something-pedantic', 'N: a note'].join('\n')
    expect(lintProblems(lintian, [])).toEqual(['E: kea-app: embedded-library libz [opt/Kea/kea-app]', 'W: kea-app: no-manual-page [usr/bin/kea-app]'])
    expect(lintProblems(lintian, [{ tag: 'no-manual-page', why: 'x' }])).toEqual(['E: kea-app: embedded-library libz [opt/Kea/kea-app]'])
    expect(lintProblems('E: kea-app source: some-source-tag x', [])).toEqual(['E: kea-app source: some-source-tag x'])
    // a placeholder (such as the packages' maintainer address) is accepted, but not in a release build
    const placeholder = { tag: 'bogus-mail-host', why: 'x', untilRelease: true as const }
    expect(acceptedFor([placeholder, { tag: 'no-changelog', why: 'y' }], false).map((a) => a.tag)).toEqual(['bogus-mail-host', 'no-changelog'])
    expect(acceptedFor([placeholder, { tag: 'no-changelog', why: 'y' }], true).map((a) => a.tag)).toEqual(['no-changelog'])
    for (const a of [...ACCEPTED_LINTIAN, ...ACCEPTED_RPMLINT]) expect(a.why.length, a.tag).toBeGreaterThan(20)
    const rpmlint = ['kea-app.aarch64: E: statically-linked-binary /opt/Kea/kea-helper', 'kea-app.aarch64: W: no-documentation', '1 packages and 0 specfiles checked; 1 errors, 1 warnings, 0 badness; has taken 1.2 s'].join('\n')
    expect(lintProblems(rpmlint, [{ tag: 'no-documentation', why: 'x' }])).toEqual(['kea-app.aarch64: E: statically-linked-binary /opt/Kea/kea-helper'])
  })
})
