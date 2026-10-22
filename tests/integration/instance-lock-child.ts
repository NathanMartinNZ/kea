// The stand-in for core's start (app/core/src/main.ts) in instance-lock.test.ts: take `<home>/run/<name>.lock` with
// kit's instance lock. Held: start a child of its own (as core starts git, shells and tools) that outlives it, print
// `held <pid> <child pid>` and stay running, as core does. Taken: print `locked` and exit 3, as core and ptyhost do.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { tryLock } from '@kea/kit'

const [home, name] = process.argv.slice(2)
const lock = tryLock(path.join(home!, 'run', `${name!}.lock`))
if (!lock) {
  process.stdout.write('locked\n')
  process.exit(3)
}
const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' }) // os-ok: in /bin on both systems
child.unref()
process.stdout.write(`held ${process.pid} ${child.pid}\n`)
setInterval(() => {}, 1 << 30)
