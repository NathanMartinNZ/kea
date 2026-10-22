// pnpm 11 does not run Electron's downloader as an install script; fetch the binary if it is missing.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(join(process.cwd(), 'app/main/package.json'))
const pkg = dirname(require.resolve('electron/package.json'))
if (!existsSync(join(pkg, 'path.txt'))) {
  const r = spawnSync(process.execPath, [join(pkg, 'install.js')], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
