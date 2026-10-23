// `pnpm package`: build Kea's release files for one target on a machine of that target, and check them before
// anything is published. (`pnpm pack` is pnpm's own command, so the script is `package`.)
//
//   node tools/package.ts [--target mac-arm64|linux-x64|linux-arm64] [--formats <list>] [--out <dir>] [--release] [--adhoc]
//                         [--test-repository <owner/name> --test-key <key>]
//
//   --target    default: this machine's. Another system or architecture is refused (no cross-builds)
//   --formats   macOS `zip`; Linux any of `deb,rpm,tar.gz` (default: all of the target's)
//   --out       where the files go (default dist/package); each target's working folder is removed at the end
//   --release   a build to publish: refused while Kea's repository is not named (packages/protocol/src/release.ts) or,
//               on Linux, its key is missing; never with --adhoc. A macOS release without the key has no install.sh
//   --adhoc     macOS: sign ad hoc, to check the pipeline without the certificate (never published, never installed)
//   --test-repository, --test-key
//               a build for the install tests' stand-in release (E-DST-3): the packages, the feed and install.sh name
//               this repository and carry this key (binary or armoured) instead of the release's; never with --release,
//               never published
//
// Steps: versions agree → the helper for the target (build paths mapped away, so no file names this machine) → release
// bundles with the list of packages they hold → the licences file → electron-builder's `dir` app (config.ts) → fuses →
// macOS: signed inside out as `pnpm kea:install` signs, checked, zipped with its blockmap and `latest-mac.yml`, the zip
// checked unpacked · Linux: checked, staged with the packages' owners and modes, made into the .deb, .rpm and tarball,
// each checked (its listing, the AppArmor profile, the desktop file, lintian, rpmlint) → both: install.sh for the
// repository and its key, once both are named.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isAvailable, need } from '../packages/protocol/src/platform.ts'
import { parseRepository, RELEASE_REPOSITORY } from '../packages/protocol/src/release.ts'
import { resolveCargo, runCargo } from './cargo.ts'
import { buildApp, electronOf, flipFuses, fuseStates, loadFuses, stripNativeModules } from './pack/src/app.ts'
import { auditResourcesFolder } from './pack/src/audit.ts'
import { compareListing, filesNaming, foreignElves, machineNeedles, parseRpmListing, parseTarListing, RPM_QUERY, sourceMaps } from './pack/src/checks.ts'
import { chooseTarget, DESKTOP_FILE, fuseTarget, PRODUCT_NAME, resourcesOf, type Format, type Target } from './pack/src/config.ts'
import { crates, licencesText, npmDependency, type Notice } from './pack/src/licences.ts'
import { installedShiki, releaseNotices, shippedGrammars } from './pack/src/notices.ts'
import { checkMacApp, designatedRequirement, IDENTITY, signAll, signingIdentity } from './pack/src/macApp.ts'
import { checkZip, latestMacYml, makeBlockmap, makeZip, zipName } from './pack/src/macZip.ts'
import { packOs, type PackTool } from './pack/src/os/index.ts'
import { afterInstall, afterRemove, APPARMOR_ABI_4, beforeRemove, artifactNames, debControl, md5sums, ownsFolder, PROFILE_SOURCE, rootFiles, rpmSpec, stageRoot, type PackageMeta } from './pack/src/os/linuxPackage.ts'
import { acceptedFor, ACCEPTED_LINTIAN, ACCEPTED_RPMLINT, lintProblems } from './pack/src/os/linuxLint.ts'
import { keyFingerprint, writeInstallScript } from './pack/src/os/installScript.ts'
import { CERTIFICATE_LEAF, installScriptStep, releaseProblems, releaseRequirement, versionProblems } from './pack/src/release.ts'
import { APP_ID } from './pack/src/target.ts'
import { applicationsFolderOf } from './pack/src/target.ts'

