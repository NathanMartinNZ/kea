// Project Settings as data: the fields `ProjectSettingsForm.svelte` shows and the change each new value makes.

import { SERVICES_MODES, type ProjectSettings } from '@kea/protocol'

export type Field =
  | { key: keyof ProjectSettings; label: string; help?: string; kind: 'text'; placeholder?: string }
  | { key: keyof ProjectSettings; label: string; help?: string; kind: 'toggle' }
  | { key: keyof ProjectSettings; label: string; help?: string; kind: 'list'; placeholder?: string }
  | { key: keyof ProjectSettings; label: string; help?: string; kind: 'select'; options: readonly { value: string; label: string }[] }

/** The settings' fields, in order (lastLaunch and serverPorts are Kea's own memory, shown below, not edited). */
export const PROJECT_FIELDS: readonly Field[] = [
  { key: 'baseBranch', label: 'Base branch', help: 'Overrides the detected default branch for new worktrees.', kind: 'text' },
  { key: 'branchPrefix', label: 'Branch prefix', help: 'Overrides the global branch prefix for this project.', kind: 'text' },
  { key: 'setupCommand', label: 'Setup command', help: 'Runs in each new worktree; else .kea/setup.sh when present.', kind: 'text' },
  { key: 'teardownCommand', label: 'Teardown command', help: 'Runs before a worktree is removed; else .kea/teardown.sh when present.', kind: 'text' },
  { key: 'startAgentWithoutWaitingForSetup', label: 'Start the agent without waiting for setup', kind: 'toggle' },
  { key: 'services', label: 'Services', help: 'Whether sessions share the project’s services or each gets its own.', kind: 'select', options: SERVICES_MODES.map((m) => ({ value: m, label: m === 'shared' ? 'Shared' : 'Per session' })) },
  { key: 'filesToCopy', label: 'Files to copy', help: 'Untracked files copied into new worktrees, one pattern per line. A .worktreeinclude file replaces this list.', kind: 'list' },
  { key: 'rebuildableDirs', label: 'Rebuildable folders', help: 'Build folders that can be removed and rebuilt, one pattern per line.', kind: 'list' },
  { key: 'runCommand', label: 'Run command', help: 'The dev server; else ./start.sh.', kind: 'text' },
  { key: 'autoStartServer', label: 'Start the dev server with each session', kind: 'toggle' },
  // Never forced; a slow status suggests it once (the file panel's hint)
  { key: 'useFsmonitor', label: 'Use git fsmonitor for this repo', help: 'Speeds up git status in a large repository: sets core.fsmonitor and core.untrackedCache in each worktree’s own config. Not used on a network volume.', kind: 'toggle' },
]

/** The settings change a field's new value makes: set it, or unset it when emptied. */
export function fieldChange(key: keyof ProjectSettings, value: unknown): { set?: ProjectSettings; unset?: (keyof ProjectSettings)[] } {
  const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  return empty ? { unset: [key] } : { set: { [key]: value } as ProjectSettings }
}

/** A list field's text (one pattern per line) as its value. */
export function listValue(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}
