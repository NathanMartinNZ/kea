// Where Claude keeps its config for an environment: the status files, the transcripts, the user's settings and the
// account a usage reading belongs to all hang off it.

import path from 'node:path'
import type { Env } from '../types.ts'
import { CONFIG_DIR_NAME, ENV_CONFIG_DIR } from './contract.ts'

/** The config directory the agent uses in `env`: CLAUDE_CONFIG_DIR, else `~/.claude`. */
export function configDir(env: Readonly<Env>): string | null {
  const dir = env[ENV_CONFIG_DIR]
  if (dir && path.isAbsolute(dir)) return dir
  return env.HOME && path.isAbsolute(env.HOME) ? path.join(env.HOME, CONFIG_DIR_NAME) : null
}
