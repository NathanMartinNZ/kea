// Claude Code detection and options: `claude` on the login-shell PATH (or the `agents.claude.command` override),
// `--version` against the contract's minimum, `auth status` for the logged-in indicator; the composer's knobs from the
// static lists, gated on the version. Never throws.

import { runProcess } from '@kea/kit'
import { L, type AgentOptions } from '@kea/protocol'
import { editEnv, findOnPath } from '../kit/env.ts'
import { atLeast } from '../kit/version.ts'
import type { Detection, Env } from '../types.ts'
import { AUTH_LOGGED_IN, AUTH_LOGIN, AUTH_STATUS, COMMAND, DEFAULT_MODEL, EFFORTS, ENV_REMOVED, FLAGS, GATES, MIN_VERSION, MODELS, NO_XHIGH_MODEL_RE, PERMISSION_MODES, VERSION_RE } from './contract.ts'

/** `claude --version`'s output → `2.1.296`, or null. */
export function parseVersion(out: string): string | null {
  return VERSION_RE.exec(out)?.[1] ?? null
}

/** `claude auth status`: exit 0 logged in, 1 not (its JSON's field when present wins); anything else unknown. */
export function parseAuth(code: number | null, out: string): boolean | null {
  try {
    const o: unknown = JSON.parse(out)
    if (o && typeof o === 'object' && typeof (o as Record<string, unknown>)[AUTH_LOGGED_IN] === 'boolean') return (o as Record<string, boolean>)[AUTH_LOGGED_IN]!
  } catch {
    // not JSON: the exit code decides
  }
  return code === 0 ? true : code === 1 ? false : null
}

export async function detect(env: Readonly<Env>, command: string | null): Promise<Detection> {
  const path = findOnPath(COMMAND, env.PATH, command)
  if (!path) {
    const notice = command ? `The Claude Code command ${command} is not an executable file` : 'Claude Code is not installed: claude is not on the login shell PATH'
    return { installed: false, path: null, version: null, supported: false, loggedIn: null, notice }
  }
  const runEnv = editEnv(env, { remove: ENV_REMOVED, set: {} }).env
  const run = async (args: readonly string[]) => {
    try {
      const r = await runProcess(path, [...args], { pool: 'other', env: runEnv, timeoutMs: L.agentDetectTimeoutMs })
      return { code: r.timedOut ? null : r.code, out: r.stdout?.toString('utf8') ?? '' }
    } catch (e) {
      return { code: null, out: '', error: (e as Error).message }
    }
  }
  const v = await run([FLAGS.version])
  const version = parseVersion(v.out)
  const auth = await run(AUTH_STATUS)
  const loggedIn = parseAuth(auth.code, auth.out)
  // an unknown newer version is assumed compatible; an unreadable one is not refused either
  const supported = version === null || atLeast(version, MIN_VERSION)
  let notice: string | null = null
  if (version === null) notice = 'Claude Code’s version could not be read'
  else if (!supported) notice = `Claude Code ${version} is older than ${MIN_VERSION}: status detection is limited. Update it with: claude update`
  // the state's one name (`signed out`: Settings' card) and the one command that ends it, which the card offers to copy
  else if (loggedIn === false) notice = `Claude Code is signed out: run ${[COMMAND, ...AUTH_LOGIN].join(' ')} in a terminal`
  return { installed: true, path, version, supported, loggedIn, notice }
}

/** The effort levels a model id offers: every level, minus `xhigh` for 4.6-era ids. */
export function effortsFor(model: string): string[] {
  return EFFORTS.filter((e) => e !== 'xhigh' || !NO_XHIGH_MODEL_RE.test(model))
}

/** The composer's knobs for this version: unknown versions get the current lists. */
export function options(d: Pick<Detection, 'version'>): AgentOptions {
  const manualName = d.version === null || atLeast(d.version, GATES.manualAlias)
  return {
    models: MODELS.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts ? effortsFor(m.id) : [], isDefault: m.id === DEFAULT_MODEL })),
    allowCustomModel: true,
    permissionModes: PERMISSION_MODES.map((m) => ({ id: m.id === 'manual' && !manualName ? m.aliases[0]! : m.id, label: m.label, dangerous: m.dangerous })),
  }
}

/** What `claude --help` lists (K-CL-2…4): every long flag, the `--permission-mode` choices and the `--effort` levels. */
export function parseHelp(text: string): { flags: Set<string>; permissionModes: string[]; efforts: string[] } {
  const flags = new Set<string>()
  for (const m of text.matchAll(/(?:^|[\s,])(--[a-z][a-z0-9-]*)/g)) flags.add(m[1]!)
  const flat = text.replace(/\s+/g, ' ')
  const modeText = /--permission-mode <\w+>[^(]*\(choices: ([^)]*)\)/.exec(flat)?.[1] ?? ''
  const permissionModes = [...modeText.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
  const effortText = /--effort <\w+>[^(]*\(([^)]*)\)/.exec(flat)?.[1] ?? ''
  const efforts = effortText
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z]+$/.test(s))
  return { flags, permissionModes, efforts }
}
