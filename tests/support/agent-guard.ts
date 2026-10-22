// No test may run a real agent CLI: detection runs whatever agent command comes first on the PATH core is given.
// App-level runs are checked by tools/perf/src/launch.ts (`assertLoginShellAgents`); this is the check for a core that
// runs inside a test process.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentCommands, findOnPath } from '@kea/adapters'

/**
 * Fail if `pathValue`, the PATH handed to a core under test, would find an agent command that is not a test's own
 * stand-in. A stand-in lives in the temp directory (a fake-agent shim, a script a test wrote); a real CLI never does,
 * also not through a symlink. Nothing is run: the names are only looked up.
 */
export function assertNoRealAgentOnPath(pathValue: string | undefined): void {
  const tmp = `${fs.realpathSync(os.tmpdir())}${path.sep}`
  for (const c of agentCommands().flatMap((a) => a.names)) {
    const found = findOnPath(c, pathValue)
    if (found && !fs.realpathSync(found).startsWith(tmp)) throw new Error(`the PATH given to the core under test finds \`${c}\` at ${found}, outside the temp directory: detection would run it; refusing to start`)
  }
}
