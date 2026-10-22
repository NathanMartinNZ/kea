// Command Code launch and resume: the exact argv, the session mod with its one option (the hook helper's command line
// and the numbers the mod runs on, generated from contract.ts and constants/), and the environment edits. argv goes
// straight to execve: no shell, prompts of any content.
//
//   cmd [--model m] [--effort e] [--permission-mode p] --mod <kea-mod.ts> --mod-option kea=<…> [--trust] [...extraArgs] [-- "<prompt>"]
//
// Without the mod (its file could not be written, or a CLI older than the version the mod was verified on) the
// conversation is named instead, `--name kea-<id>`, and that name is what a later `--resume` takes; status is then
// tier 3 only. The id is the launch's own (a new one per conversation): two conversations of one name would make
// `--resume <name>` pick the older.

import path from 'node:path'
import { L, type LaunchConfig } from '@kea/protocol'
import { editEnv } from '../kit/env.ts'
import { atLeast } from '../kit/version.ts'
import type { LaunchContext, SessionRecord, SpawnSpec } from '../types.ts'
import { COMMAND, CRITICAL_EVENTS, DEFAULT_MODEL, END_OF_OPTIONS, ENV_REMOVED, FIELDS, FLAGS, GATES, MOD_FILE, MOD_OPTION, PERMISSION_MODES, PROJECTION_KEEP, PROJECTION_SUMMARISE } from './contract.ts'
import { decodeOptions, type KeaModOptions } from './kea-mod.ts'
import { ADAPTER_ID, AUTO_TRUST_KEY } from './settings.ts'

/** The `--project` projection, generated from the contract: what the helper keeps of a mod event. */
export function projection(): { keep: string[]; count: string[]; summarise: string[]; critical: { field: string; values: string[] } } {
  return {
    keep: PROJECTION_KEEP.map((k) => FIELDS[k]),
    count: [],
    summarise: PROJECTION_SUMMARISE.map((k) => FIELDS[k]),
    critical: { field: FIELDS.event, values: [...CRITICAL_EVENTS] },
  }
}

/** kea-helper's arguments for one session: identification is in the arguments, never in env vars. */
export function hookArgs(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome'>): string[] {
  return ['hook', ADAPTER_ID, '--session', ctx.keaSessionId, '--home', ctx.keaHome, '--project', JSON.stringify(projection())]
}

/** What the mod is told (kea-mod.ts `KeaModOptions`): the helper's command line, the paths it sends, its numbers. */
export function modOptions(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome' | 'helperPath'>): KeaModOptions {
  const p = projection()
  return {
    helper: ctx.helperPath,
    args: hookArgs(ctx),
    paths: [...p.keep, ...p.summarise],
    maxChars: L.hookSummaryMaxChars,
    waitMs: L.ccPermissionQueuedMs,
    timeoutMs: L.hookTimeoutS * 1000,
    maxTools: L.ccModToolsMax,
  }
}

/** `kea=<base64url JSON>`: one argv element whatever the paths hold (spaces, `=`, quotes). */
export function modOptionArg(ctx: Pick<LaunchContext, 'keaSessionId' | 'keaHome' | 'helperPath'>): string {
  return `${MOD_OPTION}=${Buffer.from(JSON.stringify(modOptions(ctx))).toString('base64url')}`
}

/**
 * The helper a command names (`AgentAdapter.helperPaths`): the `helper` of the mod's option, wherever `--mod-option`
 * stands in the argv. The option is one encoded element, so the path is in no argument as plain text.
 */
export function helperPaths(argv: readonly string[]): string[] {
  const found = new Set<string>()
  const prefix = `${MOD_OPTION}=`
  for (let i = 0; i + 1 < argv.length; i++) {
    const v = argv[i + 1] as string
    if (argv[i] !== FLAGS.modOption || !v.startsWith(prefix)) continue
    const helper = decodeOptions(v.slice(prefix.length))?.helper
    if (helper) found.add(helper)
  }
  return [...found]
}

/** The mod file of this launch, or null: no folder for it, or a CLI below the version its mods were verified on. */
export function modFile(ctx: Pick<LaunchContext, 'filesDir' | 'version'>): string | null {
  if (!ctx.filesDir) return null
  if (ctx.version !== null && !atLeast(ctx.version, GATES.mods)) return null
  return path.join(ctx.filesDir, MOD_FILE)
}

/** The name a conversation started without the mod is given, and resumed by: `kea-<the launch's id>`. */
export function sessionName(id: string): string {
  return `${SESSION_NAME_PREFIX}${id}`
}
const SESSION_NAME_PREFIX = 'kea-'
/** Is this title a name Kea gave (never shown as the session's title)? */
export function isSessionName(title: string): boolean {
  return title.startsWith(SESSION_NAME_PREFIX) && /^[0-9A-Za-z-]{8,64}$/.test(title.slice(SESSION_NAME_PREFIX.length))
}

