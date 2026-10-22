import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The kea repository root: the nearest ancestor holding pnpm-workspace.yaml. */
export function repoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error('kea repo root not found')
    dir = up
  }
}
