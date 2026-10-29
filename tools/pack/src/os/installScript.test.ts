// install.sh: the build that writes a release's values into the template, and the script's safety as a
// download: cut anywhere, it runs nothing. Its behaviour on real systems is tested by install-e2e.sh (containers) and
// install-macos.sh (a macOS VM).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '../../../../packages/protocol/src/generated/limits.ts'
import { RELEASE_REPOSITORY } from '../../../../packages/protocol/src/release.ts'
import { CERTIFICATE_LEAF } from '../release.ts'
import { UPDATER_CACHE } from '../installFiles.ts'
import { APP_ID } from '../target.ts'
import { SIGNING, standInRelease } from './installFixtures.ts'
import { armor, buildInstallScript, dearmor, keyFingerprint, RELEASE_KEY, releaseValues, tarballFiles, TEMPLATE } from './installScript.ts'
import { aptSourceText, rpmRepoText, zypperRepoText } from './linuxPackage.ts'

// RFC 9580's sample keys (Appendix A.3 and A.4), with the fingerprints the RFC gives them: an outside oracle
const V4_KEY = Buffer.from('xjMEU/NfCxYJKwYBBAHaRw8BAQdAPwmJlL3ZFu1AUxl5NOSofIBzOhKA1i+AEJkuQ+47JAY=', 'base64')
const V4_FPR = 'C959BDBAFA32A2F89A153B678CFDE12197965A9A'
const V6_KEY = Buffer.from('c62a0663877fe31b00000020f94da7bb48d60a61e567706a6587d0331999bb9d891a08242ead84543df895a3', 'hex')
const V6_FPR = 'CB186C4F0609A697E4D52DFA6C722B0C1F1E27C18A56708F6525EC27BAD9ACC9'

const template = fs.readFileSync(TEMPLATE, 'utf8')
const values = { repository: 'some-owner/kea', fingerprint: V4_FPR, leaf: CERTIFICATE_LEAF }
const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((s) => fs.existsSync(s))

