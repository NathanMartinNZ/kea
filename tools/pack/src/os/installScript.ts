// install.sh, built. `install.sh` beside this file is the template; the build writes in what a release names:
// the repository (RELEASE_REPOSITORY), the repository key's fingerprint (read from the key the Linux packages carry),
// the shared certificate's leaf, the oldest versions Kea supports (constants/), the repository files
// exactly as the packages write them, and the tarball's files outside its tree. So install.sh and the packages can
// never disagree. Until the repository is named and its key exists, a release build refuses and only tests build it,
// with a test repository and a test key. Pure but for the CLI at the end:
//
//   node tools/pack/src/os/installScript.ts --out <file>                                       a release's (needs the key)
//   node tools/pack/src/os/installScript.ts --out <file> --test-repository <o/n> --test-key <k> for a test (E-DST-3)
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { L } from '../../../../packages/protocol/src/generated/limits.ts'
import { parseRepository, RELEASE_REPOSITORY } from '../../../../packages/protocol/src/release.ts'
import { CERTIFICATE_LEAF } from '../release.ts'
import { aptSourceText, INSTALL_DIR, rootFiles, rpmRepoText, zypperRepoText } from './linuxPackage.ts'

export const TEMPLATE = path.join(import.meta.dirname, 'install.sh')
/** The repository key's binary form, once it exists. */
export const RELEASE_KEY = path.resolve(import.meta.dirname, '../../../../assets/release/kea-app.gpg')

export interface InstallScriptValues {
  /** `owner/name`. */
  repository: string
  /** The repository key's primary fingerprint, upper-case hex. */
  fingerprint: string
  /** The shared certificate's leaf, lower-case hex. */
  leaf: string
}

/** An armoured OpenPGP block's bytes (what `gpg --dearmor` gives), or the input when it is binary already. */
export function dearmor(key: Buffer): Buffer {
  const text = key.toString('latin1')
  if (!text.startsWith('-----BEGIN PGP ')) return key
  const lines = text.split(/\r?\n/)
  const body = lines.slice(1, lines.findIndex((l, i) => i > 0 && l.startsWith('-----END PGP ')))
  const data = body.slice(body.indexOf('') + 1).filter((l) => l !== '' && !l.startsWith('='))
  return Buffer.from(data.join(''), 'base64')
}

/** A binary OpenPGP key armoured as a public key block (RFC 9580 §6.2, without the optional checksum line). */
export function armor(key: Buffer): string {
  const b64 = key.toString('base64').match(/.{1,64}/g) ?? []
  return ['-----BEGIN PGP PUBLIC KEY BLOCK-----', '', ...b64, '-----END PGP PUBLIC KEY BLOCK-----', ''].join('\n')
}

/**
 * The primary key's fingerprint of an OpenPGP key (RFC 4880 §12.2 for v4: SHA-1 over 0x99, the two-byte length and the
 * public-key packet's body; RFC 9580 §5.5.4 for v6: SHA-256 over 0x9B and a four-byte length). Throws on anything else.
 */
export function keyFingerprint(key: Buffer): string {
  const k = dearmor(key)
  const head = k[0] ?? 0
  if ((head & 0x80) === 0) throw new Error('not an OpenPGP key: its first byte is no packet header')
  let tag: number
  let at: number
  let length: number
  if (head & 0x40) {
    tag = head & 0x3f
    const b1 = k[1] ?? 0
    if (b1 < 192) [length, at] = [b1, 2]
    else if (b1 < 224) [length, at] = [((b1 - 192) << 8) + (k[2] ?? 0) + 192, 3]
    else if (b1 === 255) [length, at] = [k.readUInt32BE(2), 6]
    else throw new Error('a key packet never has a partial length')
  } else {
    tag = (head >> 2) & 0x0f
    const lengthType = head & 0x03
    if (lengthType === 0) [length, at] = [k[1] ?? 0, 2]
    else if (lengthType === 1) [length, at] = [k.readUInt16BE(1), 3]
    else if (lengthType === 2) [length, at] = [k.readUInt32BE(1), 5]
    else throw new Error('a key packet never has an indeterminate length')
  }
  if (tag !== 6) throw new Error(`the first packet is not a public key (tag ${tag})`)
  const body = k.subarray(at, at + length)
  if (body.length !== length) throw new Error('the key is cut short')
  const version = body[0]
  if (version === 4) {
    const prefix = Buffer.from([0x99, (length >> 8) & 0xff, length & 0xff])
    return createHash('sha1').update(prefix).update(body).digest('hex').toUpperCase()
  }
  if (version === 6) {
    const prefix = Buffer.alloc(5)
    prefix[0] = 0x9b
    prefix.writeUInt32BE(length, 1)
    return createHash('sha256').update(prefix).update(body).digest('hex').toUpperCase()
  }
  throw new Error(`a version ${version} key: install.sh pins v4 and v6 keys only`)
}

