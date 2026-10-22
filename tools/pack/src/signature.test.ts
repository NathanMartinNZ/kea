import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packOs } from './os/index.ts'
import { parseSignature, readSignature } from './signature.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('code signature read-back', () => {
  it('U-PACK-1 · the signer is the leaf Authority line; ad hoc has none', () => {
    const signed = parseSignature(
      [
        'Identifier=dev.kea.app',
        'Format=app bundle with Mach-O thin (arm64)',
        'CodeDirectory v=20400 size=292 flags=0x0(none) hashes=3+3 location=embedded',
        'CDHash=870fd8f91855820de00ee6b61316bcdf4feb1f65',
        'Signature size=1652',
        'Authority=Kea Local Code Signing',
        'Authority=Some Root',
        'TeamIdentifier=not set',
      ].join('\n'),
    )
    expect(signed).toMatchObject({ identifier: 'dev.kea.app', signer: 'Kea Local Code Signing', adhoc: false, runtime: false })
    expect(parseSignature('Identifier=x\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1\nSignature=adhoc\n')).toMatchObject({ signer: null, adhoc: true, runtime: true })
  })

  // codesign is macOS's: a named skip on Linux, which signs its packages instead
  it.runIf(packOs.system === 'darwin')('U-PACK-1 · a real binary signed ad hoc reads back with its identifier and cdhash (codesign run verbosely enough)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-test-sig-'))
    dirs.push(dir)
    const bin = path.join(dir, 'tool')
    fs.copyFileSync('/bin/echo', bin)
    const r = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'dev.kea.test', bin], { encoding: 'utf8' }) // os-ok: macOS packaging test
    expect(r.status, r.stderr).toBe(0)
    const s = readSignature(bin)
    expect(s).toMatchObject({ identifier: 'dev.kea.test', adhoc: true, signer: null })
    expect(s.cdhash).toMatch(/^[0-9a-f]{40}$/)
  })
})
