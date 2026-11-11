// Claude Code launch and resume: the exact argv, the inline `--settings` hooks in exec form (and, with the usage meter
// on, the status line: statusline.ts), the hook projection generated from contract.ts, and the environment edits. argv
// goes straight to execve: no shell, prompts of any content.

import { L, type LaunchConfig } from '@kea/protocol'
import { editEnv } from '../kit/env.ts'
import { atLeast } from '../kit/version.ts'
import type { LaunchContext, SessionRecord, SpawnSpec } from '../types.ts'
import {
  COMMAND,
  CRITICAL_EVENTS,
  DEFAULT_MODEL,
  END_OF_OPTIONS,
  ENV_NO_FLICKER,
  ENV_REMOVED,
  FIELDS,
  FLAGS,
  GATES,
  HOOK_EVENTS,
  PERMISSION_MODES,
  PROJECTION_COUNT,
  PROJECTION_KEEP,
  PROJECTION_SUMMARISE,
  REPORTED_DEFAULT_MODE,
  SETTINGS_HOOKS,
  SETTINGS_STATUS_LINE,
  STATUS_LINE_COMMAND,
  STATUS_LINE_TYPE,
} from './contract.ts'
import { ownStatusLine, shellWord, shellWords, statusLineProjection, usageLimitsOn } from './statusline.ts'

/** The adapter id kea-helper is called with (its first argument). */
export const ADAPTER_ID = 'claude'

/** The `--project` projection, generated from the contract: what the helper keeps of a payload. */
export function projection(): { keep: string[]; count: string[]; summarise: string[]; critical: { field: string; values: string[] } } {
  return {
    keep: PROJECTION_KEEP.map((k) => FIELDS[k]),
    count: PROJECTION_COUNT.map((k) => FIELDS[k]),
    summarise: PROJECTION_SUMMARISE.map((k) => FIELDS[k]),
    critical: { field: FIELDS.event, values: [...CRITICAL_EVENTS] },
  }
}

/** kea-helper's arguments for one session: identification is in the arguments, never in env vars. */
export function hookArgs(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome'>): string[] {
  return ['hook', ADAPTER_ID, '--session', ctx.keaSessionId, '--home', ctx.keaHome, '--project', JSON.stringify(projection())]
}

/** kea-helper's subcommand the status line runs. */
export const STATUSLINE_SUBCOMMAND = 'statusline'

/** kea-helper's arguments for the session's status line: like a hook's, with the status line's own projection. */
export function statusLineArgs(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome'>): string[] {
  return [STATUSLINE_SUBCOMMAND, ADAPTER_ID, '--session', ctx.keaSessionId, '--home', ctx.keaHome, '--project', JSON.stringify(statusLineProjection())]
}

/** The status line's command: the helper and its arguments, each word single-quoted (Claude runs it in a shell). */
export function statusLineCommand(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome' | 'helperPath'>): string {
  return [ctx.helperPath, ...statusLineArgs(ctx)].map(shellWord).join(' ')
}

/**
 * The status line this launch carries: with the usage meter on, and only when the user's own settings define none
 * (Kea's would replace theirs). `env` is the agent's environment (its config folder); null for none.
 */
export function usageStatusLine(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome' | 'helperPath' | 'settings' | 'cwd'>, env: Readonly<Record<string, string>>): string | null {
  if (!usageLimitsOn(ctx.settings) || ownStatusLine(env, ctx.cwd)) return null
  return statusLineCommand(ctx)
}

/**
 * The inline settings: one synchronous exec-form hook per event, `timeout` L.hookTimeoutS, merged by Claude with the
 * user's and the repo's own hooks; a `statusLine` only when given one (`usageStatusLine`); never `disableAllHooks`.
 */
export function injectedSettings(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome' | 'helperPath'>, statusLine: string | null = null): string {
  const hook = { type: 'command', command: ctx.helperPath, args: hookArgs(ctx), timeout: L.hookTimeoutS }
  const hooks: Record<string, unknown> = {}
  for (const e of HOOK_EVENTS) hooks[e] = [{ hooks: [hook] }]
  const value: Record<string, unknown> = { [SETTINGS_HOOKS]: hooks }
  if (statusLine !== null) value[SETTINGS_STATUS_LINE] = { type: STATUS_LINE_TYPE, [STATUS_LINE_COMMAND]: statusLine }
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > L.settingsInlineMaxBytes) throw new Error('inline settings too large')
  return json
}

/** The helper a status line's command runs, when Kea built that command (`statusLineCommand`); else null. */
function statusLineHelper(statusLine: unknown): string | null {
  const command = statusLine !== null && typeof statusLine === 'object' ? (statusLine as Record<string, unknown>)[STATUS_LINE_COMMAND] : undefined
  if (typeof command !== 'string') return null
  const words = shellWords(command)
  return words && words.length > 1 && words[1] === STATUSLINE_SUBCOMMAND && words[0] !== '' ? words[0]! : null
}

/**
 * The helper a command names (`AgentAdapter.helperPaths`): the `command` of every hook in an inline settings value,
 * and the helper its status line runs, wherever `--settings` stands in the argv. Read as the JSON it is, so a path the
 * JSON escapes (a quote, a backslash) is the path again.
 */
