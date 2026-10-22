import { systemOf, unavailable } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { darwin, requirementFrom } from './darwin.ts'
import { ptyhostOs } from './index.ts'
import { linux } from './linux.ts'

describe('the client requirement holders admit', () => {
  const LEAF = 'certificate leaf = H"0123456789abcdef0123456789abcdef01234567"'
  /** What `codesign -d -r-` prints (stderr) for an executable; ad-hoc ones print an implicit requirement as a comment. */
  const codesign = (exe: string, dr: string, implicit = false) => `Executable=/x/Kea.app/Contents/${exe}\n${implicit ? '# ' : ''}designated => ${dr}\n`

  it("U-HLD-7 · a signed build admits ptyhost's own identifier under the local certificate, never the certificate alone, and never kea-helper", () => {
    // ptyhost is an Electron utility process: it runs as the app's helper, `dev.kea.app.helper`
    const ptyhost = codesign('Frameworks/Kea Helper.app/Contents/MacOS/Kea Helper', `identifier "dev.kea.app.helper" and ${LEAF}`)
    expect(requirementFrom(ptyhost)).toBe(`identifier "dev.kea.app.helper" and ${LEAF}`)
    // `kea-helper` carries the same leaf but not that identifier, so the requirement above refuses it; a
    // requirement taken from kea-helper's own signature, or one pinning the leaf with no identifier, is refused
    expect(requirementFrom(codesign('Resources/kea-helper', `identifier "dev.kea.helper" and ${LEAF}`))).toBeNull()
    expect(requirementFrom(codesign('MacOS/Kea', LEAF))).toBeNull()
    // dev builds and tests: an ad-hoc signature's cdhash, as is (it changes with every build)
    expect(requirementFrom(codesign('MacOS/Electron Helper', 'cdhash H"cead962814af248488bb6597ee22a32fc23d00a1"', true))).toBe('cdhash H"cead962814af248488bb6597ee22a32fc23d00a1"')
    expect(requirementFrom('Executable=/x/unsigned\ncode object is not signed at all\n')).toBeNull()
  })
})

describe("ptyhost's OS layer", () => {
  it("U-PLT-11 · ptyhost's layer: chosen once for this system; macOS and Linux have every capability", () => {
    expect(ptyhostOs).toBe(systemOf(process.platform) === 'linux' ? linux : darwin) // os-ok: the layer of the system this runs on (both run this suite)
    expect(unavailable(darwin)).toEqual([])
    expect(unavailable(linux)).toEqual([])
  })
})
