// Command Code detection and options: `cmd` on the login-shell PATH (or the `agents.commandcode.command` override),
// `--version` against the contract's minimum, `status --json` for the signed-in indicator, and the two lists the CLI
// prints itself: its permission modes (`--help`) and its models (`--list-models`, human text: the parser fails soft, a
// free-text model always remains). Never throws.

import { runProcess } from '@kea/kit'
import { L, type AgentOptions, type PermissionModeOption } from '@kea/protocol'
import { editEnv, findOnPath } from '../kit/env.ts'
import { atLeast } from '../kit/version.ts'
import type { Detection, Env, ListedModel } from '../types.ts'
import {
  COMMAND,
  DANGEROUS_MODE_RE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_LABEL,
  EFFORTS,
  ENV_REMOVED,
  FLAGS,
  HELP_MODES_RE,
  LOGIN,
  MIN_VERSION,
  MODEL_DEFAULT_MARK,
  MODEL_ROW_RE,
  MODELS_HINT,
  PERMISSION_MODES,
  STATUS,
  STATUS_FIELDS,
  VERSION_RE,
} from './contract.ts'

/** `cmd --version`'s output → `1.79.2`, or null. */
export function parseVersion(out: string): string | null {
  return VERSION_RE.exec(out)?.[1] ?? null
}

/** `cmd status --json`: its `authenticated` field when it prints JSON, else exit 0 signed in, 1 not; anything else unknown. */
export function parseStatus(code: number | null, out: string): boolean | null {
  try {
    const o: unknown = JSON.parse(out)
    if (o && typeof o === 'object' && typeof (o as Record<string, unknown>)[STATUS_FIELDS.authenticated] === 'boolean') return (o as Record<string, boolean>)[STATUS_FIELDS.authenticated]!
  } catch {
    // not JSON: the exit code decides
  }
  return code === 0 ? true : code === 1 ? false : null
}

/** The names `cmd --help` lists for `--permission-mode`, as printed; none when the line is not there. */
export function parseHelpModes(help: string): string[] {
  const list = HELP_MODES_RE.exec(help)?.[1] ?? ''
  const out: string[] = []
  for (const part of list.split(',')) {
    const name = part.trim()
    if (/^[a-z][a-z0-9-]*$/.test(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** Every long flag `cmd --help` prints (K-CM-2). */
export function parseHelpFlags(help: string): Set<string> {
  const flags = new Set<string>()
  for (const m of help.matchAll(/(?:^|[\s,])(--[a-z][a-z0-9-]*)/g)) flags.add(m[1]!)
  return flags
}

/**
 * `cmd --list-models` → its rows: `<id>  <description>` under provider headings, `(default)` marking the CLI's
 * default, up to the hint that follows the list. Anything else (a heading, a blank line, garbage) is skipped, so a
 * format it does not know gives an empty list, never a throw.
 */
export function parseModels(text: string): ListedModel[] {
  const out: ListedModel[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    if (line.startsWith(MODELS_HINT) || out.length >= L.ccModelsMax) break
    const m = MODEL_ROW_RE.exec(line)
    if (!m || seen.has(m[1]!)) continue
    seen.add(m[1]!)
    const isDefault = MODEL_DEFAULT_MARK.test(m[2]!)
    out.push({ id: m[1]!, description: m[2]!.replace(MODEL_DEFAULT_MARK, '').trim(), isDefault })
  }
  return out
}

/**
 * The permission modes to offer, from the names the CLI's help lists: the contract's modes it names, in the
 * contract's order (`standard` and `default` are one mode), then names the contract does not know, under their own name.
 * Without a help text (not detected yet, or unreadable): the modes of the version the contract was verified on.
 */
export function modesOffered(names: readonly string[] | null): PermissionModeOption[] {
  const listed = names && names.length ? names : KNOWN_HELP_NAMES
  const out: PermissionModeOption[] = PERMISSION_MODES.filter((m) => m.names.some((n) => listed.includes(n))).map((m) => ({ id: m.id, label: m.label, dangerous: m.dangerous }))
  const known = new Set<string>(PERMISSION_MODES.flatMap((m) => m.names))
  for (const n of listed) if (!known.has(n)) out.push({ id: n, label: n, dangerous: DANGEROUS_MODE_RE.test(n) })
  return out
}

/** What 1.79.2's help lists (K-CM-2 keeps it true): used until a help text has been read. */
const KNOWN_HELP_NAMES: readonly string[] = ['standard', 'plan', 'accept-edits', 'yolo']

export async function detect(env: Readonly<Env>, command: string | null): Promise<Detection> {
  const path = findOnPath(COMMAND, env.PATH, command)
  if (!path) {
    const notice = command ? `The Command Code command ${command} is not an executable file` : `Command Code is not installed: ${COMMAND} is not on the login shell PATH`
    return { installed: false, path: null, version: null, supported: false, loggedIn: null, notice }
  }
  const runEnv = editEnv(env, { remove: ENV_REMOVED, set: {} }).env
  const run = async (args: readonly string[]) => {
    try {
      const r = await runProcess(path, [...args], { pool: 'other', env: runEnv, timeoutMs: L.agentDetectTimeoutMs })
      return { code: r.timedOut ? null : r.code, out: r.stdout?.toString('utf8') ?? '' }
    } catch {
      return { code: null, out: '' }
    }
  }
  const v = await run([FLAGS.version])
  const version = parseVersion(v.out)
  // the rest at once: each is a start of the CLI (a Node program), and none depends on another
  const [status, help, list] = await Promise.all([run(STATUS), run([FLAGS.help]), run([FLAGS.listModels])])
  const loggedIn = parseStatus(status.code, status.out)
  const modes = help.code === 0 ? parseHelpModes(help.out) : []
  const models = list.code === 0 ? parseModels(list.out) : []
  // An unknown newer version is assumed compatible; an unreadable one is not refused either
  const supported = version === null || atLeast(version, MIN_VERSION)
  let notice: string | null = null
  if (version === null) notice = 'Command Code’s version could not be read'
  else if (!supported) notice = `Command Code ${version} is older than ${MIN_VERSION}: update it with: ${COMMAND} update`
  else if (loggedIn === false) notice = `Command Code is signed out: run ${[COMMAND, ...LOGIN].join(' ')} in a terminal`
  return { installed: true, path, version, supported, loggedIn, notice, listed: { models: models.length ? models : null, permissionModes: modes.length ? modes : null } }
}

/**
 * The composer's knobs: `Default` (no `--model`: the person's own Command Code default) and the CLI's own list,
 * each with the effort levels (a model that lacks one ignores it); a free-text id always; the modes its help lists.
 */
export function options(d: Pick<Detection, 'listed'>): AgentOptions {
  const efforts = [...EFFORTS]
  return {
    models: [{ id: DEFAULT_MODEL, label: DEFAULT_MODEL_LABEL, efforts, isDefault: true }, ...(d.listed?.models ?? []).filter((m) => m.id !== DEFAULT_MODEL).map((m) => ({ id: m.id, label: m.id, efforts, isDefault: false }))],
    allowCustomModel: true,
    permissionModes: modesOffered(d.listed?.permissionModes ?? null),
  }
}
