// The diagnostics feature's command: `app.copyDiagnostics` (menu bar, palette, Settings › Advanced). Its title and
// placement come from the command table. `{ paths: true }` includes file paths whatever the tick box says; with no
// argument the tick box of Settings › Advanced decides (off until ticked).

import type { Disposable } from '@kea/terminal'
import { commands } from '../commands/registry.ts'
import { copyDiagnostics } from './copy.ts'

export function registerDiagnosticsCommands(): Disposable {
  return commands.register('app.copyDiagnostics', {
    run: (a) => {
      const paths = typeof a === 'object' && a !== null ? (a as { paths?: unknown }).paths : undefined
      void copyDiagnostics(typeof paths === 'boolean' ? paths : undefined)
    },
  })
}
