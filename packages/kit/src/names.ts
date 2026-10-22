// File names, through the OS layer's `nameKey`: APFS ignores Unicode normalisation, so macOS takes every name as NFC,
// as Kea always has; ext4 and btrfs keep a name's bytes, so on Linux file operations use the name as stored and NFC is
// only the key names are compared and searched by.
import { need } from '@kea/protocol/platform'
import { kitOs } from './os/index.ts'

/** A name or path as file operations and the views take it: macOS NFC; Linux as stored, untouched. */
export function fileName(name: string): string {
  return need(kitOs.nameKey).fileName(name)
}

/** The key two names are compared and searched by (NFC). */
export function nameKey(name: string): string {
  return need(kitOs.nameKey).key(name)
}

/** Names are kept as stored (Linux): a search indexes the key and answers with the stored name. */
export function namesAsStored(): boolean {
  return need(kitOs.nameKey).asStored
}
