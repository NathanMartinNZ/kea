// Runs `cargo` with the given arguments (`pnpm test:rust`, `pnpm helper:build [--target <triple>]`, `pnpm verify`,
// `pnpm package`). Cargo is looked for on PATH, then where the OS layer says this system keeps it (Homebrew's
// keg-only rustup on macOS, rustup's ~/.cargo/bin on both).
import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packOs } from './pack/src/os/index.ts'

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute path of cargo, or null when Rust is not installed. */
export function resolveCargo(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && executable(join(dir, 'cargo'))) return join(dir, 'cargo')
  }
  for (const p of packOs.rust.cargo(homedir())) {
    if (executable(p)) return p
  }
  return null
}

/** Run cargo with inherited stdio; returns its exit code (127 when cargo is missing). `env` adds to this process's. */
export function runCargo(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): number {
  const cargo = resolveCargo()
  if (!cargo) {
    console.error(`cargo not found: ${packOs.rust.installHint}`)
    return 127
  }
  // rustup's proxies find their toolchain through PATH; put cargo's own directory first
  const dir = cargo.slice(0, cargo.lastIndexOf('/'))
  const env = { ...process.env, ...opts.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` }
  const r = spawnSync(cargo, args, { stdio: 'inherit', env, cwd: opts.cwd })
  if (r.error) {
    console.error(`cargo: ${r.error.message}`)
    return 1
  }
  return r.status ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runCargo(process.argv.slice(2)))
}
