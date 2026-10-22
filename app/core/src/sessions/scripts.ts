// Setup and teardown commands: where a session's command comes from, and the argv it runs as. Source, in priority
// order: the project setting ("Setup command" / "Teardown command"), then an executable `.kea/setup.sh` /
// `.kea/teardown.sh` in the worktree (or, for a script not committed, the main checkout), then none.
//
// A command from the settings is a shell command line the user wrote, so it runs as `$SHELL -l -c <command>`: the
// user's own text is the script, passed as one argv element, and nothing of Kea's is ever spliced into it. A script
// file runs directly, by its path.

import fs from 'node:fs'
import path from 'node:path'
import type { ProjectSettings } from '@kea/protocol'
import type { Env } from '../terminal/shellEnv.ts'
import { userShell } from '../terminal/spawn.ts'

export type ScriptKind = 'setup' | 'teardown'

const FILES: Record<ScriptKind, string> = { setup: '.kea/setup.sh', teardown: '.kea/teardown.sh' }

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The command a session's setup or teardown runs, or null when there is none. */
export function scriptCommand(kind: ScriptKind, settings: ProjectSettings, dirs: readonly string[], env: Env): { argv: string[]; label: string } | null {
  const configured = (kind === 'setup' ? settings.setupCommand : settings.teardownCommand)?.trim()
  if (configured) return { argv: [userShell(env), '-l', '-c', configured], label: configured }
  for (const d of dirs) {
    const f = path.join(d, FILES[kind])
    if (executable(f)) return { argv: [f], label: FILES[kind] }
  }
  return null
}

/**
 * Whether the project has a setup or teardown command (`kind`). With a teardown command, the delete dialog says it will
 * run and setup runs again on unarchive.
 */
export function hasScript(kind: ScriptKind, settings: ProjectSettings, dirs: readonly string[]): boolean {
  return scriptCommand(kind, settings, dirs, {}) !== null
}