/** The prompt as argv: one element after `--`; one space appended when it has no whitespace, so it is never read as a subcommand. */
export function promptArg(prompt: string): string {
  return /\s/.test(prompt) ? prompt : `${prompt} `
}

/** The mode as `--permission-mode` takes it (`default` is spelled `standard`); null for a mode the contract does not know and the help did not list. */
export function modeArg(mode: string): string | null {
  const known = PERMISSION_MODES.find((m) => m.id === mode || (m.names as readonly string[]).includes(mode))
  if (known) return known.flag
  return /^[a-z][a-z0-9-]*$/.test(mode) ? mode : null
}

/** The mode an event reports, as the adapter's id (`auto-accept` → `accept-edits`, `bypass` → `yolo`). */
export function modeFromEvent(reported: string): string {
  return PERMISSION_MODES.find((m) => m.reported === reported || (m.names as readonly string[]).includes(reported))?.id ?? reported
}

function launchEnv(ctx: LaunchContext): { env: Record<string, string>; unset: string[] } {
  return editEnv(ctx.env, { remove: ENV_REMOVED, set: { ...ctx.settings.env } })
}

function knobArgs(cfg: Pick<LaunchConfig, 'model' | 'effort' | 'permissionMode'>): string[] {
  const out: string[] = []
  if (cfg.model && cfg.model !== DEFAULT_MODEL) out.push(FLAGS.model, cfg.model)
  if (cfg.effort) out.push(FLAGS.effort, cfg.effort)
  const mode = cfg.permissionMode ? modeArg(cfg.permissionMode) : null
  if (mode) out.push(FLAGS.permissionMode, mode)
  return out
}

/** The mod and its option. */
function modArgs(ctx: LaunchContext): string[] {
  const mod = modFile(ctx)
  return mod ? [FLAGS.mod, mod, FLAGS.modOption, modOptionArg(ctx)] : []
}

/**
 * `--trust` (the setting "Auto-trust Kea worktrees"), then the extra arguments. `--trust` answers Command Code's trust
 * question for the folder and so lets it load that folder's own mods and hooks: only ever for a worktree Kea made for
 * the session. A session used in place runs in the project's own folder, which is the person's to trust: Command Code
 * asks there, as it would in their terminal.
 */
function tail(cfg: Pick<LaunchConfig, 'extraArgs'>, ctx: LaunchContext): string[] {
  const trust = ctx.ownWorktree && ctx.settings[AUTO_TRUST_KEY] !== false
  return [...(trust ? [FLAGS.trust] : []), ...ctx.settings.extraArgs, ...(cfg.extraArgs ?? [])]
}

/**
 * A new conversation. With the mod its id is not known yet: the mod's first event carries it. Without, the name
 * it is given stands in for the id (`--resume` takes either).
 */
export function buildLaunch(cfg: LaunchConfig, ctx: LaunchContext): SpawnSpec {
  const name = modFile(ctx) ? null : sessionName(ctx.agentSessionId ?? ctx.keaSessionId)
  const args = [...knobArgs(cfg), ...(name ? [FLAGS.name, name] : modArgs(ctx)), ...tail(cfg, ctx)]
  if (cfg.prompt !== '') args.push(END_OF_OPTIONS, promptArg(cfg.prompt))
  const { env, unset } = launchEnv(ctx)
  return { file: ctx.binary ?? COMMAND, args, env, unset, cwd: ctx.cwd, agentSessionId: name, ...silentWithoutMod(ctx) }
}

/** Without the mod nothing of the launch reaches Kea (tier 3 only): said to core, which then starts no trust window. */
function silentWithoutMod(ctx: LaunchContext): { silent?: true } {
  return modFile(ctx) ? {} : { silent: true }
}

/**
 * The same conversation: `cmd --resume <id or name> [--model …] [--effort …] [--permission-mode …] --mod …
 * --mod-option … [--trust]`. Everything is passed again every time: a resumed session keeps neither the mod nor the
 * model it was started with (1.79.2 resumes on its own default model). Null without a conversation id (or the name
 * that stands in for one): a fresh conversation.
 */
export function buildResume(session: SessionRecord, ctx: LaunchContext): SpawnSpec | null {
  const target = session.agentSessionId
  if (!target) return null
  const args = [FLAGS.resume, target, ...knobArgs(session.launch), ...modArgs(ctx), ...tail(session.launch, ctx)]
  const { env, unset } = launchEnv(ctx)
  return { file: ctx.binary ?? COMMAND, args, env, unset, cwd: ctx.cwd, agentSessionId: target, ...silentWithoutMod(ctx) }
}
