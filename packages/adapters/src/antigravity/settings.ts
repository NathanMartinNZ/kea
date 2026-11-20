// Antigravity CLI's settings extension (`agents.antigravity.*` beyond the shared AgentSettings): whether the usage
// meter is shown from the session status feed (`usageLimits`, on by default) and whether a launch in a worktree Kea
// created trusts that worktree for the session (`autoTrustWorktrees`, on by default, never in place).

import { z } from 'zod'
import type { AgentSettingsExtension } from '@kea/protocol'
import { USAGE_LIMITS_KEY, usageLimitsOn, usageLimitsSetting } from '../kit/usage.ts'
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE } from './contract.ts'

export { USAGE_LIMITS_KEY, usageLimitsOn }

/** The adapter id: the registry key, `agents.<id>`, `sessions.agent` and `kea-helper`'s adapter argument. */
export const ADAPTER_ID = 'antigravity'

/** The human-facing display name of the adapter. */
export const DISPLAY_NAME = 'Antigravity CLI'

/** `agents.antigravity.autoTrustWorktrees`. */
export const AUTO_TRUST_KEY = 'autoTrustWorktrees'

export const ANTIGRAVITY_SETTINGS: AgentSettingsExtension = {
  id: ADAPTER_ID,
  displayName: DISPLAY_NAME,
  defaults: { model: DEFAULT_MODEL, permissionMode: DEFAULT_PERMISSION_MODE },
  keys: [
    usageLimitsSetting(
      'Shows how much of Antigravity CLI’s quota limits your account has used, at the top right of the Agent pane, from the session status feed. Turning this off hides the usage meter without turning off live session status. Not used when your own Antigravity CLI settings define an active status line. Applies to sessions started or resumed after the change.',
    ),
    {
      key: AUTO_TRUST_KEY,
      schema: z.boolean(),
      default: true,
      label: 'Auto-trust Kea worktrees',
      help: 'In a worktree Kea makes for a session, starts Antigravity CLI with that worktree trusted for the session only (trustedWorkspaces in --settings, never saved to settings.json). It never applies to a session used in place: there Antigravity CLI asks about your project folder itself, as it does in your terminal. Off: Antigravity CLI asks in each new worktree.',
      section: 'Agents',
      control: 'toggle',
    },
  ],
}
