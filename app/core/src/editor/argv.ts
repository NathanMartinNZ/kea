// The editor launch strategies as argv (every path is one argv element, never part of a shell string).
// Pure: what would be run, in the order it is tried.
//
//   1. the CLI inside the app bundle   code <dir> · code <dir> <file> · code <dir> --goto <file>:<line>:<col>
//                                      zed <dir> · zed <dir> <file> · zed <dir> <file>:<line>:<col>
//   2. open -a <bundle> <path>         folder or file, no position
//   3. open -a <bundle> <scheme>://file/<path>:<line>:<col>
//
// Every strategy names the app by the path of the bundle detection accepted (in an application folder, never in a
// repository). None names it by bundle id (`open -b`) or leaves it to the handler of the URL's scheme: the system
// answers both with whichever registered bundle it prefers, and a bundle lying in a cloned repository is registered
// like any other.
//
// A file whose name a position parser would misread (`a:1`) is opened with strategy 2 alone.
//
// On Linux an editor is its command-line tool, found as a command (commands.ts), and an editor's URL goes to `xdg-open`
// (`linuxLaunchPlan`).

import type { EditorDef, LinuxTerminalAppDef } from './catalog.ts'

export interface LaunchTarget {
  /** The folder the editor's window is for: the session's working directory, or the project's root. */
  dir: string
  /** A file to show in that window (absolute), or null: the folder alone. */
  file: string | null
  /** 1-based; null: no position. */
  line: number | null
  col: number | null
}

export const STRATEGIES = ['cli', 'bundle', 'url'] as const
export type Strategy = (typeof STRATEGIES)[number]

export interface Attempt {
  strategy: Strategy
  file: string
  args: string[]
}

/**
 * Whether `file:line:col` reads back as this file. The VS Code family's `--goto` splits the argument at every `:` and
 * takes any part that is a number as the line or the column, wherever it stands, so `a:1` would open `a` at line 1;
 * an empty part is the number 0 to it.
 */
export function positionSafe(file: string): boolean {
  const parts = file.split(':')
  return parts.length === 1 || parts.slice(1).every((p) => Number.isNaN(Number(p)))
}

/** `file`, `file:line` or `file:line:col`. */
function withPosition(file: string, line: number | null, col: number | null): string {
  if (line === null) return file
  return col === null ? `${file}:${line}` : `${file}:${line}:${col}`
}

/** Strategy 3's URL: the path's segments percent-encoded, so nothing in a name is taken for URL syntax. */
export function editorUrl(scheme: string, file: string, line: number | null, col: number | null): string {
  const encoded = file.split('/').map(encodeURIComponent).join('/')
  return withPosition(`${scheme}://file${encoded}`, line, col)
}

function cliArgs(def: EditorDef, t: LaunchTarget): string[] {
  if (t.file === null) return [t.dir]
  if (t.line === null) return [t.dir, t.file]
  const at = withPosition(t.file, t.line, t.col ?? 1)
  return def.position === 'goto' ? [t.dir, '--goto', at] : [t.dir, at]
}

/**
 * What to run to open `t` in the editor installed at `o.bundle` (the bundle detection accepted, by its path), in the
 * order to try it. `cli`: that bundle's CLI when it is there and executable, else null (strategy 1 is skipped). `open`:
 * the system's `open`, always told which app with `-a <bundle>`.
 */
export function launchPlan(def: EditorDef, o: { bundle: string; cli: string | null; open: string }, t: LaunchTarget): Attempt[] {
  const path = t.file ?? t.dir
  const bundle: Attempt = { strategy: 'bundle', file: o.open, args: ['-a', o.bundle, path] }
  if (t.file !== null && !positionSafe(t.file)) return [bundle]
  const plan: Attempt[] = []
  if (o.cli !== null) plan.push({ strategy: 'cli', file: o.cli, args: cliArgs(def, t) })
  plan.push(bundle)
  // a URL's path is read for a position too: a folder whose name would be misread gets no URL attempt
  if (positionSafe(path)) plan.push({ strategy: 'url', file: o.open, args: ['-a', o.bundle, editorUrl(def.scheme, path, t.file === null ? null : t.line, t.file === null ? null : t.col)] })
  return plan
}

/**
 * On Linux: what to run to open `t` with the editor whose command-line tool is `o.cli` (found as commands.ts says), in
 * the order to try it: that tool with argv (as strategy 1 on macOS), then the editor's URL through `o.open`
 * (`xdg-open`). There is no strategy 2. A file whose name a position parser would misread is given to the VS Code
 * family without `--goto`, which then reads no position from it, at no position and with no URL attempt; Zed reads a
 * position from every file argument, so it opens the folder alone.
 */
export function linuxLaunchPlan(def: EditorDef, o: { cli: string; open: string }, t: LaunchTarget): Attempt[] {
  if (t.file !== null && !positionSafe(t.file)) {
    return [{ strategy: 'cli', file: o.cli, args: def.position === 'goto' ? [t.dir, t.file] : [t.dir] }]
  }
  const plan: Attempt[] = [{ strategy: 'cli', file: o.cli, args: cliArgs(def, t) }]
  const path = t.file ?? t.dir
  if (positionSafe(path)) plan.push({ strategy: 'url', file: o.open, args: [editorUrl(def.scheme, path, t.file === null ? null : t.line, t.file === null ? null : t.col)] })
  return plan
}

/** The folder in a terminal app on Linux: the app's own command with its folder argument, started in that folder. */
export function linuxTerminalAppArgv(app: string, def: LinuxTerminalAppDef, dir: string): { file: string; args: string[] } {
  return { file: app, args: def.dirArgs(dir) }
}

/** The folder in a terminal app (`open -a <app> <dir>`). */
export function terminalAppArgv(open: string, app: string, dir: string): { file: string; args: string[] } {
  return { file: open, args: ['-a', app, dir] }
}

/** `gh`'s arguments for `session.createPR`. */
export const CREATE_PR_ARGS: readonly string[] = ['pr', 'create', '--web']
