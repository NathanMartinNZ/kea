// Kea.app's signature and its check, shared by `pnpm kea:install` and `pnpm package --target mac-arm64`.
// Each failing line throws an Error that names the line it breaks; the caller prints it and stops. Every system tool is
// run by the OS layer's path.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { need } from '../../../packages/protocol/src/platform.ts'
import { fuseStates, type FuseWire, type FusesApi } from './app.ts'
import { auditApp } from './audit.ts'
import { HELPER_ID, HELPER_NAME } from './config.ts'
import { packOs, type PackTool } from './os/index.ts'
import { readSignature } from './signature.ts'
import { APP_ID } from './target.ts'

/** The one signing identity of every build. */
export const IDENTITY = 'Kea Local Code Signing'

/** A system tool by its absolute path (the OS layer's `packTools`). */
export const tool = (t: PackTool): string => need(packOs.tools).path(t)

export function quiet(file: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(file, args, { encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** How to create the certificate, once (the OS layer's `installPlace`). */
const certSteps = (): string => need(packOs.installPlace).certificateSteps(IDENTITY)

/** The SHA-1 of the one valid "Kea Local Code Signing" identity (signing by hash is never ambiguous). Read-only. */
export function signingIdentity(): string {
  const list = (args: string[]) => execFileSync(tool('security'), ['find-identity', ...args, '-p', 'codesigning'], { encoding: 'utf8' })
  const valid = [...list(['-v']).matchAll(/^\s*\d+\) ([0-9A-F]{40}) "(.*)"\s*$/gm)].filter((m) => m[2] === IDENTITY)
  if (valid.length === 1) return (valid[0] as RegExpMatchArray)[1] as string
  if (valid.length > 1) throw new Error(`${valid.length} valid identities are named "${IDENTITY}" (${valid.map((m) => m[1]).join(', ')}): keep one, delete the others in Keychain Access.`)
  if (list([]).includes(`"${IDENTITY}"`)) throw new Error(`"${IDENTITY}" is in your keychain but not valid for code signing (usually: not trusted).\n${certSteps()}`)
  throw new Error(`the code-signing certificate "${IDENTITY}" was not found.\n${certSteps()}`)
}

const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

function isMachO(file: string): boolean {
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(4)
    return fs.readSync(fd, b, 0, 4, 0) === 4 && MACHO_MAGIC.has(b.readUInt32BE(0))
  } finally {
    fs.closeSync(fd)
  }
}

/** A bundle's own executable is signed with its bundle, not as a loose file. */
function isBundleExecutable(file: string): boolean {
  const fw = /\/([^/]+)\.framework\/Versions\/[^/]+\/([^/]+)$/.exec(file)
  if (fw && fw[1] === fw[2]) return true
  const app = /^(.*\.app)\/Contents\/MacOS\/([^/]+)$/.exec(file)
  if (!app) return false
  const exe = quiet(tool('plutil'), ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(app[1] as string, 'Contents', 'Info.plist')]).out.trim()
  return exe === app[2]
}

/** Everything under Contents that needs its own signature, deepest first (inside-out): loose Mach-O files, bundles. */
function nestedCode(app: string): string[] {
  const items: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue // framework `Versions/Current` and top-level links: signed through their targets
      if (e.isDirectory()) {
        walk(p)
        if (/\.(app|framework)$/.test(e.name)) items.push(p)
      } else if (e.isFile() && isMachO(p) && !isBundleExecutable(p)) items.push(p)
    }
  }
  walk(path.join(app, 'Contents'))
  const depth = (p: string) => p.split(path.sep).length
  return items.sort((a, b) => depth(b) - depth(a) || a.localeCompare(b))
}

/** Sign inside out: every loose Mach-O, every nested bundle, `kea-helper` as `dev.kea.helper`, then the app. */
export function signAll(app: string, identity: string): { items: string[]; nativeModules: string[] } {
  const helper = path.join(app, 'Contents', 'Resources', HELPER_NAME)
  const items = [...nestedCode(app), app]
  if (!items.includes(helper)) throw new Error(`kea-helper is missing from ${helper}`)
  for (const item of items) {
    const args = ['--force', '--sign', identity, '--timestamp=none', ...(item === helper ? ['--identifier', HELPER_ID] : []), item]
    const r = quiet(tool('codesign'), args)
    if (r.status !== 0) throw new Error(`codesign ${args.join(' ')}:\n${r.out}`)
  }
  return { items, nativeModules: items.filter((p) => p.endsWith('.node')).map((p) => path.relative(app, p)) }
}

