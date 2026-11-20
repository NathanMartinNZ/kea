// The Antigravity CLI adapter, assembled from its parts: detect and options (detect.ts), launch and resume (launch.ts),
// status-line feed mapping and quota usage (mapping.ts), transcript ownership, watch and reconcile (transcript.ts),
// and settings (settings.ts). Everything Antigravity-specific it uses is declared in contract.ts.

import { L } from '@kea/protocol'
import type { AgentAdapter } from '../types.ts'
import { configDir } from './config.ts'
import { COMMANDS, INSTALL_COMMAND } from './contract.ts'
import { detect, options } from './detect.ts'
import { buildLaunch, buildResume, helperPaths, identify } from './launch.ts'
import { createSignals, usageEvents } from './mapping.ts'
import { ADAPTER_ID, ANTIGRAVITY_SETTINGS, DISPLAY_NAME, usageLimitsOn } from './settings.ts'
import { ownsTranscript, reconcile, watchRoots, watchTranscript } from './transcript.ts'

export { configDir }

export const antigravityAdapter: AgentAdapter = {
  id: ADAPTER_ID,
  displayName: DISPLAY_NAME,
  commands: COMMANDS,
  installCommand: INSTALL_COMMAND,
  loginCommand: null,
  settings: ANTIGRAVITY_SETTINGS,
  // Antigravity CLI enables mouse tracking for selection/scrolling and has no action bound to the right mouse button.
  rightButtonMenu: true,
  // The status-line feed fires before the workspace trust dialog is answered, so events are never held behind a trust window.
  trustGated: false,
  detectionTtlMs: L.agModelsTtlMs,
  detect,
  options,
  buildLaunch,
  buildResume,
  identify,
  helperPaths,
  signals: createSignals,
  watchRoots,
  ownsTranscript,
  watchTranscript,
  reconcile,
  usage: {
    enabled: usageLimitsOn,
    account: (env) => configDir(env) ?? '',
    map: usageEvents,
    fromHooks: true,
  },
}

export const antigravity: AgentAdapter = antigravityAdapter
