// `sudo node tools/test-hidepid.ts [--user <name>]` (Linux): runs I-PLT-5, the one test that needs `/proc` mounted
// `hidepid`, as the user. No unprivileged process can make that mount itself where AppArmor refuses
// unprivileged user namespaces (Ubuntu 23.10 and later), so this prepares it as root:
//
//   1. `unshare --pid --fork --mount --mount-proc`: a pid namespace of the run's own, with its own `/proc`, in a mount
//      namespace whose mounts the system never sees; this file runs again inside it (`--inside`), as its pid 1;
//   2. `mount -o remount,hidepid=invisible /proc`, inside;
//   3. `setpriv` back to the user (uid, gid, groups), with only the environment a test run needs, then Vitest.
//
// When the run ends, its pid namespace ends with it and the kernel kills whatever is left in it: a holder that the
// harness could not see to clean up (a hidden holder is not in `kea-helper procs`) does not outlive the run.
// Argv arrays only; nothing touches the system's own `/proc` or the user's KEA_HOME.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const self = fileURLToPath(import.meta.url)
const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? null : (args[i + 1] ?? null)
}

function fail(message: string, code = 2): never {
  console.error(`test-hidepid: ${message}`)
  process.exit(code)
}

function run(file: string, argv: string[], env?: NodeJS.ProcessEnv): number {
  const r = spawnSync(file, argv, { stdio: 'inherit', cwd: root, ...(env ? { env } : {}) })
  if (r.error) fail(`${file}: ${r.error.message}`, 1)
  return r.status ?? 1
}

if (process.platform !== 'linux') fail('hidepid is a Linux /proc mount option: there is nothing to run here') // os-ok: a Linux-only runner
if (process.getuid?.() !== 0) fail('run as root (sudo node tools/test-hidepid.ts): the namespace and the mount need it')
const user = opt('--user') ?? process.env.SUDO_USER ?? null
if (!user || user === 'root') fail('name the user the test runs as (--user <name>, or run it with sudo)')

if (!args.includes('--inside')) {
  // 1: a pid and mount namespace of the run's own; this file again, as its pid 1
  process.exit(run('unshare', ['--pid', '--fork', '--mount', '--mount-proc', '--', process.execPath, self, '--inside', '--user', user]))
}

// 2: inside, the namespace's own /proc hides what its user cannot ptrace. Only as the namespace's first process (pid 1
// under `unshare --fork`): `--inside` typed by hand would otherwise remount the system's own /proc
if (process.pid !== 1) fail('--inside is for the run inside its own pid namespace (pid 1); run it without')
if (run('mount', ['-o', 'remount,hidepid=invisible', '/proc']) !== 0) fail('remounting /proc with hidepid=invisible failed', 1)

// 3: back to the user, with a plain environment
const entry = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout?.trim().split(':') ?? []
const [uid, gid, home] = [entry[2], entry[3], entry[5]]
if (!uid || !gid || !home) fail(`no such user: ${user}`)
const runtime = `/run/user/${uid}`
const env: NodeJS.ProcessEnv = {
  HOME: home,
  USER: user,
  LOGNAME: user,
  PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
  LANG: process.env.LANG ?? 'C.UTF-8',
  ...(fs.existsSync(runtime) ? { XDG_RUNTIME_DIR: runtime } : {}),
}
const vitest = path.join(root, 'node_modules/.bin/vitest')
process.exit(run('setpriv', ['--reuid', uid, '--regid', gid, '--init-groups', '--', vitest, 'run', '--project', 'integration', '--testNamePattern', 'I-PLT-5'], env))