/** The tarball's files outside its tree, as install.sh lists them: `<mode> <path in the tarball>`. */
export function tarballFiles(): string[] {
  const files = rootFiles({ meta: { version: '0.0.0', description: 'x', maintainer: 'x', repository: null, keyFile: null }, icons: '', fonts: '', launcher: '', licences: '' })
  return files
    .filter((f) => !f.only || f.only.includes('tar.gz'))
    .filter((f) => !f.path.startsWith(`${INSTALL_DIR}/`))
    .map((f) => `${f.mode.toString(8).padStart(4, '0')} ${f.path.slice(1)}`)
}

/** install.sh for these values: every `@@NAME@@` of the template written in, none left. */
export function buildInstallScript(template: string, v: InstallScriptValues): string {
  if (!parseRepository(v.repository)) throw new Error(`"${v.repository}" is not a GitHub repository (owner/name)`)
  if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/.test(v.fingerprint)) throw new Error(`"${v.fingerprint}" is not a key fingerprint (40 or 64 upper-case hex digits)`)
  if (!/^[0-9a-f]{40}$/.test(v.leaf)) throw new Error(`"${v.leaf}" is not a certificate leaf (40 lower-case hex digits)`)
  const text = (s: string) => s.replace(/\n$/, '')
  const values: Record<string, string> = {
    REPOSITORY: v.repository,
    KEY_FINGERPRINT: v.fingerprint,
    CERTIFICATE_LEAF: v.leaf,
    GIT_MIN_MAJOR: String(L.gitMinMajor),
    GIT_MIN_MINOR: String(L.gitMinMinor),
    MACOS_MIN_MAJOR: String(L.macosMinMajor),
    GLIBC_MIN_MAJOR: String(L.glibcMinMajor),
    GLIBC_MIN_MINOR: String(L.glibcMinMinor),
    APT_SOURCE: text(aptSourceText(v.repository)),
    DNF_REPO: text(rpmRepoText(v.repository, true)),
    DNF_REPO_OFF: text(rpmRepoText(v.repository, false)),
    ZYPPER_REPO: text(zypperRepoText(v.repository)),
    TARBALL_FILES: tarballFiles().join('\n'),
  }
  const unknown = new Set<string>()
  const out = template.replace(/@@([A-Z_]+)@@/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined) unknown.add(name)
    return value ?? ''
  })
  if (unknown.size) throw new Error(`install.sh's template names values the build does not know: ${[...unknown].join(', ')}`)
  if (out.includes('@@')) throw new Error('install.sh still holds a @@ after the build')
  return out
}

/** What stops a release's install.sh (as for every release file): the repository and its key, named. */
export function releaseValues(o: { repository: string | null; keyFile: string; leaf: string }): { values: InstallScriptValues | null; problems: string[] } {
  const problems: string[] = []
  if (o.repository === null) problems.push("Kea's repository is not named yet (RELEASE_REPOSITORY in packages/protocol/src/release.ts): install.sh downloads from it")
  if (!fs.existsSync(o.keyFile)) problems.push(`the repository's key is missing (${path.relative(process.cwd(), o.keyFile)}): install.sh pins its fingerprint`)
  if (problems.length || o.repository === null) return { values: null, problems }
  return { values: { repository: o.repository, fingerprint: keyFingerprint(fs.readFileSync(o.keyFile)), leaf: o.leaf }, problems }
}

/** Write install.sh (mode 0755) for these values. */
export function writeInstallScript(file: string, v: InstallScriptValues): void {
  fs.writeFileSync(file, buildInstallScript(fs.readFileSync(TEMPLATE, 'utf8'), v), { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

function main(argv: string[]): void {
  let out: string | null = null
  let testRepository: string | null = null
  let testKey: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--out') out = path.resolve(value())
    else if (a === '--test-repository') testRepository = value()
    else if (a === '--test-key') testKey = path.resolve(value())
    else throw new Error(`unknown option ${a}`)
  }
  if (out === null) throw new Error('--out <file> is needed')
  if ((testRepository === null) !== (testKey === null)) throw new Error('--test-repository and --test-key go together')
  let values: InstallScriptValues
  if (testRepository !== null && testKey !== null) {
    values = { repository: testRepository, fingerprint: keyFingerprint(fs.readFileSync(testKey)), leaf: CERTIFICATE_LEAF }
  } else {
    const r = releaseValues({ repository: RELEASE_REPOSITORY, keyFile: RELEASE_KEY, leaf: CERTIFICATE_LEAF })
    if (r.values === null) throw new Error(`a release's install.sh cannot be built yet:\n  ${r.problems.join('\n  ')}\n(tests build one with --test-repository and --test-key)`)
    values = r.values
  }
  writeInstallScript(out, values)
  console.log(`${out}: install.sh for ${values.repository}${testRepository !== null ? ' (a test build)' : ''}, key ${values.fingerprint}, leaf ${values.leaf}`)
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`installScript: ${(e as Error).message}`)
    process.exit(1)
  }
}
