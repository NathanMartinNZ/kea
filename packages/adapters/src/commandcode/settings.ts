// Command Code's settings extension (`agents.commandcode.*` beyond the shared AgentSettings): whether a launch in a
// worktree Kea made passes `--trust` (never for a session used in place) and the adapter's defaults for new
// sessions.

import { z } from 'zod'
import type { AgentSettingsExtension } from '@kea/protocol'
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE } from './contract.ts'

/** The adapter id: the registry key, `agents.<id>`, `sessions.agent` and kea-helper's first argument. */
export const ADAPTER_ID = 'commandcode'

/** `agents.commandcode.autoTrustWorktrees`. */
export const AUTO_TRUST_KEY = 'autoTrustWorktrees'

export const COMMANDCODE_SETTINGS: AgentSettingsExtension = {
  id: ADAPTER_ID,
  displayName: 'Command Code',
  defaults: { model: DEFAULT_MODEL, permissionMode: DEFAULT_PERMISSION_MODE },
  keys: [
    {
      key: AUTO_TRUST_KEY,
      schema: z.boolean(),
      default: true,
      label: 'Auto-trust Kea worktrees',
      help: 'In a worktree Kea makes for a session, starts Command Code with its trust question already answered (--trust). Command Code then also loads that repository’s own mods and hooks without asking: fine for your own repositories, not for one you do not trust. It never applies to a session used in place: there Command Code asks about your project folder itself, as it does in your terminal. Off: Command Code asks in each new worktree, and Kea sees no status until you answer.',
      section: 'Agents',
      control: 'toggle',
    },
  ],
}
