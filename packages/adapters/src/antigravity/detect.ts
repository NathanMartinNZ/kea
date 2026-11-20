// Antigravity CLI detection and options: `agy` on the login-shell PATH (or the `agents.antigravity.command` override),
// `--version` (stdout) against the contract's minimum, `--help` (printed to stderr by Go's `flag` package, with stdout
// fallback) for permission modes and effort levels, and `agy models` (stdout `<id>\t<label>`) for the model list.
// Effort-suffixed model rows are grouped by family when a family has at least two variants; single-variant and
// non-effort models keep `efforts: []` because passing `--effort` with them causes `agy` to fall back to its default
// model. Never throws.

import { runProcess } from '@kea/kit'
import { L, type AgentOptions, type ModelOption, type PermissionModeOption } from '@kea/protocol'
import { editEnv, findOnPath } from '../kit/env.ts'
import { atLeast } from '../kit/version.ts'
import type { Detection, Env, ListedModel } from '../types.ts'
import { ownStatusLine } from './config.ts'
import {
  COMMAND,
  DANGEROUS_MODE_RE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_LABEL,
  EFFORTS,
  FLAGS,
  HELP_EFFORTS_RE,
  HELP_MODES_RE,
  MIN_VERSION,
  MODELS_HEADER,
  PERMISSION_MODES,
  STRIP_ENV_PREFIX,
  SUBCOMMANDS,
  VERSION_RE,
  type EffortLevel,
} from './contract.ts'

/** `agy --version`'s output → `1.5.13`, or null. */
export function parseVersion(out: string): string | null {
  return VERSION_RE.exec(out)?.[1] ?? null
}

