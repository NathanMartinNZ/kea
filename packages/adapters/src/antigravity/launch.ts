// Antigravity CLI launch and resume: argv in Go `--flag=value` single-token form straight to execve (no shell),
// session-only `--settings=<json>` carrying Kea's stacked status-line feed (`kea-helper feed antigravity`), scrollback
// resize guard (`clearScrollbackOnResize: false`), and worktree-only trust (`trustedWorkspaces: [cwd]`), plus
// `ANTIGRAVITY_*` environment stripping and `helperPaths` extraction.

import { L, type LaunchConfig } from '@kea/protocol'
import { commandName, editEnv } from '../kit/env.ts'
import type { Projection } from '../kit/projection.ts'
import { shellWord, shellWords } from '../kit/shell.ts'
import type { Env, LaunchContext, SessionRecord, SpawnSpec } from '../types.ts'
import { ownStatusLine } from './config.ts'
import {
  COMMAND,
  COMMANDS,
  CRITICAL_AGENT_STATES,
  DEFAULT_MODEL,
  EFFORTS,
  FEED_FIELDS,
  FEED_SUBCOMMAND,
  FLAGS,
  PERMISSION_MODES,
  PROJECTION_KEEP,
  PROJECTION_QUOTA_FIELDS,
  PROJECTION_SUMMARISE,
  SETTINGS_KEYS,
  STATUS_LINE_TYPE,
  STRIP_ENV_PREFIX,
  SUBAGENT_RUNNING,
} from './contract.ts'
import { ADAPTER_ID, AUTO_TRUST_KEY } from './settings.ts'

/** The `--project` projection for `kea-helper feed antigravity`, generated from `contract.ts`. */
export function antigravityProjection(): Projection {
  return {
    keep: PROJECTION_KEEP.map((k) => FEED_FIELDS[k]),
    count: [],
    countWhere: [{ path: FEED_FIELDS.subagents, field: FEED_FIELDS.subagentStatus, equals: SUBAGENT_RUNNING }],
    keepMap: [
      {
        path: FEED_FIELDS.quota,
        fields: PROJECTION_QUOTA_FIELDS.map((k) => FEED_FIELDS[k]),
        maxKeys: L.projectionMapKeysMax,
      },
    ],
    summarise: PROJECTION_SUMMARISE.map((k) => FEED_FIELDS[k]),
    critical: [
      { field: FEED_FIELDS.agentState, values: [...CRITICAL_AGENT_STATES] },
      { field: FEED_FIELDS.toolConfirmationPending, values: [true] },
    ],
  }
}

export const projection = antigravityProjection

/** `kea-helper`'s arguments for one Antigravity session's status-line feed. */
export function feedArgs(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome'>): string[] {
  return [FEED_SUBCOMMAND, ADAPTER_ID, '--session', ctx.keaSessionId, '--home', ctx.keaHome, '--project', JSON.stringify(antigravityProjection())]
}

/** The status line's shell command: `kea-helper` and its arguments, each word POSIX single-quoted. */
export function feedCommand(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome' | 'helperPath'>): string {
  return [ctx.helperPath, ...feedArgs(ctx)].map(shellWord).join(' ')
}

/**
 * Builds the session-only `--settings` JSON object and whether the session runs silently without a status-line feed.
 * Turning `agents.antigravity.usageLimits` off still injects `statusLine` because the feed is the tier-1 session
 * status source; only an active user `statusLine` in `~/.gemini/antigravity-cli/settings.json` suppresses injection.
 */
export function buildSessionSettings(
  ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome' | 'helperPath' | 'cwd' | 'ownWorktree' | 'env' | 'settings'>,
  env: Readonly<Env> = ctx.env,
): { json: string; silent: boolean } {
  const hasOwn = ownStatusLine(env)
  const s: Record<string, unknown> = {}
  if (!hasOwn) {
    s[SETTINGS_KEYS.statusLine] = {
      [SETTINGS_KEYS.statusLineType]: STATUS_LINE_TYPE,
      [SETTINGS_KEYS.statusLineCommand]: feedCommand(ctx),
      [SETTINGS_KEYS.statusLineStack]: true,
    }
  }
  s[SETTINGS_KEYS.clearScrollbackOnResize] = false
  if (ctx.ownWorktree && ctx.settings[AUTO_TRUST_KEY] !== false) {
    s[SETTINGS_KEYS.trustedWorkspaces] = [ctx.cwd]
  }
  let json = JSON.stringify(s)
  if (Buffer.byteLength(json) > L.settingsInlineMaxBytes) {
    delete s[SETTINGS_KEYS.trustedWorkspaces]
    json = JSON.stringify(s)
  }
  if (Buffer.byteLength(json) > L.settingsInlineMaxBytes) {
    delete s[SETTINGS_KEYS.statusLine]
    json = JSON.stringify({ [SETTINGS_KEYS.clearScrollbackOnResize]: false })
    return { json, silent: true }
  }
  return { json, silent: hasOwn }
}

const EFFORT_SUFFIX_RE = new RegExp(`^(.+)-(?:${EFFORTS.join('|')})$`)

/**
 * Strips a trailing `-(low|medium|high|xhigh|max)` suffix from a model id when `--effort` is also being passed,
 * because passing an effort-suffixed slug alongside `--effort` causes `agy` to fall back to its default model.
 */
export function stripEffortSuffix(model: string): string {
  return EFFORT_SUFFIX_RE.exec(model)?.[1] ?? model
}

