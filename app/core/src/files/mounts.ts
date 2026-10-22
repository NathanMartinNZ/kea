// Network volumes: which mounted volume a root lies on is a network one, from the text the OS layer's `mounts` reads
// (macOS: `mount`'s output; Linux: `/proc/self/mountinfo`), with that system's parser.

import { isAvailable } from '@kea/protocol'
import { coreOs } from '../os/index.ts'

/** The mount point of the network volume `root` lies on, from this system's mount text; null: a local disk, or none known. */
export function networkMount(text: string, root: string): string | null {
  const mounts = coreOs.mounts
  return isAvailable(mounts) ? mounts.networkMount(text, root) : null
}
