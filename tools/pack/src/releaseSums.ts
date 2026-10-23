// A release's checksum files, made in the folder that holds its other files: install.sh for the repository and its
// key, kea-app.asc (the repository's public key, armoured), SHA256SUMS over every file as `sha256sum` writes it, and
// SHA256SUMS.asc, its detached signature. The signature is made by the person's own gpg with the repository key: gpg
// asks for the key's passphrase itself, and nothing here sees it. It is then checked with gpgv against
// assets/release/kea-app.gpg and its signer against the key's fingerprint, as install.sh checks it.
//
//   node tools/pack/src/releaseSums.ts <folder>      (pnpm release:sums <folder>)
//
// The folder holds the release's files and nothing else: `pnpm package --release`'s output (dist/package), or the
// files of a published release downloaded with `gh release download`.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RELEASE_REPOSITORY } from '../../../packages/protocol/src/release.ts'
import { armor, dearmor, keyFingerprint, RELEASE_KEY, releaseValues, writeInstallScript } from './os/installScript.ts'
import { CERTIFICATE_LEAF } from './release.ts'

/** The files SHA256SUMS never lists: itself and its signature. */
export const SUMS_FILES = ['SHA256SUMS', 'SHA256SUMS.asc'] as const

/** The release's files in `names` (a folder's regular files), and what stops SHA256SUMS from naming each one plainly. */
export function releaseFiles(names: readonly string[]): { files: string[]; problems: string[] } {
  const files: string[] = []
  const problems: string[] = []
  for (const n of names) {
    if ((SUMS_FILES as readonly string[]).includes(n)) continue
    // `sha256sum` escapes such a name, and install.sh reads the plain form only
    if (n.startsWith('.') || n.startsWith('*') || /[\s\\]/.test(n)) problems.push(`${JSON.stringify(n)} is no release file's name (a dotfile, or a name with a space, a backslash or a leading *)`)
    else files.push(n)
  }
  return { files: files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), problems }
}

/** SHA256SUMS for these files, as `sha256sum` writes it: one `<hex>  <name>` line each, by name in byte order. */
export function sumsText(files: readonly { name: string; bytes: Buffer }[]): string {
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => `${createHash('sha256').update(f.bytes).digest('hex')}  ${f.name}\n`)
    .join('')
}

/** The fingerprint of the primary key whose key made a good signature, from gpgv's `--status-fd` lines (VALIDSIG's last field). */
export function signerOf(status: string): string | null {
  for (const line of status.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f[0] === '[GNUPG:]' && f[1] === 'VALIDSIG' && f.length >= 4) return (f[f.length - 1] as string).toUpperCase()
  }
  return null
}

function main(argv: string[]): void {
  if (argv.length !== 1 || argv[0]!.startsWith('--')) throw new Error('usage: pnpm release:sums <folder holding the release files>')
  const dir = path.resolve(argv[0]!)
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dir} is not a folder`)
  const r = releaseValues({ repository: RELEASE_REPOSITORY, keyFile: RELEASE_KEY, leaf: CERTIFICATE_LEAF })
  if (r.values === null) throw new Error(`no release can be signed yet:\n  ${r.problems.join('\n  ')}`)
  const key = dearmor(fs.readFileSync(RELEASE_KEY))
  const fingerprint = keyFingerprint(key)

  writeInstallScript(path.join(dir, 'install.sh'), r.values)
  fs.writeFileSync(path.join(dir, 'kea-app.asc'), armor(key))
  const listed = releaseFiles(fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name))
  if (listed.problems.length) throw new Error(`${dir}:\n  ${listed.problems.join('\n  ')}`)
  const sums = path.join(dir, 'SHA256SUMS')
  const sig = path.join(dir, 'SHA256SUMS.asc')
  fs.writeFileSync(sums, sumsText(listed.files.map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }))))
  fs.rmSync(sig, { force: true })

  console.log(`SHA256SUMS lists ${listed.files.length} files: ${listed.files.join(', ')}`)
  console.log(`signing it with the repository key ${fingerprint} (gpg asks for the key's passphrase)`)
  const signed = spawnSync('gpg', ['--local-user', fingerprint, '--armor', '--detach-sign', '--output', sig, sums], { stdio: 'inherit' })
  if (signed.error) throw new Error(`gpg could not be run (${signed.error.message}): install GnuPG`)
  if (signed.status !== 0) throw new Error('gpg did not sign SHA256SUMS: nothing was signed')

  // checked as install.sh checks it: gpgv with the repository's key alone, and the signer's fingerprint
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-sums-'))
  try {
    const keyring = path.join(work, 'kea-app.gpg')
    fs.writeFileSync(keyring, key)
    const v = spawnSync('gpgv', ['--keyring', keyring, '--status-fd', '1', sig, sums], { encoding: 'utf8' })
    if (v.error) throw new Error(`gpgv could not be run (${v.error.message}): install GnuPG`)
    const signer = signerOf(v.stdout ?? '')
    if (v.status !== 0 || signer !== fingerprint) throw new Error(`SHA256SUMS.asc does not verify with ${path.relative(process.cwd(), RELEASE_KEY)} (signer ${signer ?? 'none'}):\n${v.stderr}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
  console.log(`\n${dir}: install.sh, kea-app.asc, SHA256SUMS and SHA256SUMS.asc, signed by ${fingerprint} and checked with gpgv`)
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`release:sums: ${(e as Error).message}`)
    process.exit(1)
  }
}
