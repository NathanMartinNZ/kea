// Linux's side of ptyhost's OS layer (index.ts).
import { rootOnlyFile } from '@kea/kit'
import type { ClientOption, PtyhostOs } from './index.ts'

/**
 * The client option for ptyhost's executable: `--client-exe` when only root can change it (an installed
 * package), so holders check it in full; otherwise (`install.sh --user`, a dev build) `--client-exe-unchecked`, which
 * holders check by identity only, and the platform report says isolation is reduced.
 */
export function clientOption(execPath: string, rootOnly: (p: string) => boolean = rootOnlyFile): ClientOption {
  return { option: rootOnly(execPath) ? '--client-exe' : '--client-exe-unchecked', value: execPath }
}

export const linux: PtyhostOs = {
  system: 'linux',
  clientRequirement: {
    of: (execPath) => Promise.resolve(clientOption(execPath)),
    unchecked: (execPath) => Promise.resolve({ option: '--client-exe-unchecked', value: execPath }),
  },
}