const root = path.resolve(import.meta.dirname, '..')
const STAGE = path.join('dist', 'pack-app')
const PACKAGES = path.join(root, 'dist', 'pack-app.packages.json')
/** The repository key's binary form, once it exists; not in the repository before. */
const RELEASE_KEY = path.join(root, 'assets', 'release', 'kea-app.gpg')
/** The terminal's font on Linux: Ubuntu's build of JetBrains Mono 2.304, regular and bold, with its licence (assets/fonts/README.md). */
const FONTS = path.join(root, 'assets', 'fonts', 'jetbrains-mono')
/** Who the Linux packages name as their maintainer: the repository owner's GitHub noreply address (no mailbox; people
 * reach Kea through its GitHub issues). */
const MAINTAINER = 'Kea <20147925+NathanMartinNZ@users.noreply.github.com>'
/** Kea's licence as an SPDX id: the rpm's `License` tag. The licences file quotes the repository's LICENSE. */
const LICENCE = 'MIT'

function fail(message: string): never {
  console.error(`\npackage: ${message}`)
  process.exit(1)
}

function must<T>(f: () => T): T {
  try {
    return f()
  } catch (e) {
    fail((e as Error).message)
  }
}

function step(n: string): void {
  console.log(`\n── ${n}`)
}

const lines: string[] = []
/** One line of the check table: printed, kept for the summary; a line with problems stops the run. */
function check(name: string, problems: readonly string[], ok: string): void {
  if (problems.length) fail(`${name}:\n  ${problems.slice(0, 20).join('\n  ')}${problems.length > 20 ? `\n  … and ${problems.length - 20} more` : ''}`)
  lines.push(`${name}: ${ok}`)
  console.log(`  ✓ ${name}: ${ok}`)
}

const tool = (t: PackTool): string => need(packOs.tools).path(t)

function run(file: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const r = spawnSync(file, args, { encoding: 'utf8', cwd: o.cwd, env: o.env ? { ...process.env, ...o.env } : process.env, maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) fail(`${path.basename(file)} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status}`}):\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-4000)}`)
  return r.stdout ?? ''
}

function readArgs(argv: string[]): { target: string | null; formats: string | null; out: string; release: boolean; adhoc: boolean; testRepository: string | null; testKey: string | null } {
  const o = { target: null as string | null, formats: null as string | null, out: path.join(root, 'dist', 'package'), release: false, adhoc: false, testRepository: null as string | null, testKey: null as string | null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`)
      return v
    }
    if (a === '--target') o.target = value()
    else if (a === '--formats') o.formats = value()
    else if (a === '--out') o.out = path.resolve(value())
    else if (a === '--release') o.release = true
    else if (a === '--adhoc') o.adhoc = true
    else if (a === '--test-repository') o.testRepository = value()
    else if (a === '--test-key') o.testKey = path.resolve(value())
    else fail(`unknown option ${a} (see the header of tools/package.ts)`)
  }
  if ((o.testRepository === null) !== (o.testKey === null)) fail('--test-repository and --test-key go together')
  if (o.testRepository !== null && o.release) fail('--test-repository builds for a stand-in release, never for a release')
  if (o.testRepository !== null && !parseRepository(o.testRepository)) fail(`--test-repository ${o.testRepository} is not owner/name`)
  if (o.testKey !== null && !fs.existsSync(o.testKey)) fail(`--test-key ${o.testKey} does not exist`)
  return o
}

/** The helper for the target, with this machine's paths mapped away (no file names the build machine). */
function buildHelper(target: Target): string {
  const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo')
  const flags = [`--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${root}=/kea`].join('\x1f')
  const manifest = path.join(root, 'native/kea-helper/Cargo.toml')
  if (runCargo(['build', '--release', '--locked', '--target', target.triple, '--manifest-path', manifest], { env: { CARGO_ENCODED_RUSTFLAGS: flags } }) !== 0) fail(`the kea-helper build for ${target.triple} failed`)
  const helper = path.join(root, 'native/kea-helper/target', target.triple, 'release/kea-helper')
  if (!fs.existsSync(helper)) fail(`no ${path.relative(root, helper)}`)
  return helper
}