export function helperPaths(argv: readonly string[]): string[] {
  const found = new Set<string>()
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i] !== FLAGS.settings) continue
    try {
      const value = JSON.parse(argv[i + 1] as string) as Record<string, unknown> | null
      const line = statusLineHelper(value?.[SETTINGS_STATUS_LINE])
      if (line) found.add(line)
      const hooks = value?.[SETTINGS_HOOKS]
      if (hooks === null || typeof hooks !== 'object') continue
      for (const groups of Object.values(hooks)) {
        for (const g of Array.isArray(groups) ? groups : []) {
          for (const h of Array.isArray((g as { hooks?: unknown } | null)?.hooks) ? (g as { hooks: unknown[] }).hooks : []) {
            const command = (h as { command?: unknown } | null)?.command
            if (typeof command === 'string' && command !== '') found.add(command)
          }
        }
      }
    } catch {
      // not an inline settings value (a file path, the prompt's own words): it names nothing
    }
  }
  return [...found]
}

/** The prompt as argv: one element after `--`; one space appended when it has no whitespace (subcommand screening). */
export function promptArg(prompt: string): string {
  return /\s/.test(prompt) ? prompt : `${prompt} `
}

/**
 * The mode as the CLI of `version` names it: `manual` is an alias of `default` from 2.1.200 (K-CL-3 accepts either name
 * of the group). Payloads report `default` either way.
 */
export function modeArg(mode: string, version: string | null): string {
  if (mode === 'manual' && version !== null && !atLeast(version, GATES.manualAlias)) return REPORTED_DEFAULT_MODE
  return mode
}

/** The mode a payload reports, as the adapter's id (`default` → `manual`). */
export function modeFromPayload(reported: string): string {
  return reported === REPORTED_DEFAULT_MODE ? 'manual' : reported
}

/** `agents.claude.renderer`: `fullscreen` → `1`, `classic` → `0`, `agent-default` → left alone. */
function rendererEnv(renderer: unknown): Record<string, string> {
  if (renderer === 'fullscreen') return { [ENV_NO_FLICKER]: '1' }
  if (renderer === 'classic') return { [ENV_NO_FLICKER]: '0' }
  return {}
}

/**
 * The environment: the PTY environment, the agent's extra variables and the renderer's; Claude's markers and internals
 * removed.
 */
function launchEnv(ctx: LaunchContext): { env: Record<string, string>; unset: string[] } {
  return editEnv(ctx.env, { remove: ENV_REMOVED, set: { ...ctx.settings.env, ...rendererEnv(ctx.settings.renderer) } })
}

function knobArgs(cfg: Pick<LaunchConfig, 'model' | 'effort'>): string[] {
  const out: string[] = []
  if (cfg.model && cfg.model !== DEFAULT_MODEL) out.push(FLAGS.model, cfg.model)
  if (cfg.effort) out.push(FLAGS.effort, cfg.effort)
  return out
}

function extra(cfg: Pick<LaunchConfig, 'extraArgs'>, ctx: LaunchContext): string[] {
  return [...ctx.settings.extraArgs, ...(cfg.extraArgs ?? [])]
}

const KNOWN_MODES = new Set<string>(PERMISSION_MODES.flatMap((m) => [m.id, ...m.aliases]))

/**
 * A new conversation:
 *   claude --session-id <uuid> [--model m] [--effort e] [--permission-mode p] --settings '<json>' [...extraArgs] [-- "<prompt>"]
 */
export function buildLaunch(cfg: LaunchConfig, ctx: LaunchContext): SpawnSpec {
  if (!ctx.agentSessionId) throw new Error('a Claude launch needs a pre-assigned session id')
  const args = [FLAGS.sessionId, ctx.agentSessionId, ...knobArgs(cfg)]
  if (cfg.permissionMode && KNOWN_MODES.has(cfg.permissionMode)) args.push(FLAGS.permissionMode, modeArg(cfg.permissionMode, ctx.version))
  const { env, unset } = launchEnv(ctx)
  args.push(FLAGS.settings, injectedSettings(ctx, usageStatusLine(ctx, env)), ...extra(cfg, ctx))
  if (cfg.prompt !== '') args.push(END_OF_OPTIONS, promptArg(cfg.prompt))
  return { file: ctx.binary ?? COMMAND, args, env, unset, cwd: ctx.cwd, agentSessionId: ctx.agentSessionId }
}

/**
 * The same conversation: `claude --resume <id> --settings '<…>' [--model …] [--effort …]`. The settings are
 * re-passed every time (not restored by Claude); the permission mode is restored by Claude, except bypass, re-passed
 * only when the session was created with it. Null without a conversation id.
 */
export function buildResume(session: SessionRecord, ctx: LaunchContext): SpawnSpec | null {
  if (!session.agentSessionId) return null
  const { env, unset } = launchEnv(ctx)
  const args = [FLAGS.resume, session.agentSessionId, FLAGS.settings, injectedSettings(ctx, usageStatusLine(ctx, env)), ...knobArgs(session.launch)]
  if (session.launch.permissionMode === 'bypassPermissions') args.push(FLAGS.permissionMode, session.launch.permissionMode)
  args.push(...extra(session.launch, ctx))
  return { file: ctx.binary ?? COMMAND, args, env, unset, cwd: ctx.cwd, agentSessionId: session.agentSessionId }
}