/** The `--mode` values `agy --help` lists (`(accept-edits, auto, plan)`), in printed order. */
export function parseHelpModes(help: string): string[] {
  const list = HELP_MODES_RE.exec(help)?.[1] ?? ''
  const out: string[] = []
  for (const part of list.split(/[,|]/)) {
    const name = part.trim()
    if (/^[a-z][a-z0-9-]*$/.test(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** The `--effort` levels `agy --help` lists (`(low|medium|high|xhigh|max)`), in printed order. */
export function parseHelpEfforts(help: string): string[] {
  const list = HELP_EFFORTS_RE.exec(help)?.[1] ?? ''
  const out: string[] = []
  for (const part of list.split(/[,|]/)) {
    const name = part.trim()
    if (/^[a-z][a-z0-9-]*$/.test(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** Every long flag `agy --help` prints. */
export function parseHelpFlags(help: string): Set<string> {
  const flags = new Set<string>()
  for (const m of help.matchAll(/(?:^|[\s,])(--[a-z][a-z0-9-]*)/g)) flags.add(m[1]!)
  return flags
}

/**
 * `agy models` stdout → its `<id>\t<label>` rows, deduplicated and capped at `L.agModelsMax`. Blank lines, the
 * `Fetching available models...` status line, and any line without a tab are skipped so unexpected output fails soft
 * to an empty list and never throws.
 */
export function parseModels(text: string): ListedModel[] {
  const out: ListedModel[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    if (out.length >= L.agModelsMax) break
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (!line || line.startsWith(MODELS_HEADER)) continue
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const id = line.slice(0, tab).trim()
    const description = line.slice(tab + 1).trim()
    if (!id || !description || !/^[A-Za-z0-9][\w.:/@+-]*[A-Za-z0-9]$/.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, description, isDefault: false })
  }
  return out
}

const EFFORT_ID_RE = new RegExp(`^(.+)-(${EFFORTS.join('|')})$`)
const EFFORT_LABEL_RE = new RegExp(`^(.+?)\\s+\\((${EFFORTS.join('|')})\\)$`, 'i')

interface EffortVariantMatch {
  baseId: string
  baseLabel: string
  effort: EffortLevel
}

/**
 * Matches a row whose `id` ends with `-(low|medium|high|xhigh|max)` and whose label ends with ` (<Effort>)` for that
 * same effort level.
 */
function matchEffortVariant(m: ListedModel): EffortVariantMatch | null {
  const idMatch = EFFORT_ID_RE.exec(m.id)
  if (!idMatch) return null
  const baseId = idMatch[1]!
  const effort = idMatch[2] as EffortLevel
  const labelMatch = EFFORT_LABEL_RE.exec(m.description)
  if (!labelMatch || labelMatch[2]!.toLowerCase() !== effort) return null
  const baseLabel = labelMatch[1]!.trim()
  if (!baseId || !baseLabel) return null
  return { baseId, baseLabel, effort }
}

/**
 * Groups `agy models` rows into composer `ModelOption` entries. Families with at least two effort-suffixed variants
 * collapse into one option (`id: baseId`, `label: baseLabel`, `efforts` ordered canonically by `EFFORTS`); single-variant
 * and non-effort models keep their exact `id` and `efforts: []`.
 */
export function groupModels(models: readonly ListedModel[]): ModelOption[] {
  const parsed = models.map((m) => ({ model: m, variant: matchEffortVariant(m) }))
  const familyCounts = new Map<string, number>()
  const familyEfforts = new Map<string, Set<EffortLevel>>()
  const familyLabel = new Map<string, string>()

  for (const { variant } of parsed) {
    if (!variant) continue
    familyCounts.set(variant.baseId, (familyCounts.get(variant.baseId) ?? 0) + 1)
    let set = familyEfforts.get(variant.baseId)
    if (!set) {
      set = new Set<EffortLevel>()
      familyEfforts.set(variant.baseId, set)
    }
    set.add(variant.effort)
    if (!familyLabel.has(variant.baseId)) familyLabel.set(variant.baseId, variant.baseLabel)
  }

  const out: ModelOption[] = []
  const emittedIds = new Set<string>()

  for (const { model, variant } of parsed) {
    if (model.id === DEFAULT_MODEL) continue
    if (variant && (familyCounts.get(variant.baseId) ?? 0) >= 2) {
      if (emittedIds.has(variant.baseId)) continue
      emittedIds.add(variant.baseId)
      const set = familyEfforts.get(variant.baseId)!
      const efforts = EFFORTS.filter((e) => set.has(e))
      out.push({
        id: variant.baseId,
        label: familyLabel.get(variant.baseId) ?? variant.baseId,
        efforts,
        isDefault: false,
      })
    } else {
      if (emittedIds.has(model.id)) continue
      emittedIds.add(model.id)
      out.push({
        id: model.id,
        label: model.description || model.id,
        efforts: [],
        isDefault: false,
      })
    }
  }
  return out
}

/** The `--mode` names 1.5.13's `--help` lists, used as the fallback when `--help` has not been read. */
const KNOWN_HELP_MODES: readonly string[] = ['accept-edits', 'auto', 'plan']

/**
 * The permission modes to offer from the names `agy --help` lists: `default` first, then each recognised contract mode
 * in the contract's order (`accept-edits`, `plan`, `auto`), any unknown mode name `--help` lists, and `yolo` (which is
 * backed by `--dangerously-skip-permissions` and gated by core on `allowDangerousModes`).
 */
export function modesOffered(names: readonly string[] | null, includeYolo = true): PermissionModeOption[] {
  const listed = names && names.length ? names : KNOWN_HELP_MODES
  const out: PermissionModeOption[] = []
  for (const m of PERMISSION_MODES) {
    if (m.id === 'default') {
      out.push({ id: m.id, label: m.label, dangerous: m.dangerous })
    } else if (m.id === 'yolo') {
      if (includeYolo || listed.includes('yolo')) out.push({ id: m.id, label: m.label, dangerous: m.dangerous })
    } else if (m.flag && listed.includes(m.flag)) {
      out.push({ id: m.id, label: m.label, dangerous: m.dangerous })
    }
  }
  const known = new Set<string>(PERMISSION_MODES.flatMap((m) => (m.flag ? [m.id, m.flag] : [m.id])))
  for (const n of listed) {
    if (!known.has(n)) out.push({ id: n, label: n, dangerous: DANGEROUS_MODE_RE.test(n) })
  }
  return out
}

function antigravityKeys(env: Readonly<Env>): string[] {
  return Object.keys(env).filter((k) => k.startsWith(STRIP_ENV_PREFIX))
}

export async function detect(env: Readonly<Env>, command: string | null): Promise<Detection> {
  const bin = findOnPath(COMMAND, env.PATH, command)
  if (!bin) {
    const notice = command
      ? `The Antigravity CLI command ${command} is not an executable file`
      : `Antigravity CLI is not installed: ${COMMAND} is not on the login shell PATH`
    return { installed: false, path: null, version: null, supported: false, loggedIn: null, notice }
  }
  const runEnv = editEnv(env, { remove: antigravityKeys(env), set: {} }).env
  const run = async (args: readonly string[]) => {
    try {
      const r = await runProcess(bin, [...args], { pool: 'other', env: runEnv, timeoutMs: L.agentDetectTimeoutMs })
      return {
        code: r.timedOut ? null : r.code,
        stdout: r.stdout?.toString('utf8') ?? '',
        stderr: r.stderr ?? '',
      }
    } catch {
      return { code: null, stdout: '', stderr: '' }
    }
  }

  const [v, help, list] = await Promise.all([run([FLAGS.version]), run([FLAGS.help]), run([SUBCOMMANDS.models])])
  const version = parseVersion(v.stdout)
  // Go's `flag` package prints `--help` to stderr with 0 bytes on stdout; fall back to stdout if a build uses stdout.
  const helpText = help.stderr.trim() ? help.stderr : help.stdout
  const modes = help.code === 0 ? parseHelpModes(helpText) : []
  const models = list.code === 0 ? parseModels(list.stdout) : []
  const supported = version === null || atLeast(version, MIN_VERSION)

  let notice: string | null = null
  if (version === null) notice = "Antigravity CLI's version could not be read"
  else if (!supported) notice = `Antigravity CLI ${version} is older than ${MIN_VERSION}; live status may not work.`
  else if (ownStatusLine(env)) notice = 'Antigravity CLI uses your own status line; Kea will estimate status from terminal activity.'

  return {
    installed: true,
    path: bin,
    version,
    supported,
    loggedIn: null,
    notice,
    listed: {
      models: models.length ? models : null,
      permissionModes: modes.length ? modes : null,
    },
  }
}

/**
 * The composer's options for Antigravity CLI: `Default (Antigravity's own)` with full effort levels first, then the
 * CLI's listed models grouped by family with per-family effort levels (and single-variant / non-effort models with
 * `efforts: []`), free-text custom models enabled, and the permission modes.
 */
export function options(d: Pick<Detection, 'listed'>): AgentOptions {
  const defaultEfforts = [...EFFORTS]
  const grouped = groupModels(d.listed?.models ?? [])
  return {
    models: [{ id: DEFAULT_MODEL, label: DEFAULT_MODEL_LABEL, efforts: defaultEfforts, isDefault: true }, ...grouped],
    allowCustomModel: true,
    permissionModes: modesOffered(d.listed?.permissionModes ?? null),
  }
}
