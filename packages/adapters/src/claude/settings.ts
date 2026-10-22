// Claude Code's settings extension (`agents.claude.*` beyond the shared AgentSettings): the renderer choice (it
// ships as `agent-default`) and the adapter's defaults for new sessions.

import { z } from 'zod'
import type { AgentSettingsExtension } from '@kea/protocol'
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE } from './contract.ts'

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
      help: 'Fullscreen: Claude’s own scrolling view and mouse (⌥-drag selects). Classic: Kea’s scrollback, find and last screens hold the transcript.',
      section: 'Agents',
      control: 'select',
      options: [
        { value: 'agent-default', label: 'Claude’s default' },
        { value: 'fullscreen', label: 'Fullscreen' },
        { value: 'classic', label: 'Classic' },
      ],
    },
  ],
}