/** The modules the renderer's chunks are made of, as their source maps list them (the release build writes them). */
function rendererModules(): string[] {
  const assets = path.join(root, STAGE, 'renderer', 'assets')
  return fs.readdirSync(assets).filter((f) => f.endsWith('.js.map')).flatMap((f) => (JSON.parse(fs.readFileSync(path.join(assets, f), 'utf8')) as { sources: string[] }).sources)
}

/**
 * The licences file: Kea's LICENSE, Electron's licence, the syntax highlighter's notices (Oniguruma's and the
 * grammars that ship, tools/pack/src/notices.ts), `notices`, then the bundles' npm packages and the helper's crates.
 */
function writeLicences(target: Target, o: { version: string; electronDir: string; file: string; notices: readonly Notice[] }): number {
  const dirs = JSON.parse(fs.readFileSync(PACKAGES, 'utf8')) as string[]
  const cargo = resolveCargo() ?? fail(`cargo not found: ${packOs.rust.installHint}`)
  const meta = JSON.parse(run(cargo, ['metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', target.triple, '--manifest-path', path.join(root, 'native/kea-helper/Cargo.toml')], { env: { PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ''}` } })) as Parameters<typeof crates>[0]
  const deps = [...dirs.map(npmDependency), ...crates(meta)]
  const electron: Notice = { title: `Electron (the runtime Kea is built on) — MIT`, text: fs.readFileSync(path.join(o.electronDir, 'dist', 'LICENSE'), 'utf8') }
  const licence = must(() => fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'))
  const notices = must(() => releaseNotices({ licence, electron, shiki: installedShiki(root), grammars: shippedGrammars(rendererModules()), more: o.notices }))
  const text = must(() => licencesText({ product: PRODUCT_NAME, version: o.version, deps, notices, files: (d) => fs.readdirSync(d), read: (f) => fs.readFileSync(f, 'utf8') }))
  fs.writeFileSync(o.file, text)
  return deps.length
}

/** Both systems' lines on the app: no source maps, nothing naming this machine, the licences file there. */
function commonChecks(target: Target, app: string): void {
  const resources = resourcesOf(target, app)
  check('no source maps', sourceMaps(app, path.join(resources, 'app.asar')), 'none in the app or its asar')
  const needles = machineNeedles({ home: os.homedir(), user: os.userInfo().username, host: os.hostname() })
  check('nothing names this machine', filesNaming(app, needles), `no file holds its home, user or host (${needles.length} names looked for)`)
  check('licences', fs.existsSync(path.join(resources, 'licenses.txt')) ? [] : ['resources/licenses.txt is missing'], 'resources/licenses.txt')
}

/** The repository and key this build names: the release's, or a stand-in's with --test-repository and --test-key. */
let REPOSITORY: string | null = RELEASE_REPOSITORY
let KEY_FILE: string | null = fs.existsSync(RELEASE_KEY) ? RELEASE_KEY : null

async function packageMac(target: Target, o: { app: string; out: string; version: string; adhoc: boolean; release: boolean; identity: string; fuses: Awaited<ReturnType<typeof loadFuses>> }): Promise<string[]> {
  step('codesign, inside-out')
  const signed = must(() => signAll(o.app, o.identity))
  console.log(`${signed.items.length} signatures (${signed.nativeModules.length} native module(s))`)

  step('check the app')
  const wire = await o.fuses.getCurrentFuseWire(o.app)
  for (const l of must(() => checkMacApp(o.app, { fuses: o.fuses, wire, adhoc: o.adhoc, signed: signed.items }))) check('macOS', [], l)
  if (o.release) {
    // the leaf install.sh checks and Squirrel.Mac admits updates by
    const req = designatedRequirement(o.app)
    check('the shared certificate', req === releaseRequirement(APP_ID) ? [] : [`the designated requirement is ${req}, not ${releaseRequirement(APP_ID)}`], `the leaf ${CERTIFICATE_LEAF}`)
  }
  commonChecks(target, o.app)

  step('zip, blockmap, latest-mac.yml')
  const zip = path.join(o.out, zipName(o.version))
  must(() => makeZip(o.app, zip))
  const info = await makeBlockmap(root, zip)
  const feed = path.join(o.out, 'latest-mac.yml')
  fs.writeFileSync(feed, latestMacYml({ version: o.version, zip: path.basename(zip), sha512: info.sha512, size: info.size, repository: REPOSITORY, releaseDate: new Date().toISOString() }))
  check('zip', [], must(() => checkZip(zip, o.app)))
  return [zip, info.blockmap, feed]
}

function packageLinux(target: Target, formats: readonly Format[], o: { app: string; out: string; work: string; version: string; release: boolean; licences: string; fuses: Awaited<ReturnType<typeof loadFuses>>; wire: Record<number, number> }): string[] {
  step('check the app')
  const fuses = fuseStates(o.fuses, o.wire)
  check('fuses', fuses.wrong, fuses.line.replace(/^fuses read back: /, ''))
  const elves = foreignElves(o.app, target.arch)
  check('ELF machine', elves.wrong, `${elves.count} ELF files, all ${target.arch}`)
  const audit = auditResourcesFolder(resourcesOf(target, o.app), null)
  check('audit', audit.problems, audit.summary)
  commonChecks(target, o.app)
  const sandbox = fs.statSync(path.join(o.app, 'chrome-sandbox'), { throwIfNoEntry: false })
  check('chrome-sandbox', sandbox?.isFile() ? [] : ['chrome-sandbox is missing'], 'present (set-uid root in the packages)')

  const meta: PackageMeta = {
    version: o.version,
    description: (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { description: string }).description,
    maintainer: MAINTAINER,
    repository: REPOSITORY,
    keyFile: KEY_FILE,
  }
  const files = rootFiles({ meta, icons: path.join(root, 'assets/icon'), fonts: FONTS, launcher: path.join(root, 'tools/pack/src/os/kea-app.sh'), licences: o.licences })
  const names = artifactNames(o.version, target)
  const made: string[] = []
  const systemDirs = (p: string) => !ownsFolder(p)

  for (const format of formats) {
    step(format)
    const dir = path.join(o.work, format)
    fs.mkdirSync(dir, { recursive: true })
    if (format === 'tar.gz') {
      const tarRoot = path.join(dir, names.tarDir)
      const staged = stageRoot(tarRoot, { app: o.app, files, format })
      const file = path.join(o.out, names.tarball)
      run(tool('tar'), ['--sort=name', '--owner=root:0', '--group=root:0', '-czf', file, '-C', dir, names.tarDir])
      const listed = parseTarListing(run(tool('tar'), ['-tvzf', file]), 1)
      check(`${names.tarball}: files`, compareListing(staged, listed, { systemDirs }), `${staged.length} entries with their staged modes, owned by root`)
      made.push(file)
    } else if (format === 'deb') {
      const debRoot = path.join(dir, 'root')
      const staged = stageRoot(debRoot, { app: o.app, files, format })
      const kb = Math.ceil(staged.reduce((n, f) => n + (f.dir ? 0 : fs.statSync(path.join(debRoot, f.path)).size), 0) / 1024)
      const control = path.join(debRoot, 'DEBIAN')
      fs.mkdirSync(control)
      fs.chmodSync(control, 0o755)
      const write = (name: string, text: string, mode: number) => {
        fs.writeFileSync(path.join(control, name), text)
        fs.chmodSync(path.join(control, name), mode)
      }
      write('control', debControl(meta, target, kb), 0o644)
      write('md5sums', md5sums(debRoot, staged), 0o644)
      write('postinst', afterInstall(meta, 'deb'), 0o755)
      write('prerm', beforeRemove(), 0o755)
      write('postrm', afterRemove(), 0o755)
      const file = path.join(o.out, names.deb)
      run(tool('dpkg-deb'), ['--root-owner-group', '-Zxz', '--build', debRoot, file])
      const listed = parseTarListing(run(tool('dpkg-deb'), ['-c', file]))
      check(`${names.deb}: files`, compareListing(staged, listed, { systemDirs }), `${staged.length} entries with their staged modes, owned by root`)
      made.push(file)
    } else if (format === 'rpm') {
      const rpmRoot = path.join(dir, 'root')
      const staged = stageRoot(rpmRoot, { app: o.app, files, format })
      const spec = path.join(dir, `${PRODUCT_NAME}.spec`)
      fs.writeFileSync(spec, rpmSpec(meta, target, { root: rpmRoot, files: staged, post: afterInstall(meta, 'rpm'), postun: afterRemove(), preun: beforeRemove(), licence: LICENCE }))
      const top = path.join(dir, 'top')
      run(tool('rpmbuild'), ['-bb', '--define', `_topdir ${top}`, '--define', `_rpmdir ${o.out}`, '--define', `_build_name_fmt ${names.rpm}`, '--define', '_buildhost kea-build', spec])
      const file = path.join(o.out, names.rpm)
      const listed = parseRpmListing(run(tool('rpm'), ['-qp', '--qf', RPM_QUERY, file]))
      check(`${names.rpm}: files`, compareListing(staged, listed, { systemDirs: () => false }), `${staged.length} entries with their staged modes, owned by root`)
      made.push(file)
    }
  }

  step('package checks')
  const staged = path.join(o.work, formats[0] as string, formats[0] === 'tar.gz' ? names.tarDir : 'root')
  if (fs.existsSync(APPARMOR_ABI_4)) {
    run(tool('apparmor_parser'), ['-Q', '-K', path.join(staged, PROFILE_SOURCE)])
    check('AppArmor profile', [], 'parses (apparmor_parser -Q)')
  } else check('AppArmor profile', [], "not parsed here (this AppArmor has no abi 4.0, as on Ubuntu 22.04): tools/pack/src/os/smoke-linux.sh checks it where the package installs it")
  run(tool('desktop-file-validate'), [path.join(staged, 'usr/share/applications', DESKTOP_FILE)])
  check('desktop file', [], 'desktop-file-validate passes')
  for (const file of made) {
    if (file.endsWith('.deb')) {
      const r = spawnSync(tool('lintian'), ['--no-tag-display-limit', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      const accepted = acceptedFor(ACCEPTED_LINTIAN, o.release)
      check(`lintian ${path.basename(file)}`, lintProblems(`${r.stdout ?? ''}${r.stderr ?? ''}`, accepted), `passes, ${accepted.length} accepted tags (tools/pack/src/os/linuxLint.ts)`)
    }
    if (file.endsWith('.rpm')) {
      const r = spawnSync(tool('rpmlint'), [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      const accepted = acceptedFor(ACCEPTED_RPMLINT, o.release)
      check(`rpmlint ${path.basename(file)}`, lintProblems(`${r.stdout ?? ''}${r.stderr ?? ''}`, accepted), `passes, ${accepted.length} accepted checks (tools/pack/src/os/linuxLint.ts)`)
    }
  }
  return made
}

async function main(): Promise<void> {
  const o = readArgs(process.argv.slice(2))
  if (o.testRepository !== null) [REPOSITORY, KEY_FILE] = [o.testRepository, o.testKey]
  const started = performance.now()
  const { target, formats } = must(() => chooseTarget(o, { system: packOs.system, arch: process.arch }))
  if (o.adhoc && target.system !== 'darwin') fail('--adhoc is a macOS signature: Linux packages are not signed this way')
  // an Applications folder holds installed apps, never a build (the same rule as kea:install's --out; macOS only)
  const apps = isAvailable(packOs.installPlace) ? applicationsFolderOf(o.out) : null
  if (apps) fail(`nothing is built in ${o.out}: it is in ${apps}`)
  console.log(`Kea for ${target.name}: ${formats.join(', ')}${o.release ? ' (release)' : ''}${o.testRepository ? ` (for a stand-in release of ${o.testRepository}: never published)` : ''} → ${path.relative(root, o.out) || o.out}`)

  step('versions')
  const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
  check('one version', versionProblems(root), `${version} for the app, every package and the helper`)
  if (o.release) check('a release build', releaseProblems({ repository: RELEASE_REPOSITORY, key: target.system === 'linux' ? fs.existsSync(RELEASE_KEY) : true, adhoc: o.adhoc, version }), `for ${RELEASE_REPOSITORY}`)

  let identity = '-'
  if (target.system === 'darwin') {
    step('signing identity')
    identity = o.adhoc ? '-' : must(signingIdentity)
    console.log(o.adhoc ? 'ad hoc (--adhoc): this build is never published or installed' : `"${IDENTITY}" (${identity})`)
  }

  step(`kea-helper for ${target.triple}`)
  const helper = buildHelper(target)

  step('release build')
  run(process.execPath, [path.join(root, 'tools/build.ts'), '--release', '--out', STAGE, '--packages-out', PACKAGES])

  fs.mkdirSync(o.out, { recursive: true })
  const work = path.join(o.out, `.work-${target.name}`)
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  const electron = electronOf(root)

  step('licences')
  const licences = path.join(work, 'licenses.txt')
  // Linux's packages carry the terminal's font, and its licence with it
  const font: Notice = { title: 'JetBrains Mono (the terminal font, Linux only) — SIL Open Font License 1.1', text: fs.readFileSync(path.join(FONTS, 'OFL.txt'), 'utf8') }
  const count = writeLicences(target, { version, electronDir: electron.dir, file: licences, notices: target.system === 'linux' ? [font] : [] })
  console.log(`${count} dependencies with their licence texts; Kea's, Electron's and the syntax highlighter's notices${target.system === 'linux' ? ', and the font’s' : ''}`)

  step(`the app (electron-builder, ${target.name} dir target)`)
  let app: string
  try {
    app = await buildApp(root, target, { stage: STAGE, output: path.join(work, 'builder'), electronDir: electron.dir, electronVersion: electron.version, helper, version: null, icons: path.join(root, 'assets/icon'), licences })
  } catch (e) {
    fail((e as Error).message)
  }

  step('native modules: debug symbols out')
  console.log(must(() => stripNativeModules(target, app, tool('strip'))).join(', ') || 'none')

  step('fuses')
  const fuses = await loadFuses(root)
  await flipFuses(fuses, target, app)

  const made =
    target.system === 'darwin'
      ? await packageMac(target, { app, out: o.out, version, adhoc: o.adhoc, release: o.release, identity, fuses })
      : packageLinux(target, formats, { app, out: o.out, work, version, release: o.release, licences, fuses, wire: await fuses.getCurrentFuseWire(fuseTarget(target, app)) })

  step('install.sh')
  const script = installScriptStep({ system: target.system, release: o.release, repository: REPOSITORY, key: KEY_FILE !== null })
  if (script.kind === 'build') {
    const file = path.join(o.out, 'install.sh')
    const fingerprint = must(() => keyFingerprint(fs.readFileSync(KEY_FILE as string)))
    must(() => writeInstallScript(file, { repository: REPOSITORY as string, fingerprint, leaf: CERTIFICATE_LEAF }))
    check('install.sh', [], `for ${REPOSITORY}, key ${fingerprint}, leaf ${CERTIFICATE_LEAF}`)
    made.push(file)
  } else if (script.kind === 'refuse') fail(script.reason)
  else console.log(script.note)

  fs.rmSync(work, { recursive: true, force: true })
  console.log(`\nKea ${version} for ${target.name}${o.adhoc ? ' (ad hoc: never published)' : ''}, ${((performance.now() - started) / 1000).toFixed(1)} s`)
  for (const f of made) console.log(`  ${path.relative(root, f) || f}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`)
  console.log(`  ${lines.length} checks passed`)
}

await main()