/** The `--mode` value for a permission mode id, or null when the mode passes no `--mode` flag. */
export function modeArg(mode: string): string | null {
  const known = PERMISSION_MODES.find((m) => m.id === mode || m.flag === mode)
  if (known) return known.flag
  return /^[a-z][a-z0-9-]*$/.test(mode) ? mode : null
}

function antigravityKeys(env: Readonly<Env>): string[] {
  return Object.keys(env).filter((k) => k.startsWith(STRIP_ENV_PREFIX))
}

/**
 * Strips every `ANTIGRAVITY_*` variable and Electron/Node internal from `ctx.env`, overlays `ctx.settings.env`, and
 * lists every removed key in `unset`.
 */
export function buildEnv(ctx: Pick<LaunchContext, 'env' | 'settings'>): { env: Env; unset: string[] } {
  const { env, unset } = editEnv(ctx.env, { remove: antigravityKeys(ctx.env), set: { ...ctx.settings.env } })
  return { env, unset: [...new Set(unset)] }
}

function knobArgs(
  cfg: Pick<LaunchConfig, 'model' | 'effort' | 'permissionMode'>,
  ctx: Pick<LaunchContext, 'settings'>,
): string[] {
  const out: string[] = []
  if (cfg.model && cfg.model !== DEFAULT_MODEL) {
    const model = cfg.effort ? stripEffortSuffix(cfg.model) : cfg.model
    out.push(`${FLAGS.model}=${model}`)
  }
  if (cfg.effort) {
    out.push(`${FLAGS.effort}=${cfg.effort}`)
  }
  if (cfg.permissionMode === 'yolo') {
    if (ctx.settings.allowDangerousModes === true) {
      out.push(FLAGS.dangerouslySkipPermissions)
    }
  } else if (cfg.permissionMode) {
    const mode = modeArg(cfg.permissionMode)
    if (mode) out.push(`${FLAGS.mode}=${mode}`)
  }
  return out
}

function extraArgs(cfg: Pick<LaunchConfig, 'extraArgs'>, ctx: Pick<LaunchContext, 'settings'>): string[] {
  return [...ctx.settings.extraArgs, ...(cfg.extraArgs ?? [])]
}

/**
 * Builds the `SpawnSpec` for a new Antigravity CLI conversation. `agentSessionId` is always `null` (ignoring any
 * pre-assigned `ctx.agentSessionId`) because `agy` assigns its own `conversation_id` and reports it on the status-line
 * feed.
 */
export function buildLaunch(cfg: LaunchConfig, ctx: LaunchContext): SpawnSpec {
  const { env, unset } = buildEnv(ctx)
  const settings = buildSessionSettings(ctx, env)
  const args: string[] = [...knobArgs(cfg, ctx), `${FLAGS.settings}=${settings.json}`, ...extraArgs(cfg, ctx)]
  if (cfg.prompt !== '') {
    args.push(`${FLAGS.promptInteractive}=${cfg.prompt}`)
  }
  return {
    file: ctx.binary ?? COMMAND,
    args,
    env,
    unset,
    cwd: ctx.cwd,
    agentSessionId: null,
    ...(settings.silent ? { silent: true } : {}),
  }
}

/**
 * Builds the `SpawnSpec` to resume an existing Antigravity CLI conversation (`--conversation=<id>`), re-passing the
 * launch's model, effort, permission mode / `--dangerously-skip-permissions`, and session `--settings`. Returns `null`
 * when `session.agentSessionId` is null.
 */
export function buildResume(session: SessionRecord, ctx: LaunchContext): SpawnSpec | null {
  const target = session.agentSessionId
  if (!target) return null
  const { env, unset } = buildEnv(ctx)
  const settings = buildSessionSettings(ctx, env)
  const args: string[] = [
    `${FLAGS.conversation}=${target}`,
    ...knobArgs(session.launch, ctx),
    `${FLAGS.settings}=${settings.json}`,
    ...extraArgs(session.launch, ctx),
  ]
  return {
    file: ctx.binary ?? COMMAND,
    args,
    env,
    unset,
    cwd: ctx.cwd,
    agentSessionId: target,
    ...(settings.silent ? { silent: true } : {}),
  }
}

/** Whether `argv` was started as an Antigravity CLI command (`agy`). */
export function identify(argv: readonly string[]): boolean {
  const name = commandName(argv)
  return name !== null && (COMMANDS as readonly string[]).includes(name)
}

function feedHelperFromSettingsJson(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    const statusLine = value?.[SETTINGS_KEYS.statusLine]
    if (statusLine === null || typeof statusLine !== 'object' || Array.isArray(statusLine)) return null
    const command = (statusLine as Record<string, unknown>)[SETTINGS_KEYS.statusLineCommand]
    if (typeof command !== 'string') return null
    const words = shellWords(command)
    return words && words.length > 1 && words[1] === FEED_SUBCOMMAND && words[0] !== '' ? words[0]! : null
  } catch {
    return null
  }
}

/**
 * Extracts the `kea-helper` executable path from any `--settings=<json>` or `['--settings', '<json>']` argument in
 * `argv` (including behind a login-shell wrapper) when `statusLine.command` was built by Kea for `kea-helper feed`.
 * Never throws.
 */
export function helperPaths(argv: readonly string[]): string[] {
  const found = new Set<string>()
  const eqPrefix = `${FLAGS.settings}=`
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith(eqPrefix)) {
      const helper = feedHelperFromSettingsJson(token.slice(eqPrefix.length))
      if (helper) found.add(helper)
    } else if (token === FLAGS.settings && i + 1 < argv.length) {
      const helper = feedHelperFromSettingsJson(argv[i + 1]!)
      if (helper) found.add(helper)
    }
  }
  return [...found]
}
