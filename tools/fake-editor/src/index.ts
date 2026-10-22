// How a test puts stand-ins where Kea looks for editors and tools (tools/fake-editor/README.md), and reads what they
// were asked to do. Everything is written under a folder the test owns; nothing here launches anything.
//
//   import { installBundle, installTool, readCalls } from '@kea-tools/fake-editor/src/index.ts'
//   const log = path.join(root, 'calls.ndjson')
//   installBundle(path.join(root, 'Applications'), { appName: 'Visual Studio Code.app', bundleId: 'com.microsoft.VSCode', cli: 'Contents/Resources/app/bin/code' }, { log })
//   installTool(path.join(root, 'bin', 'open'), { as: 'open', log })
//   … Kea opens something …
//   readCalls(log)   // [{ tool: 'code', argv: ['/the/worktree'], cwd, env }]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FakeCall } from './main.ts'

export { bundleLines, parseFakeArgs, USAGE, type FakeCall, type FakeOptions } from './main.ts'

/** The stand-in program (run with Node; types are stripped). */
export function fakeScript(): string {
  return fileURLToPath(new URL('./main.ts', import.meta.url))
}

export interface ToolOptions {
  /** What it stands for, as the log names it (`code`, `open`, `mdfind`, `gh`). */
  as: string
  /** The log every run appends to. */
  log: string
  /** Exit code (default 0). */
  exit?: number
  /** Written to stderr on every run. */
  stderr?: string
  /** For `mdfind`: the JSON file mapping bundle ids to app paths (`writeBundles`). */
  bundles?: string
  /** The Node that runs it (default: this process's; under Electron pass a real node). */
  node?: string
}

const sh = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * Write an executable at `file` that records its run and exits as `o` says. It is a two-line `sh` script that hands
 * its arguments to main.ts untouched, so it works with whatever PATH the caller has.
 */
export function installTool(file: string, o: ToolOptions): string {
  const words = [o.node ?? process.execPath, fakeScript(), '--as', o.as, '--log', o.log]
  if (o.exit !== undefined) words.push('--exit', String(o.exit))
  if (o.stderr !== undefined) words.push('--stderr', o.stderr)
  if (o.bundles !== undefined) words.push('--bundles', o.bundles)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\nexec ${words.map(sh).join(' ')} -- "$@"\n`, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
  return file
}

export interface BundleDef {
  /** The bundle's folder name (`Visual Studio Code.app`). */
  appName: string
  bundleId: string
  /** The CLI's path inside the bundle; omitted: a bundle with no CLI (found by its bundle id only). */
  cli?: string
}

/**
 * A stand-in app bundle in `appsDir`: the folder, its `Info.plist` naming the bundle id, and — when `def.cli` is given —
 * the bundled CLI as a recording tool (`o.as` defaults to the CLI's file name). Returns the bundle's path.
 */
export function installBundle(appsDir: string, def: BundleDef, o: Omit<ToolOptions, 'as'> & { as?: string }): string {
  const bundle = path.join(appsDir, def.appName)
  fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true })
  fs.writeFileSync(
    path.join(bundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${def.bundleId}</string></dict></plist>\n`,
  )
  if (def.cli) installTool(path.join(bundle, def.cli), { ...o, as: o.as ?? path.basename(def.cli) })
  return bundle
}

/** The file a fake `mdfind` answers from: bundle id → app path. */
export function writeBundles(file: string, bundles: Readonly<Record<string, string>>): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(bundles))
  return file
}

/** Every run recorded in `log`, oldest first; none when nothing ran. */
export function readCalls(log: string): FakeCall[] {
  let text: string
  try {
    text = fs.readFileSync(log, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FakeCall)
}
