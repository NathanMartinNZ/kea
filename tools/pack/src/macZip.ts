// macOS's release files: the signed app zipped with `ditto` (what `install.sh` and Squirrel.Mac unpack
// with), the zip's `.blockmap` for electron-updater's differential download, and `latest-mac.yml`, the feed that names
// the zip by its versioned release URL. The zip is checked once unpacked.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { PRODUCT_NAME, releaseFileNames, releaseUrls } from '../../../packages/protocol/src/release.ts'
import { designatedRequirement, quiet, tool, verifyDeep } from './macApp.ts'

export function zipName(version: string): string {
  return releaseFileNames(version, 'arm64').zip
}

/** `ditto -c -k --sequesterRsrc --keepParent`: the bundle with its links, modes and signatures as they are. */
export function makeZip(app: string, zip: string): void {
  fs.rmSync(zip, { force: true })
  const r = quiet(tool('ditto'), ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
  if (r.status !== 0) throw new Error(`ditto could not zip ${app}:\n${r.out}`)
}

type BlockMapApi = { buildBlockMap(file: string, compression: 'gzip', out: string): Promise<{ size: number; sha512: string }> }

/** The zip's blockmap beside it (`<zip>.blockmap`, electron-builder's own format); returns the zip's size and SHA-512. */
export async function makeBlockmap(root: string, zip: string): Promise<{ size: number; sha512: string; blockmap: string }> {
  const lib = path.dirname(createRequire(createRequire(path.join(root, 'tools/pack/package.json')).resolve('electron-builder')).resolve('app-builder-lib/package.json'))
  const api = createRequire(path.join(lib, 'package.json'))('./out/targets/blockmap/blockmap.js') as BlockMapApi
  const blockmap = `${zip}.blockmap`
  const info = await api.buildBlockMap(zip, 'gzip', blockmap)
  return { ...info, blockmap }
}

/**
 * `latest-mac.yml` (electron-updater's format): the zip by its versioned release URL when the repository is named, by
 * its file name while it is not (a feed beside the zip).
 */
export function latestMacYml(o: { version: string; zip: string; sha512: string; size: number; repository: string | null; releaseDate: string }): string {
  const url = o.repository === null ? o.zip : releaseUrls(o.repository).file(o.version, o.zip)
  return [`version: ${o.version}`, 'files:', `  - url: ${url}`, `    sha512: ${o.sha512}`, `    size: ${o.size}`, `path: ${url}`, `sha512: ${o.sha512}`, `releaseDate: '${o.releaseDate}'`, ''].join('\n')
}

/**
 * The zip unpacked as `install.sh` unpacks it (`ditto -x -k`) holds one Kea.app that verifies
 * (`codesign --verify --deep --strict`) with the same designated requirement as the app it was made from.
 */
export function checkZip(zip: string, built: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-zip-'))
  try {
    const r = quiet(tool('ditto'), ['-x', '-k', zip, dir])
    if (r.status !== 0) throw new Error(`ditto could not unpack ${path.basename(zip)}:\n${r.out}`)
    const names = fs.readdirSync(dir)
    if (names.length !== 1 || names[0] !== `${PRODUCT_NAME}.app`) throw new Error(`${path.basename(zip)} holds ${names.join(', ') || 'nothing'}, not ${PRODUCT_NAME}.app alone`)
    const app = path.join(dir, `${PRODUCT_NAME}.app`)
    const deep = verifyDeep(app)
    if (deep !== null) throw new Error(`the unpacked zip does not verify:\n${deep}`)
    const req = designatedRequirement(app)
    if (req === '' || req !== designatedRequirement(built)) throw new Error(`the unpacked app's designated requirement differs from the build's: ${req}`)
    return `zip: unpacked with ditto, codesign --verify --deep --strict ok, the same designated requirement`
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
