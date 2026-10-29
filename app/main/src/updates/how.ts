// How this install is updated, as the OS layer works it out (`MainOs.updates.how`), and the install commands it names.

import { LINUX_NAME, releaseUrls, type UpdateMode } from '@kea/protocol'

/** How this install is updated. */
export interface UpdateHow {
  mode: UpdateMode
  /** Kea checks by itself here: nothing else updates it. */
  auto: boolean
  /** The command that installs a newer version here, for Copy Command; null where none applies. */
  command: string | null
  /** Why the macOS updater is not used here, for About; null otherwise. */
  why: string | null
}

/** A build not from a release, or one with no release repository: nothing updates it and it never checks. */
export const NOT_FROM_RELEASE: UpdateHow = { mode: 'none', auto: false, command: null, why: null }

/** install.sh from the newest release, piped to `sh`, with its options (`--no-repo`, `--user`). */
export function installCommand(repository: string, option: '--no-repo' | '--user' | null = null): string {
  return `curl -fsSL ${releaseUrls(repository).latest}install.sh | sh${option ? ` -s -- ${option}` : ''}`
}

/** The package manager's own upgrade of Kea's package. */
export function packageManagerCommand(family: 'apt' | 'dnf' | 'zypper'): string {
  if (family === 'apt') return `sudo apt update && sudo apt install --only-upgrade ${LINUX_NAME}`
  if (family === 'dnf') return `sudo dnf upgrade ${LINUX_NAME}`
  return `sudo zypper update ${LINUX_NAME}`
}
