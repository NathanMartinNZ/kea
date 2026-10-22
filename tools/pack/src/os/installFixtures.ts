// The signed stand-in release a unit test runs install.sh's checks against (U-PACK-44), and the command that makes its
// signatures. The release is a few stand-in files, kea-app.asc and their SHA256SUMS; the signatures are made once, by
// two keys generated for it and then thrown away, and kept in fixtures/install/signing/ in binary (no armour, which the
// fixture scrubber would take for a PEM block): key A's public key (the one the test pins), and SHA256SUMS signed by A
// and by B. No private key is kept anywhere.
//
//   node tools/pack/src/os/installFixtures.ts      make them again (needs gpg); only when standInRelease changes
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { armor } from './installScript.ts'

export const SIGNING = path.resolve(import.meta.dirname, '../../../../fixtures/install/signing')
export const STAND_IN_VERSION = '0.1.0'

/** The stand-in release's files for this kea-app.asc, SHA256SUMS last (as `sha256sum` writes it). */
export function standInRelease(asc: string, version: string = STAND_IN_VERSION): Map<string, string> {
  const files = new Map<string, string>()
  for (const name of [`Kea-${version}-arm64-mac.zip`, `kea-app-${version}-1.aarch64.rpm`, `kea-app-${version}-linux-arm64.tar.gz`, `kea-app_${version}_arm64.deb`]) {
    files.set(name, `a stand-in for ${name}\n`)
  }
  files.set('kea-app.asc', asc)
  const sums = [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, text]) => `${createHash('sha256').update(text).digest('hex')}  ${name}\n`)
  files.set('SHA256SUMS', sums.join(''))
  return files
}

function gpg(home: string, args: string[], input?: string): string {
  const r = spawnSync('gpg', ['--homedir', home, '--batch', '--quiet', '--pinentry-mode', 'loopback', '--passphrase', '', ...args], { encoding: 'utf8', input })
  if (r.status !== 0) throw new Error(`gpg ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

function main(): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-install-fixtures-'))
  try {
    fs.chmodSync(home, 0o700)
    const fingerprintOf = (uid: string) =>
      gpg(home, ['--with-colons', '--list-keys', uid])
        .split('\n')
        .find((l) => l.startsWith('fpr:'))
        ?.split(':')[9] ?? ''
    for (const who of ['A', 'B']) gpg(home, ['--quick-gen-key', `Kea install.sh test key ${who} <kea-test-${who.toLowerCase()}@invalid>`, 'ed25519', 'sign', 'never'])
    const a = fingerprintOf('kea-test-a@invalid')
    const b = fingerprintOf('kea-test-b@invalid')
    const keyA = spawnSync('gpg', ['--homedir', home, '--batch', '--export', a]).stdout
    const sums = standInRelease(armor(keyA)).get('SHA256SUMS') as string
    fs.mkdirSync(SIGNING, { recursive: true })
    fs.writeFileSync(path.join(SIGNING, 'a.gpg'), keyA)
    const sumsFile = path.join(home, 'SHA256SUMS')
    fs.writeFileSync(sumsFile, sums)
    for (const [who, fpr] of [['a', a], ['b', b]] as const) {
      const out = path.join(SIGNING, `SHA256SUMS.${who}.sig`)
      fs.rmSync(out, { force: true })
      gpg(home, ['--local-user', fpr, '--detach-sign', '-o', out, sumsFile])
    }
    console.log(`${SIGNING}: key A ${a}; SHA256SUMS signed by A and by B (${b})`)
  } finally {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'])
    fs.rmSync(home, { recursive: true, force: true })
  }
}

if (import.meta.main) main()
