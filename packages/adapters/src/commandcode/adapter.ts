// The Command Code adapter, assembled from its parts: detect and options (detect.ts), launch and resume
// (launch.ts), the session mod (kea-mod.ts) and the mapping of its events (mapping.ts), the transcript (transcript.ts),
// its settings (settings.ts). Everything Command Code-specific it uses is in contract.ts.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { L } from '@kea/protocol'
import { commandName } from '../kit/env.ts'
import type { AgentAdapter, Env } from '../types.ts'
import { COMMAND, COMMANDS, CONFIG_DIR_NAME, INSTALL_COMMAND, LOGIN, MOD_FILE, TRANSCRIPTS_DIR } from './contract.ts'
import { detect, options } from './detect.ts'
import { buildLaunch, buildResume, helperPaths } from './launch.ts'
import { CommandCodeSignals } from './mapping.ts'
import { fileMention } from './mention.ts'
import { ADAPTER_ID, COMMANDCODE_SETTINGS } from './settings.ts'
import { reconcile } from './transcript.ts'

/** Command Code's config directory in `env`: `<HOME>/.commandcode` (no variable moves it). */
export function configDir(env: Readonly<Env>): string | null {
  return env.HOME && path.isAbsolute(env.HOME) ? path.join(env.HOME, CONFIG_DIR_NAME) : null
}

/** Where a build keeps the adapters' launch files, beside core's bundle (tools/build.ts copies them there). */
export const BUILD_FILES_DIR = 'agent-files'

let modText: string | null = null

/**
 * kea-mod.ts as text (what `--mod` loads is a copy core keeps under KEA_HOME): the build's copy beside the bundle (read
 * here, so it also comes out of a packaged app's asar), else the source file next to this one. Null when neither reads.
 */
export function modSource(): string | null {
  if (modText !== null) return modText
  const shipped = typeof __filename === 'string' ? path.join(path.dirname(__filename), BUILD_FILES_DIR, ADAPTER_ID, MOD_FILE) : null
  try {
    modText = fs.readFileSync(shipped && fs.existsSync(shipped) ? shipped : fileURLToPath(new URL(`./${MOD_FILE}`, import.meta.url)), 'utf8')
  } catch {
    return null
  }
  return modText
}

export const commandcode: AgentAdapter = {
  id: COMMANDCODE_SETTINGS.id,
  displayName: COMMANDCODE_SETTINGS.displayName,
  commands: COMMANDS,
  installCommand: INSTALL_COMMAND,
  loginCommand: [COMMAND, ...LOGIN].join(' '),
  settings: COMMANDCODE_SETTINGS,
  // its mod loads only once the folder's trust question is answered: until then no event comes (the trust window).
  // Its trust is its own, by folder, and `--trust` is per launch: what another launch or another agent proved
  // about the project says nothing about this one
  trustGated: 'launch',
  launchFiles() {
    const content = modSource()
    return content === null ? [] : [{ name: MOD_FILE, content }]
  },
  detectionTtlMs: L.ccModelListTtlMs,
  fileMention,
  detect,
  options,
  buildLaunch,
  buildResume,
  identify: (argv) => (COMMANDS as readonly string[]).includes(commandName(argv) ?? ''),
  helperPaths,
  signals: (agentSessionId) => new CommandCodeSignals(agentSessionId),
  ownsTranscript(file, env) {
    const dir = configDir(env)
    if (!dir || !path.isAbsolute(file)) return false
    const projects = path.join(dir, TRANSCRIPTS_DIR) + path.sep
    return path.resolve(file).startsWith(projects)
  },
  reconcile,
}
