// The palette's command: `view.palette` (`⌘⇧P`) opens the palette over everything; with `{ mode: 'files' }`
// (`files.goToFile`, `⌘P`) it opens in file mode. Asked for while open, the palette takes the keyboard back and
// shows what was asked for. Title, binding and menu placement come from the command table.

import type { Disposable } from '@kea/terminal'
import { commands } from '../commands/registry.ts'
import { openPalette } from './state.svelte.ts'

function fileMode(args: unknown): boolean {
  return typeof args === 'object' && args !== null && (args as { mode?: unknown }).mode === 'files'
}

export function registerPaletteCommands(): Disposable {
  return commands.register('view.palette', { run: (a) => openPalette(fileMode(a) ? 'files' : 'all') })
}
