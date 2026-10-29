// What the open-in-editor button's tooltip says when it cannot open the default editor: no editor was found on the
// machine, or the one the setting names is not installed. Empty while the default editor is there.

import type { SystemWords } from '@kea/protocol'

export function editorHint(o: { hasDefault: boolean; found: number; configured: string }, words: Pick<SystemWords, 'machine'>): string {
  if (o.hasDefault) return ''
  return o.found === 0 ? `No editor was found on ${words.machine}` : `${o.configured} is not installed`
}
