// Global setup/teardown for the integration suite: every test cleans up the holders it spawned, and the run fails if a
// kea-helper this invocation started is still alive. The setup tags the invocation (tests/support/helpers.ts
// `RUN_TAG_ENV`), so every home its tests make is `kea-test-<tag>-*` and the teardown looks at those alone: holders of
// a memory, chaos or perf run going on at the same time, of another integration run, or of the installed app are never
// signalled and never fail this run. Its own strays are killed only after an identity check (pid, start time and
// executable, as their state file or the process listing had them), and its homes are removed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { processTable, signalKnown } from '../../tools/perf/src/launch.ts'
import { homesOf, RUN_TAG_ENV, runHomePrefix } from '../support/helpers.ts'
import { holderAlive, holdersIn, killHolder } from '../support/holders.ts'

/** Where test homes are made: `shortKeaHome` (/tmp) and `tempKeaHome` (the system temp dir), canonical. */
const TEMP_ROOTS = [...new Set(['/tmp', os.tmpdir()].map((d) => fs.realpathSync(d)))]

export default function setup(): () => void {
  process.env[RUN_TAG_ENV] = `r${Math.random().toString(36).slice(2, 8)}`
  const prefix = runHomePrefix()
  return function teardown() {
    const strays = processTable().filter((p) => path.basename(p.comm) === 'kea-helper' && p.args.includes(`/${prefix}`))
    const homes = new Set(strays.flatMap((p) => homesOf(p.args, prefix)))
    for (const root of TEMP_ROOTS) for (const d of fs.readdirSync(root)) if (d.startsWith(prefix)) homes.add(path.join(root, d))
    // holders by their state file first (child, then holder), then any other helper of this run by its listing
    for (const home of homes) for (const id of holdersIn(home)) if (holderAlive(home, id)) killHolder(home, id)
    for (const p of strays) signalKnown(p, 'SIGKILL')
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
    if (strays.length) throw new Error(`kea-helper processes of this integration run were still alive at its end (now killed):\n${strays.map((p) => `  ${p.pid} ${p.args.slice(0, 200)}`).join('\n')}`)
  }
}
