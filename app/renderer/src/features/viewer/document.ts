// A file's document as the viewer keeps it: the editor state and what was learnt reading the file. On screen it is the
// controller's; hidden, it goes to the document cache when it holds nothing unsaved, and to the unsaved registry
// (`unsaved.svelte.ts`) when it does. Plain data and CodeMirror objects only, never in rune state.

import type { EditorState, Text } from '@codemirror/state'
import type { LineChanges, LineEnding, TextBytes } from '@kea/protocol'
import type { Language } from './language.ts'
import { marksOf } from './marks.ts'
import type { ViewPolicy } from './policy.ts'
import type { EditTokens } from './editTokens.ts'
import type { DocSave, SaveFacts } from './saving.ts'
import type { TokenStore } from './tokens.ts'

export interface FileDocument {
  state: EditorState | null
  store: TokenStore | null
  policy: ViewPolicy
  lang: Language | null
  eol: LineEnding
  encoding: TextBytes['encoding']
  invalid: boolean
  size: number
  link: string | null
  changes: LineChanges | null
  /** The longest line, in characters (a line over L.viewerTokenLineMax is not tokenised). */
  longest: number
  /** Lines tokenised so far; -1: all of them. */
  tokenised: number
  stoppedAt: number | null
  bytes: number
  /** The save state of an editable document; null for one that was never editable. */
  save: DocSave | null
  /** Why the document cannot be edited now; null while it can (or it was never editable: `save` is null then). */
  readOnly: string | null
  /** Why the file cannot be written back (no permission, inside `.git`, hard-linked), as its last read said. */
  unwritable: string | null
  /** The file stopped being text the document can be saved as, with unsaved changes: what it is now. */
  notText: string | null
  /**
   * The file's text and facts from a read or a save's answer, to merge when the document is on screen; `again`: a save
   * met them, and is made again once they are merged with nothing marked.
   */
  pendingDisk: { text: Text; facts: SaveFacts; again: boolean } | null
  /** Set aside by Don't Save while the action that closes it runs: read-only, "Closing…". */
  closing: boolean
  /** The colours of an editable document while it is edited (`editTokens.ts`); null for a read-only one, or plain text. */
  colours: EditTokens | null
}

/** What a document with unsaved text weighs in the unsaved registry: its text and `base` in UTF-16 code units, and its undo history's estimate. */
export function unsavedWeight(doc: FileDocument, historyBytes: number): number {
  return (doc.state?.doc.length ?? 0) + (doc.save?.base.length ?? 0) + historyBytes
}

/** Whether the document holds text that is not on disk, or a place marked where the file changed under it. */
export function hasUnsaved(doc: FileDocument): boolean {
  // a marked place is not settled even where the user has put the file's text back: a later change of the file is
  // merged with it
  return doc.save?.unsaved === true || (doc.save !== null && doc.state !== null && marksOf(doc.state).length > 0)
}
