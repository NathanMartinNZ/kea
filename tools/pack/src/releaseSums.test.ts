// The checksum files `pnpm release:sums` adds to a release: SHA256SUMS as `sha256sum` writes it (the form install.sh
// reads), over every release file but itself and its signature, and the signer read from gpgv's status lines.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { standInRelease } from './os/installFixtures.ts'
import { releaseFiles, signerOf, sumsText } from './releaseSums.ts'

describe('release checksums', () => {
  it('U-PACK-48 · SHA256SUMS lists every release file but itself and its signature, as sha256sum writes it; the signer is VALIDSIG’s primary key', () => {
    const asc = fs.readFileSync(path.resolve(import.meta.dirname, '../../../fixtures/install/signing/a.gpg'), 'latin1')
    const release = standInRelease(asc)
    const files = [...release].filter(([name]) => name !== 'SHA256SUMS').map(([name, text]) => ({ name, bytes: Buffer.from(text) }))
    // the same text as the stand-in release install.sh's tests check, whatever order the folder lists them in
    expect(sumsText([...files].reverse())).toBe(release.get('SHA256SUMS'))

    const names = [...release.keys(), 'SHA256SUMS.asc', 'install.sh']
    expect(releaseFiles(names)).toEqual({ files: [...release.keys(), 'install.sh'].filter((n) => n !== 'SHA256SUMS').sort(), problems: [] })
    // a name sha256sum would escape, or a dotfile left in the folder, stops the step instead of being listed
    for (const odd of ['.DS_Store', 'Kea 1.0.0.zip', 'a\\b', '*Kea.zip']) {
      const r = releaseFiles(['install.sh', odd])
      expect(r.files, odd).toEqual(['install.sh'])
      expect(r.problems, odd).toHaveLength(1)
    }

    const primary = 'AB12CD34EF56AB12CD34EF56AB12CD34EF56AB12'
    const subkey = '0123456789ABCDEF0123456789ABCDEF01234567'
    const good = ['[GNUPG:] NEWSIG', `[GNUPG:] GOODSIG 89ABCDEF01234567 Kea release key`, `[GNUPG:] VALIDSIG ${subkey} 2026-10-23 1792800000 0 4 0 22 10 00 ${primary.toLowerCase()}`, ''].join('\n')
    expect(signerOf(good), 'the primary key, not the subkey that signed').toBe(primary)
    expect(signerOf('[GNUPG:] NEWSIG\n[GNUPG:] BADSIG 89ABCDEF01234567 Kea release key\n')).toBeNull()
    expect(signerOf('[GNUPG:] ERRSIG 89ABCDEF01234567 22 10 00 1792800000 9 -\n[GNUPG:] NO_PUBKEY 89ABCDEF01234567\n')).toBeNull()
  })
})
