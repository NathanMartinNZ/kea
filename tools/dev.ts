// `pnpm dev [-- <args for Kea>]`: build the release kea-helper and dist/app (tools/build.ts), then run it with Electron
// from node_modules. A dev build keeps its state in ~/.kea-dev (app/main/src/home.ts), never ~/.kea. Extra arguments go
// to Kea, e.g. `pnpm dev -- --kea-home=/tmp/kea-try`. Ctrl-C stops Kea; holders (and the shells in them) keep running,
// as they would after quitting the installed app. On Linux it first writes the dev build's desktop file when it is
// missing or differs (a notification's click activates Kea through it), and checks that Chromium's sandbox can
// start, printing the fix when it cannot. `pnpm dev --remove-desktop-file` removes that file and runs nothing. It runs
// with your own environment and no harness guard, so it finds and runs the real agent CLIs: tests and tools start Kea
// through tools/perf/src/launch.ts `launchKea` instead.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { runCargo } from './cargo.ts'
import { packOs } from './pack/src/os/index.ts'

const root = path.resolve(import.meta.dirname, '..')
const REMOVE_DESKTOP_FILE = '--remove-desktop-file'
const args = process.argv.slice(2).filter((a) => a !== '--' && a !== REMOVE_DESKTOP_FILE)
const electron = createRequire(path.join(root, 'app/main/package.json'))('electron') as unknown as string

const desktopFile = packOs.devDesktop.file({ home: os.homedir(), env: process.env, root, electron })
if (process.argv.includes(REMOVE_DESKTOP_FILE)) {
  if (desktopFile) {
    fs.rmSync(desktopFile.path, { force: true })
    console.log(`removed ${desktopFile.path}`)
  } else console.log('this system needs no desktop file for the dev build')
  process.exit(0)
}
if (desktopFile) {
  const now = fs.existsSync(desktopFile.path) ? fs.readFileSync(desktopFile.path, 'utf8') : null
  if (now !== desktopFile.text) {
    fs.mkdirSync(path.dirname(desktopFile.path), { recursive: true })
    fs.writeFileSync(desktopFile.path, desktopFile.text)
    console.log(`wrote ${desktopFile.path} (the dev build's desktop file; pnpm dev ${REMOVE_DESKTOP_FILE} removes it)`)
  }
}
const sandboxProblem = packOs.devDesktop.sandboxProblem(electron)
if (sandboxProblem) {
  console.error(sandboxProblem)
  process.exit(1)
}

// A dev main runs the release kea-helper from native/kea-helper/target/release: without it no terminal starts. Cargo
// does nothing when the build is current.
const helper = runCargo(['build', '--release', '--manifest-path', path.join(root, 'native/kea-helper/Cargo.toml')])
if (helper !== 0) {
  console.error('pnpm dev: building kea-helper failed (pnpm helper:build builds it on its own)')
  process.exit(helper)
}

const built = spawnSync(process.execPath, [path.join(root, 'tools/build.ts')], { cwd: root, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const child = spawn(electron, [path.join(root, 'dist/app'), ...args], { cwd: root, stdio: 'inherit' })
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