export function plistOf(app: string): Record<string, unknown> {
  return JSON.parse(execFileSync(tool('plutil'), ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' })) as Record<string, unknown>
}

/** The app's designated requirement, as `codesign -d -r-` prints it. */
export function designatedRequirement(app: string): string {
  return /designated => (.*)$/m.exec(quiet(tool('codesign'), ['-d', '-r-', app]).out)?.[1] ?? ''
}

/** `codesign --verify --deep --strict`, or the reason it fails. */
export function verifyDeep(app: string): string | null {
  const deep = quiet(tool('codesign'), ['--verify', '--deep', '--strict', '--verbose=2', app])
  return deep.status === 0 ? null : deep.out
}

/** The checks of a built Kea.app, line by line: each failure names the line it breaks; returns the lines that hold. */
export function checkMacApp(app: string, o: { fuses: FusesApi; wire: FuseWire; adhoc: boolean; signed: readonly string[] }): string[] {
  const lines: string[] = []
  const deep = verifyDeep(app)
  if (deep !== null) throw new Error(`codesign --verify --deep --strict failed:\n${deep}`)
  lines.push(`codesign --verify --deep --strict: ok`)

  const appSig = readSignature(app)
  const helperSig = readSignature(path.join(app, 'Contents', 'Resources', HELPER_NAME))
  if (appSig.identifier !== APP_ID) throw new Error(`Kea.app's identifier is ${appSig.identifier}, not ${APP_ID}`)
  if (helperSig.identifier !== HELPER_ID) throw new Error(`kea-helper's identifier is ${helperSig.identifier}, not ${HELPER_ID}:\n${helperSig.raw}`)
  const signer = appSig.adhoc ? 'ad hoc' : (appSig.signer ?? '?')
  if (!o.adhoc && signer !== IDENTITY) throw new Error(`Kea.app is signed by ${signer}, not ${IDENTITY}:\n${appSig.raw}`)
  if (o.adhoc && signer !== 'ad hoc') throw new Error(`Kea.app should be signed ad hoc:\n${appSig.raw}`)
  // the app, the helper, every native module and every nested bundle: one signer, no hardened runtime, no team
  for (const item of o.signed) {
    const sig = item === app ? appSig : readSignature(item)
    const name = path.relative(path.dirname(app), item)
    const by = sig.adhoc ? 'ad hoc' : (sig.signer ?? 'nobody')
    if (by !== signer) throw new Error(`${name} is signed by ${by}, not ${signer}:\n${sig.raw}`)
    if (sig.runtime) throw new Error(`${name} has the hardened runtime on: Kea's builds are signed without it`)
    const team = /^TeamIdentifier=(.*)$/m.exec(sig.raw)?.[1] ?? 'not set'
    if (team !== 'not set') throw new Error(`${name} carries the team identifier ${team}: Kea is signed with the local certificate only, no Developer ID`)
  }
  // arm64 only: the app's executable, the helper and every loose Mach-O
  const machO = [path.join(app, 'Contents', 'MacOS', 'Kea'), ...o.signed.filter((p) => fs.statSync(p).isFile())]
  for (const file of machO) {
    const archs = quiet(tool('lipo'), ['-archs', file]).out.trim()
    if (archs !== 'arm64') throw new Error(`${path.relative(path.dirname(app), file)} is built for "${archs}", not arm64 alone`)
  }
  lines.push(`Kea.app: Identifier=${APP_ID}, signed ${signer}${o.adhoc ? ' (NOT installable)' : ''}`)
  lines.push(`kea-helper: Identifier=${helperSig.identifier}, ${helperSig.format}`)
  lines.push(`${o.signed.length} signatures, all by ${signer}, hardened runtime off, no team identifier; ${machO.length} executables, all arm64`)
  if (!o.adhoc) {
    const req = designatedRequirement(app)
    if (!/certificate leaf = H"[0-9a-fA-F]+"/.test(req)) throw new Error(`Kea.app's designated requirement pins no certificate leaf (holders admit later builds by the identifier and that leaf): ${req}`)
    lines.push(`designated requirement: ${req}`)
  }

  const fuses = fuseStates(o.fuses, o.wire)
  if (fuses.wrong.length) throw new Error(fuses.wrong.join('\n'))
  lines.push(fuses.line)
  const plist = plistOf(app)
  const asars = Object.keys((plist.ElectronAsarIntegrity as Record<string, unknown> | undefined) ?? {})
  if (!asars.includes('Resources/app.asar')) throw new Error(`Info.plist has no ElectronAsarIntegrity entry for Resources/app.asar (${asars.join(', ') || 'none'})`)
  const resources = fs.readdirSync(path.join(app, 'Contents', 'Resources'))
  if (resources.includes('default_app.asar') || resources.includes('app')) throw new Error(`Contents/Resources must hold no default_app.asar or app/ (${resources.join(', ')})`)
  lines.push(`Info.plist: ElectronAsarIntegrity covers ${asars.join(', ')}`)

  // No update feed, no crash reporter, no network client; native modules unpacked (audit.ts)
  const audit = auditApp(app, Object.keys(plist))
  if (audit.problems.length) throw new Error(`the packaged app carries what Kea must not ship:\n  ${audit.problems.join('\n  ')}`)
  const unsignedNative = audit.nativeModules.filter((n) => !o.signed.includes(path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', n)))
  if (unsignedNative.length) throw new Error(`native modules in app.asar.unpacked that were not signed: ${unsignedNative.join(', ')}`)
  lines.push(`audit: ${audit.summary}`)
  return lines
}
