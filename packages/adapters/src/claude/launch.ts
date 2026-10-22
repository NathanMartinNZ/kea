// Claude Code launch and resume: the exact argv, the inline `--settings` hooks in exec form, the hook projection
// generated from contract.ts, and the environment edits. argv goes straight to execve: no shell, prompts of any
// content.

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
} from './contract.ts'

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

/**
 * The inline settings: one synchronous exec-form hook per event, `timeout` L.hookTimeoutS, merged by Claude with the
 * user's and the repo's own hooks; no `statusLine`, never `disableAllHooks`.
 */
export function injectedSettings(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome' | 'helperPath'>): string {
  const hook = { type: 'command', command: ctx.helperPath, args: hookArgs(ctx), timeout: L.hookTimeoutS }
  const hooks: Record<string, unknown> = {}
  for (const e of HOOK_EVENTS) hooks[e] = [{ hooks: [hook] }]
  const json = JSON.stringify({ [SETTINGS_HOOKS]: hooks })
  if (Buffer.byteLength(json) > L.settingsInlineMaxBytes) throw new Error('inline settings too large')
  return json
}

/**
 * The helper a command names (`AgentAdapter.helperPaths`): the `command` of every hook in an inline settings value,
 * wherever `--settings` stands in the argv. Read as the JSON it is, so a path the JSON escapes (a quote, a backslash)
 * is the path again.
 */
export function helperPaths(argv: readonly string[]): string[] {
  const found = new Set<string>()
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i] !== FLAGS.settings) continue
    try {
      const hooks = (JSON.parse(argv[i + 1] as string) as Record<string, unknown> | null)?.[SETTINGS_HOOKS]
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
  args.push(FLAGS.settings, injectedSettings(ctx), ...extra(cfg, ctx))
  if (cfg.prompt !== '') args.push(END_OF_OPTIONS, promptArg(cfg.prompt))
  const { env, unset } = launchEnv(ctx)
  return { file: ctx.binary ?? COMMAND, args, env, unset, cwd: ctx.cwd, agentSessionId: ctx.agentSessionId }
}

/**
 * The same conversation: `claude --resume <id> --settings '<…>' [--model …] [--effort …]`. The settings are
 * re-passed every time (not restored by Claude); the permission mode is restored by Claude, except bypass, re-passed
 * only when the session was created with it. Null without a conversation id.
 */
export function buildResume(session: SessionRecord, ctx: LaunchContext): SpawnSpec | null {
  if (!session.agentSessionId) return null
  const args = [FLAGS.resume, session.agentSessionId, FLAGS.settings, injectedSettings(ctx), ...knobArgs(session.launch)]
  if (session.launch.permissionMode === 'bypassPermissions') args.push(FLAGS.permissionMode, session.launch.permissionMode)
  args.push(...extra(session.launch, ctx))
  const { env, unset } = launchEnv(ctx)
  return { file: ctx.binary ?? COMMAND, args, env, unset, cwd: ctx.cwd, agentSessionId: session.agentSessionId }
}