/** `f` over `items`, at most `limit` at a time; the results in the items' order. */
async function inParallel<T, R>(items: readonly T[], limit: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const k = next++
      out[k] = await f(items[k] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

describe('install.sh', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-install-'))
    dirs.push(d)
    return d
  }

  // The build writes in what a release names: the repository, the key's fingerprint, the certificate's leaf, the oldest
  // versions from constants/, the repository files as the packages write them and the tarball's outside files; it
  // leaves no @@ and refuses values that are not one; a release's build refuses while the repository or key is missing.
  // The script is one function, called inside braces on its last line, with nothing else outside it.
  it('U-PACK-42 · the build: the release’s values written in from one place each, nothing left over; a release refused while unnamed; one function called last', () => {
    expect(keyFingerprint(V4_KEY)).toBe(V4_FPR)
    expect(keyFingerprint(V6_KEY)).toBe(V6_FPR)
    const armoured = ['-----BEGIN PGP PUBLIC KEY BLOCK-----', 'Comment: a header', '', V4_KEY.toString('base64'), '=abcd', '-----END PGP PUBLIC KEY BLOCK-----', ''].join('\n')
    expect(dearmor(Buffer.from(armoured)).equals(V4_KEY)).toBe(true)
    expect(keyFingerprint(Buffer.from(armoured))).toBe(V4_FPR)
    expect(() => keyFingerprint(Buffer.from([0xb4, 0x01, 0x00])), 'a user ID packet first').toThrow(/not a public key/)
    expect(() => keyFingerprint(Buffer.from('hello'))).toThrow(/not an OpenPGP key/)

    const s = buildInstallScript(template, values)
    expect(s).not.toContain('@@')
    expect(s).toContain("repository='some-owner/kea'")
    expect(s).toContain(`key_fingerprint='${V4_FPR}'`)
    expect(s).toContain(`certificate_leaf='${CERTIFICATE_LEAF}'`)
    expect(s).toContain(`git_min_major='${L.gitMinMajor}'`)
    expect(s).toContain(`git_min_minor='${L.gitMinMinor}'`)
    expect(s).toContain(`macos_min='${L.macosMinMajor}'`)
    expect(s).toContain(`glibc_min_major='${L.glibcMinMajor}'`)
    expect(s).toContain(`glibc_min_minor='${L.glibcMinMinor}'`)
    expect(s).toContain('curl -fsSL https://github.com/some-owner/kea/releases/latest/download/install.sh | sh')
    // the repository files byte for byte as the packages write them, inside quoted here-documents
    expect(s).toContain(`<<'KEA_APT_SOURCE'\n${aptSourceText('some-owner/kea')}KEA_APT_SOURCE\n`)
    expect(s).toContain(`<<'KEA_DNF_REPO'\n${rpmRepoText('some-owner/kea', true)}KEA_DNF_REPO\n`)
    expect(s).toContain(`<<'KEA_DNF_REPO_OFF'\n${rpmRepoText('some-owner/kea', false)}KEA_DNF_REPO_OFF\n`)
    expect(s).toContain(`<<'KEA_ZYPPER_REPO'\n${zypperRepoText('some-owner/kea')}KEA_ZYPPER_REPO\n`)
    const outside = tarballFiles()
    expect(outside).toContain('0755 usr/bin/kea-app')
    expect(outside).toContain('0644 usr/share/applications/dev.kea.app.desktop')
    expect(outside).toContain('0644 usr/share/fonts/kea-app/JetBrainsMono-Regular.ttf')
    expect(outside).toContain('0644 usr/share/doc/kea-app/copyright')
    expect(outside.filter((l) => l.includes('/icons/hicolor/')).length, "hicolor's sizes and the SVG").toBe(9)
    expect(outside.some((l) => / (etc|opt)\//.test(l)), 'no repository file and nothing of the tree').toBe(false)
    expect(s).toContain(`<<'KEA_TARBALL_FILES'\n${outside.join('\n')}\nKEA_TARBALL_FILES\n`)

    expect(() => buildInstallScript(template, { ...values, repository: 'no-slash' })).toThrow(/not a GitHub repository/)
    expect(() => buildInstallScript(template, { ...values, fingerprint: V4_FPR.toLowerCase() })).toThrow(/not a key fingerprint/)
    expect(() => buildInstallScript(template, { ...values, leaf: 'xyz' })).toThrow(/not a certificate leaf/)
    expect(() => buildInstallScript(`${template}@@NEW_THING@@`, values)).toThrow(/NEW_THING/)
    const unnamed = releaseValues({ repository: null, keyFile: path.join(tmp(), 'missing.gpg'), leaf: CERTIFICATE_LEAF })
    expect(unnamed.values).toBeNull()
    expect(unnamed.problems.join('\n')).toMatch(/not named yet[\s\S]*key is missing/)
    const keyed = path.join(tmp(), 'kea-app.gpg')
    fs.writeFileSync(keyed, V4_KEY)
    expect(releaseValues({ repository: 'some-owner/kea', keyFile: keyed, leaf: CERTIFICATE_LEAF }).values).toEqual(values)

    // the shape that makes a cut download harmless: comments, one function, and its call inside braces, last
    const lines = s.split('\n')
    while (lines.at(-1) === '') lines.pop()
    expect(lines.at(-1)).toBe('{ kea_install "$@"; }')
    const start = lines.indexOf('kea_install() {')
    const end = lines.lastIndexOf('}')
    expect(lines.slice(0, start).every((l) => l === '' || l.startsWith('#')), 'only comments before the function').toBe(true)
    expect(lines.slice(end + 1, -1).every((l) => l === ''), 'nothing between the function and its call').toBe(true)
    for (const sh of SHELLS) {
      const d = tmp()
      fs.writeFileSync(path.join(d, 'install.sh'), s)
      expect(spawnSync(sh, ['-n', path.join(d, 'install.sh')]).status, sh).toBe(0)
    }
  })

  // A download cut short anywhere runs nothing (checked here, not in the end-to-end test, so every verify runs it): the
  // script cut after every line, and inside its last line at every byte, run by each shell present with a PATH of
  // tripwires only: no tripwire fires and no command is looked for. The whole script does reach commands (the tripwires
  // work). The template refuses to run, and options are refused before anything runs. The cuts are thousands of shell
  // runs, one per core at a time: one after another they took longer than a unit test may on a slow shared machine.
  it('U-PACK-43 · cut after any line or inside the last one, it runs nothing; the template and bad options run nothing either', async () => {
    const d = tmp()
    const trip = path.join(d, 'trip')
    fs.mkdirSync(trip)
    const commands = new Set(['uname', 'id', 'mktemp', 'curl', 'sudo', 'rm', 'mkdir', 'mv', 'install', 'tar', 'chmod', 'chown', 'apt-get', 'dnf', 'zypper', 'rpm', 'dpkg-query', 'ditto', 'codesign', 'xattr', 'plutil', 'pgrep', 'sysctl', 'sw_vers', 'git', 'xcode-select', 'gpgv', 'sed', 'awk', 'grep', 'tr', 'base64', 'sha256sum', 'shasum', 'cat', 'find', 'sort', 'comm', 'cmp', 'dirname', 'readlink', 'getconf', 'fc-cache', 'apparmor_parser', 'unshare', 'rmdir', 'ls', 'od', 'sha1sum', 'sqv'])
    for (const c of commands) fs.writeFileSync(path.join(trip, c), `#!/bin/sh\necho "${c}" >> "$KEA_CUT_LOG"\n`, { mode: 0o755 })
    const s = buildInstallScript(template, values)
    let runs = 0
    /** One run of `text` by `sh`, with a script and a tripwire log of its own, so that runs can overlap. */
    const run = async (sh: string, text: string, args: string[] = ['--dry-run']) => {
      const n = runs++
      const script = path.join(d, `cut-${n}.sh`)
      const log = path.join(d, `log-${n}`)
      fs.writeFileSync(script, text)
      const r = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(sh, [script, ...args], { env: { PATH: trip, HOME: d, KEA_CUT_LOG: log }, cwd: d, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
        child.on('error', reject)
        child.on('close', (status) => resolve({ status, stderr }))
      })
      const ran = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
      fs.rmSync(script)
      fs.rmSync(log, { force: true })
      return { ran, err: r.stderr, status: r.status }
    }

    const lines = s.split('\n')
    const last = lines.findLastIndex((l) => l !== '')
    const cuts: string[] = []
    for (let n = 0; n < last; n++) cuts.push(lines.slice(0, n).join('\n') + (n ? '\n' : ''))
    const before = lines.slice(0, last).join('\n') + '\n'
    for (let b = 0; b < (lines[last] as string).length; b++) cuts.push(before + (lines[last] as string).slice(0, b))
    const jobs = SHELLS.flatMap((sh) => cuts.map((text, i) => ({ sh, i, text })))
    const results = await inParallel(jobs, os.availableParallelism(), (j) => run(j.sh, j.text))
    for (const [k, j] of jobs.entries()) {
      const r = results[k]!
      expect(r.ran, `${j.sh}, cut ${j.i}: ran ${r.ran.join(' ')}`).toEqual([])
      expect(r.err, `${j.sh}, cut ${j.i}: looked for a command`).not.toMatch(/not found/)
    }
    for (const sh of SHELLS) {
      const whole = await run(sh, s)
      expect(whole.ran[0], `${sh}: the whole script reaches its first command`).toBe('uname')
      expect(whole.status).not.toBe(0)
    }

    // the template refuses, and bad options are refused before any command runs
    for (const [text, args, why] of [
      [template, [], /this is install.sh's template/],
      [s, ['--frobnicate'], /unknown option --frobnicate/],
      [s, ['--version', '1.2'], /not a Kea version/],
      [s, ['--version', '0.2.0-rc.01'], /not a Kea version/],
      [s, ['--version', '1.2.3.4'], /not a Kea version/],
      [s, ['--version'], /needs a version/],
      [s, ['--uninstall', '--no-repo'], /--uninstall takes only --user and --dry-run/],
    ] as const) {
      const r = await run('/bin/sh', text, [...args])
      expect(r.ran, `${args.join(' ')}: ran ${r.ran.join(' ')}`).toEqual([])
      expect(r.status).toBe(1)
      expect(r.err).toMatch(why)
    }
    const help = await run('/bin/sh', s, ['--help'])
    expect(help.ran).toEqual([])
    expect(help.status).toBe(0)
  })

  // The checks install.sh makes before it changes anything, run for real: a Linux dry run (a stub uname says Linux, so
  // nothing reaches the macOS path) against stand-in releases that a stub curl serves from a folder, with only the
  // system's own text tools and, for some runs, gpgv. Kea's key is checked against the pinned fingerprint by the script
  // itself (v4 and v6: RFC 9580's sample keys), so another key, two keys or no key is refused with no OpenPGP tool
  // installed; SHA256SUMS's signature is checked with gpgv where it is (fixtures/install/signing: SHA256SUMS signed by
  // the pinned key A and by another, B), and without one the line says so; a file that does not match SHA256SUMS, or
  // that it lists twice, is refused; a release with no build for this system is refused. Every download asks curl for
  // HTTPS only, under the release's URL; nothing that changes the system runs.
  it('U-PACK-44 · the key pinned by its fingerprint with or without gpg; SHA256SUMS’s signature checked with gpgv; files checked; downloads HTTPS only', () => {
    const d = tmp()
    const bin = path.join(d, 'bin')
    const gpgvBin = path.join(d, 'gpgv-bin')
    fs.mkdirSync(bin)
    fs.mkdirSync(gpgvBin)
    const isExecutable = (f: string) => {
      try {
        fs.accessSync(f, fs.constants.X_OK)
        return fs.statSync(f).isFile()
      } catch {
        return false
      }
    }
    const found = (name: string) => (process.env.PATH ?? '').split(':').map((p) => path.join(p, name)).find(isExecutable)
    for (const name of ['id', 'mktemp', 'rm', 'chmod', 'sed', 'awk', 'grep', 'tr', 'od', 'base64', 'sort', 'cat', 'readlink', 'dirname', 'find', 'shasum', 'sha1sum', 'sha256sum']) {
      const real = found(name)
      if (real) fs.symlinkSync(real, path.join(bin, name))
    }
    const gpgv = found('gpgv')
    if (gpgv) fs.symlinkSync(gpgv, path.join(gpgvBin, 'gpgv'))
    const log = path.join(d, 'ran')
    for (const c of ['sudo', 'install', 'mkdir', 'mv', 'tar', 'chown', 'apt-get', 'dnf', 'zypper', 'rpm', 'fc-cache', 'ditto', 'codesign']) {
      fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho "${c}" >> "$KEA_CUT_LOG"\n`, { mode: 0o755 })
    }
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase $1 in -s) echo Linux ;; -m) echo aarch64 ;; esac\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'getconf'), '#!/bin/sh\necho "glibc 2.39"\n', { mode: 0o755 })
    fs.writeFileSync(
      path.join(bin, 'curl'),
      ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$KEA_CURL_LOG"', 'out= url=', 'while [ $# -gt 0 ]; do case $1 in -o) out=$2; shift ;; https://*) url=$1 ;; esac; shift; done', 'f=$KEA_STUB_RELEASE/${url##*/}', '[ -f "$f" ] || exit 22', 'cat "$f" > "$out"', ''].join('\n'),
      { mode: 0o755 },
    )

    let n = 0
    const run = (o: { pin: string; files: Map<string, string | Buffer>; withGpgv?: boolean; args?: string[] }) => {
      const rel = path.join(d, `release-${++n}`)
      fs.mkdirSync(rel)
      for (const [name, data] of o.files) fs.writeFileSync(path.join(rel, name), data)
      const script = path.join(d, `install-${n}.sh`)
      fs.writeFileSync(script, buildInstallScript(template, { ...values, fingerprint: o.pin }))
      const home = path.join(d, `home-${n}`)
      fs.mkdirSync(home)
      const curlLog = path.join(d, `curl-${n}`)
      fs.rmSync(log, { force: true })
      const r = spawnSync('/bin/sh', [script, '--dry-run', ...(o.args ?? [])], {
        encoding: 'utf8',
        cwd: home,
        env: { PATH: o.withGpgv ? `${bin}:${gpgvBin}` : bin, HOME: home, TMPDIR: home, KEA_STUB_RELEASE: rel, KEA_CURL_LOG: curlLog, KEA_CUT_LOG: log },
      })
      const ran = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
      const downloads = fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8').trim().split('\n') : []
      expect(ran, `run ${n}: commands that change the system ran`).toEqual([])
      for (const line of downloads) expect(line, `run ${n}: a download that is not HTTPS-only`).toMatch(/^--proto =https --proto-redir =https --tlsv1\.2 -fsSL -o \S+ https:\/\/github\.com\/some-owner\/kea\/releases\//)
      return { out: r.stdout, err: r.stderr, status: r.status, downloads }
    }
    const accepted = (r: ReturnType<typeof run>, how: RegExp) => {
      expect(r.err, 'refused').not.toMatch(/install\.sh: /)
      expect(r.out).toMatch(/^Release: Kea 0\.1\.0, from https:\/\/github\.com\/some-owner\/kea\/releases\/latest\/download\/$/m)
      expect(r.out).toMatch(how)
    }
    const refused = (r: ReturnType<typeof run>, why: RegExp) => {
      expect(r.status).toBe(1)
      expect(r.err).toMatch(why)
      expect(r.out).not.toMatch(/^Release: /m)
    }
    const unsigned = /^SHA256SUMS: not signature-checked \(neither GnuPG's gpgv nor Sequoia's sqv is installed\)/m
    const release = (key: Buffer, change?: (sums: string) => string) => {
      const files = standInRelease(armor(key))
      if (change) files.set('SHA256SUMS', change(files.get('SHA256SUMS') as string))
      return files as Map<string, string | Buffer>
    }

    // the pin, worked out by the script itself (no OpenPGP tool here)
    accepted(run({ pin: V4_FPR, files: release(V4_KEY) }), unsigned)
    accepted(run({ pin: V6_FPR, files: release(V6_KEY) }), unsigned)
    refused(run({ pin: V4_FPR, files: release(V6_KEY) }), new RegExp(`kea-app\\.asc is not Kea's key \\(its fingerprint is ${V6_FPR}; this script pins ${V4_FPR}\\): nothing was installed`))
    refused(run({ pin: V4_FPR, files: release(Buffer.concat([V4_KEY, V6_KEY])) }), /kea-app\.asc is not one OpenPGP key/)
    refused(run({ pin: V4_FPR, files: release(Buffer.from('hello, not a key')) }), /kea-app\.asc is not one OpenPGP key/)
    // the files against SHA256SUMS
    refused(run({ pin: V4_FPR, files: release(V4_KEY, (s) => s.replace(/^[0-9a-f]{64}(?=  kea-app\.asc$)/m, '0'.repeat(64))) }), /kea-app\.asc does not match SHA256SUMS .*: nothing was installed/)
    refused(run({ pin: V4_FPR, files: release(V4_KEY, (s) => s + (s.split('\n').find((l) => l.endsWith('kea-app.asc')) as string) + '\n') }), /SHA256SUMS does not list kea-app\.asc exactly once/)
    refused(run({ pin: V4_FPR, files: release(V4_KEY, (s) => s.replace(/^.*linux-arm64\.tar\.gz\n/m, '')) }), /the release has no file kea-app-<version>-linux-arm64\.tar\.gz/)
    // --version takes that release's URL
    const tagged = run({ pin: V4_FPR, files: release(V4_KEY), args: ['--version', '0.1.0'] })
    expect(tagged.downloads.length).toBeGreaterThan(0)
    for (const line of tagged.downloads) expect(line).toMatch(/ https:\/\/github\.com\/some-owner\/kea\/releases\/download\/v0\.1\.0\/[^/]+$/)

    // SHA256SUMS's signature, where gpgv is (install-e2e.sh runs sqv on Debian 13)
    const keyA = fs.readFileSync(path.join(SIGNING, 'a.gpg'))
    const fprA = keyFingerprint(keyA)
    const signedBy = (who: 'a' | 'b') => release(keyA).set('SHA256SUMS.asc', fs.readFileSync(path.join(SIGNING, `SHA256SUMS.${who}.sig`)))
    accepted(run({ pin: fprA, files: signedBy('b') }), unsigned)
    if (gpgv) {
      accepted(run({ pin: fprA, files: signedBy('a'), withGpgv: true }), new RegExp(`^SHA256SUMS: signed by Kea's key ${fprA} \\(checked with gpgv\\)$`, 'm'))
      refused(run({ pin: fprA, files: signedBy('b'), withGpgv: true }), /SHA256SUMS's signature does not verify with Kea's key: nothing was installed/)
    }
  })

  // The README is the download page: its first section is Install, with the one command for both systems, the
  // repository as named (`<owner>/kea` while it is not), no version written in, the oldest versions from constants/,
  // macOS's quarantine step, and the uninstall command with what stays. docs/install-linux.md names the key's
  // fingerprint (`<fingerprint>` until the key exists) and, for each Linux family, gives the by-hand commands exactly
  // as install.sh's dry run prints them in the goldens of fixtures/install/dry-run: each repository file's text and
  // each command that changes the system, in order.
  it('U-PACK-45 · the README’s Install section and the Linux install page: one command, the by-hand commands as the dry runs print them, the repository as named, no version', () => {
    const root = path.resolve(import.meta.dirname, '../../../..')
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    const linuxDoc = fs.readFileSync(path.join(root, 'docs/install-linux.md'), 'utf8')
    const sections = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1])
    expect(sections[0], 'Install is the first section').toBe('Install')
    const at = readme.indexOf('\n## Install\n')
    const install = readme.slice(at, readme.indexOf('\n## ', at + 1))
    const named = RELEASE_REPOSITORY
    const repo = named ?? '<owner>/kea'
    const [owner = '', name = ''] = repo.split('/')
    const pages = named ? `${owner.toLowerCase()}.github.io/${name}` : '<owner>.github.io/kea'
    const keyed = named !== null && fs.existsSync(RELEASE_KEY)
    const fingerprint = keyed ? keyFingerprint(fs.readFileSync(RELEASE_KEY)) : '<fingerprint>'
    const command = `curl -fsSL https://github.com/${repo}/releases/latest/download/install.sh | sh`
    expect(install).toContain(`\`\`\`sh\n${command}\n\`\`\``)
    expect(install).toContain(`${command} -s -- --dry-run`)
    expect(install).toContain(`${command} -s -- --uninstall`)
    if (named) expect(readme + linuxDoc, 'no <owner> once the repository is named').not.toMatch(/<owner>/)
    if (keyed) expect(readme + linuxDoc, 'no <fingerprint> once the key exists').not.toMatch(/<fingerprint>/)
    expect(install, 'no version written in').not.toMatch(/\b\d+\.\d+\.\d+\b/)
    expect(linuxDoc, 'no version written in').not.toMatch(/\b\d+\.\d+\.\d+\b/)
    expect(install).toContain(`macOS ${L.macosMinMajor} or later`)
    expect(install).toContain(`glibc ${L.glibcMinMajor}.${L.glibcMinMinor} or later`)
    expect(install).toContain(`git ${L.gitMinMajor}.${L.gitMinMinor} or later`)
    expect(install).toContain('xattr -dr com.apple.quarantine /Applications/Kea.app')
    for (const w of ['~/.kea', 'uncommitted work', 'keep running']) expect(install, `notice names ${w}`).toContain(w)
    expect(linuxDoc).toContain(`curl -fsSLO https://github.com/${repo}/releases/latest/download/kea-app.asc`)
    expect(linuxDoc).toContain(`\`${fingerprint}\``)

    // each family's block: the files the dry run shows, then its commands, as written in the golden
    const goldens = path.resolve(import.meta.dirname, '../../../../fixtures/install/dry-run')
    // what every system of a family prints (dry-run-normal.sh): no run's architecture, home, version or key
    for (const f of fs.readdirSync(goldens)) {
      const text = fs.readFileSync(path.join(goldens, f), 'utf8')
      expect(text, `${f} is normalised`).not.toMatch(/[._-](?:x86_64|aarch64|amd64|arm64|x64)[._/-]|\/home\/|\/Users\/|\b\d+\.\d+\.\d+\b|\b[0-9A-F]{40}\b/)
    }
    for (const [family, label] of [['apt', 'Debian and Ubuntu'], ['dnf', 'Fedora'], ['zypper', 'openSUSE']] as const) {
      const golden = fs
        .readFileSync(path.join(goldens, `dry-run-${family}.txt`), 'utf8')
        .replaceAll('<owner>.github.io/<name>', pages)
        .replaceAll('<repository>', repo)
        .replaceAll('<fingerprint>', fingerprint)
      const from = linuxDoc.indexOf(`\n### ${label}\n`)
      expect(from, label).toBeGreaterThan(0)
      const open = linuxDoc.indexOf('```sh\n', from)
      const block = linuxDoc.slice(open + 6, linuxDoc.indexOf('```', open + 6))
      const lines = golden.split('\n')
      let expected = ''
      for (const [i, line] of lines.entries()) {
        const file = /^File (kea-app\.(?:sources|repo)), for /.exec(line)
        if (file) {
          const text: string[] = []
          for (let j = i + 1; lines[j]?.startsWith('    '); j++) text.push((lines[j] as string).slice(4))
          expected += `cat >${file[1]} <<'EOF'\n${text.join('\n')}\nEOF\n`
        }
        if (line.startsWith('+ ')) expected += `${line.slice(2)}\n`
      }
      expect(expected.split('\n').length, `${family}: the golden has commands`).toBeGreaterThan(3)
      expect(block.endsWith(expected), `${family}: the page's block ends with the dry run's files and commands`).toBe(true)
    }
  })

  // macOS's --uninstall: the app as before, then the updater's downloads and Squirrel.Mac's staged update, which are
  // the user's own (removed as them, shown in a dry run, only where they exist), and only after the checks that the
  // app is Kea and that it is not running; with no app there is nothing to remove. A running Kea refuses an install
  // with what works for every version: Restart to Update where Kea offers it, or quitting it completely.
  it('U-PACK-54 · on macOS --uninstall removes the updater’s caches after its checks; an install over a running Kea names Restart to Update and quitting completely', () => {
    const s = buildInstallScript(template, values)
    expect(s).toContain(`updater_cache='${UPDATER_CACHE}'`)
    expect(s).toContain(`app_id=${APP_ID}\n`)
    const body = s.slice(s.indexOf('  uninstall_mac() {'), s.indexOf('\n  }\n', s.indexOf('  uninstall_mac() {')))
    const at = (needle: string) => {
      const i = body.indexOf(needle)
      expect(i, needle).toBeGreaterThanOrEqual(0)
      return i
    }
    const order = [
      at('nothing to remove.'),
      at('return 0'),
      at('CFBundleIdentifier'),
      at('mac_running && die'),
      at('mac_change rm -rf "$mac_app"'),
      at('for um_cache in "$HOME/Library/Caches/$updater_cache" "$HOME/Library/Caches/$app_id.ShipIt"; do'),
      at('if [ -e "$um_cache" ]; then mine rm -rf "$um_cache"; fi'),
    ]
    expect([...order].sort((a, b) => a - b), 'in this order').toEqual(order)
    const running = /die "Kea \$\{im_old:-\(an older version\)\} is running from \$mac_app, so nothing was replaced: ([^"]+)"/.exec(s)?.[1] ?? ''
    expect(running).toMatch(/Restart to Update/)
    expect(running).toMatch(/quit it completely \(Quit Kea Completely, ⌥⌘Q; its sessions keep running\) and run this again/)
  })
})
