// The app's build, shared by `pnpm package` (tools/package.ts) and `pnpm kea:install` (tools/install.ts):
// electron-builder makes it from config.ts, then the fuses are flipped and read back.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { builderConfig, builtApp, FUSES, fuseTarget, resourcesOf, type AppInputs, type Target } from './config.ts'

type BuilderApi = {
  build(o: { projectDir: string; targets: unknown; publish: 'never'; config: Record<string, unknown> }): Promise<string[]>
  Platform: { MAC: { createTarget(types: string[], ...archs: number[]): unknown }; LINUX: { createTarget(types: string[], ...archs: number[]): unknown } }
  Arch: { arm64: number; x64: number }
}
export type FuseWire = Record<number, number>
export type FusesApi = {
  FuseVersion: { V1: string }
  FuseV1Options: Record<string, number>
  FuseState: { DISABLE: number; ENABLE: number }
  flipFuses(app: string, config: Record<string | number, unknown>): Promise<number>
  getCurrentFuseWire(app: string): Promise<FuseWire>
}

/** The pinned Electron on disk (app/main's), and its version. */
export function electronOf(root: string): { dir: string; version: string } {
  const dir = path.dirname(createRequire(path.join(root, 'app/main/package.json')).resolve('electron/package.json'))
  return { dir, version: (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version }
}

/**
 * electron-builder's `dir` target for `target`, unsigned, into `i.output`; returns where the app is. What was at that
 * place is removed first.
 */
export async function buildApp(root: string, target: Target, i: AppInputs): Promise<string> {
  const builder = createRequire(path.join(root, 'tools/pack/package.json'))('electron-builder') as BuilderApi
  const app = builtApp(target, i.output)
  fs.rmSync(i.output, { recursive: true, force: true })
  const platform = target.system === 'darwin' ? builder.Platform.MAC : builder.Platform.LINUX
  await builder.build({ projectDir: root, targets: platform.createTarget(['dir'], builder.Arch[target.arch]), publish: 'never', config: builderConfig(target, i) })
  if (!fs.existsSync(app)) throw new Error(`electron-builder produced no ${path.relative(root, app)}`)
  return app
}

export async function loadFuses(root: string): Promise<FusesApi> {
  const entry = createRequire(path.join(root, 'tools/pack/package.json')).resolve('@electron/fuses')
  return (await import(pathToFileURL(entry).href)) as FusesApi
}

/**
 * Debug symbols out of the native modules (`strip -S`, both systems' strip): a module pnpm built here (the patched
 * watcher) names its build folder in them, and no shipped file may name the build machine. Before signing.
 * Returns the modules stripped.
 */
export function stripNativeModules(target: Target, app: string, strip: string): string[] {
  const unpacked = path.join(resourcesOf(target, app), 'app.asar.unpacked')
  const found: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.node')) found.push(p)
    }
  }
  if (fs.existsSync(unpacked)) walk(unpacked)
  for (const f of found) {
    const r = spawnSync(strip, ['-S', f], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`strip -S ${f} failed: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || r.error?.message}`)
  }
  return found.map((f) => path.relative(unpacked, f))
}

/** Flip the fuses (config.ts `FUSES`); on macOS before signing (the signature is made next, so none is reset here). */
export async function flipFuses(fuses: FusesApi, target: Target, app: string): Promise<void> {
  const config: Record<string | number, unknown> = { version: fuses.FuseVersion.V1, resetAdHocDarwinSignature: false }
  for (const [name, on] of Object.entries(FUSES)) config[fuses.FuseV1Options[name] as number] = on
  await fuses.flipFuses(fuseTarget(target, app), config)
}

/** Each fuse of `FUSES` as read back: the check's line, or the fuse that is wrong. */
export function fuseStates(fuses: Pick<FusesApi, 'FuseV1Options' | 'FuseState'>, wire: FuseWire): { line: string; wrong: string[] } {
  const states: string[] = []
  const wrong: string[] = []
  for (const [name, on] of Object.entries(FUSES)) {
    const got = wire[fuses.FuseV1Options[name] as number]
    if (got !== (on ? fuses.FuseState.ENABLE : fuses.FuseState.DISABLE)) wrong.push(`fuse ${name} reads back ${got}, expected ${on ? 'on' : 'off'}`)
    states.push(`${name} ${on ? 'on' : 'off'}`)
  }
  return { line: `fuses read back: ${states.join(' · ')}`, wrong }
}
