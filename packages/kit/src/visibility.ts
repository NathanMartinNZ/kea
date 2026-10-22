// Whether `/proc` hides a user's own non-dumpable holders from it: the OS layer's `holderVisibility`, for core's
// liveness check and main's platform report.
import { kitOs } from './os/index.ts'

/** `hidepid`'s value while `/proc` hides this user's holders from it, else null (always null on macOS). */
export function holdersHidden(): string | null {
  return kitOs.holderVisibility.hidden()
}
