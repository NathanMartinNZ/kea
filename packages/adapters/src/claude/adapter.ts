// The Claude Code adapter, assembled from its parts: detect and options (detect.ts), launch and resume (launch.ts), the
// hook and status-file mapping (mapping.ts), the transcript (transcript.ts), its settings (settings.ts). Everything
// Claude-specific it uses is in contract.ts.

import path from 'node:path'
import { commandName } from '../kit/env.ts'
import type { AgentAdapter, Env } from '../types.ts'
import { AUTH_LOGIN, COMMAND, CONFIG_DIR_NAME, ENV_CONFIG_DIR, INSTALL_COMMAND, STATUS_DIR, TRANSCRIPTS_DIR } from './contract.ts'
import { detect, options } from './detect.ts'
import { buildLaunch, buildResume, helperPaths } from './launch.ts'
import { ClaudeSignals } from './mapping.ts'
import { CLAUDE_SETTINGS } from './settings.ts'
import { fileMention } from './mention.ts'
import { reconcile, watchTranscript } from './transcript.ts'

/** The config directory the agent uses in `env`: CLAUDE_CONFIG_DIR, else `~/.claude`. */
export function configDir(env: Readonly<Env>): string | null {
  const dir = env[ENV_CONFIG_DIR]
  if (dir && path.isAbsolute(dir)) return dir
  return env.HOME && path.isAbsolute(env.HOME) ? path.join(env.HOME, CONFIG_DIR_NAME) : null
}

export const claude: AgentAdapter = {
  id: CLAUDE_SETTINGS.id,
  displayName: CLAUDE_SETTINGS.displayName,
  commands: [COMMAND],
  installCommand: INSTALL_COMMAND,
  loginCommand: [COMMAND, ...AUTH_LOGIN].join(' '),
  settings: CLAUDE_SETTINGS,
  // its fullscreen view scrolls, clicks and drags with the mouse and has nothing on the right button
  rightButtonMenu: true,
  // workspace trust is keyed to the main checkout's repo root, also for worktrees outside it
  trustGated: 'repo',
  detect,
  options,
  buildLaunch,
  buildResume,
  identify: (argv) => commandName(argv) === COMMAND,
  helperPaths,
  signals: (agentSessionId) => new ClaudeSignals(agentSessionId),
  statusFilePath(pid, env) {
    const dir = configDir(env)
    return dir && Number.isInteger(pid) && pid > 0 ? path.join(dir, STATUS_DIR, `${pid}.json`) : null
  },
  watchRoots(env) {
    const dir = configDir(env)
    return dir ? [dir] : []
  },
  ownsTranscript(file, env) {
    const dir = configDir(env)
    if (!dir || !path.isAbsolute(file)) return false
    const projects = path.join(dir, TRANSCRIPTS_DIR) + path.sep
    return path.resolve(file).startsWith(projects)
  },
  watchTranscript,
  reconcile,
  fileMention,
}
