// Where this build keeps its state: `~/.kea` installed, `~/.kea-dev` for dev builds, and a directory given on the
// command line for tests (`--kea-home=<abs path>`). A `--kea-home` that would not be used (no `=`, or the root
// directory) is refused rather than ignored, so a typo never lands a run on a default home.

import path from 'node:path'

export function keaHome(o: { packaged: boolean; argv: readonly string[]; homedir: string }): string {
  const arg = o.argv.find((a) => a === '--kea-home' || a.startsWith('--kea-home='))
  if (arg === '--kea-home') throw new Error('--kea-home takes its path after "=": --kea-home=<absolute path>')
  if (arg !== undefined) {
    const flag = arg.slice('--kea-home='.length)
    if (!path.isAbsolute(flag)) throw new Error(`--kea-home must be an absolute path (got "${flag}")`)
    const home = path.normalize(flag).replace(/\/+$/, '')
    if (home === '') throw new Error(`--kea-home cannot be the root directory (got "${flag}")`)
    return home
  }
  return path.join(o.homedir, o.packaged ? '.kea' : '.kea-dev')
}
