// Claude Code's settings extension (`agents.claude.*` beyond the shared AgentSettings): the renderer choice (it
// ships as `agent-default`), the usage meter (on by default; its status line costs Claude's "esc to interrupt" hint)
// and the adapter's defaults for new sessions.

import { z } from 'zod'
import type { AgentSettingsExtension } from '@kea/protocol'
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE } from './contract.ts'
import { USAGE_LIMITS_KEY } from './statusline.ts'

export const RENDERERS = ['agent-default', 'fullscreen', 'classic'] as const

export const CLAUDE_SETTINGS: AgentSettingsExtension = {
  id: 'claude',
  displayName: 'Claude Code',
  defaults: { model: DEFAULT_MODEL, permissionMode: DEFAULT_PERMISSION_MODE },
  keys: [
    {
      key: 'renderer',
      schema: z.enum(RENDERERS),
      default: 'agent-default',
      label: 'Claude renderer',
      help: 'Fullscreen: Claude’s own scrolling view and mouse (Shift-drag selects, ⌥-drag on macOS). Classic: Kea’s scrollback, find and last screens hold the transcript.',
      section: 'Agents',
      control: 'select',
      options: [
        { value: 'agent-default', label: 'Claude’s default' },
        { value: 'fullscreen', label: 'Fullscreen' },
        { value: 'classic', label: 'Classic' },
      ],
    },
    {
      key: USAGE_LIMITS_KEY,
      schema: z.boolean(),
      default: true,
      label: 'Show usage limits',
      help: 'Shows how much of Claude’s 5-hour and weekly limits your account has used, at the top right of the Agent pane. Kea gives each Claude session a status line that reads them, so Claude then hides its “esc to interrupt” hint (Esc still interrupts). Not used when your own Claude settings define a status line. Applies to sessions started or resumed after the change.',
      section: 'Agents',
      control: 'toggle',
    },
  ],
}
