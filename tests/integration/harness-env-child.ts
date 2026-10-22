// A child of harness.test.ts: core's own login-shell resolution (`resolveShellEnv` as core's ShellEnvCache
// calls it, with this process's whole environment as the base and its HOME as `os.homedir()`), run with exactly the
// environment a harness hands to Kea; then where agent detection would find `claude` on the resulting PATH.
// Nothing is run: `findOnPath` only looks the path up.
//
//   node tests/integration/harness-env-child.ts      prints {"source": …, "claude": <path or null>, "path": …}

import { findOnPath } from '@kea/adapters'
import { resolveShellEnv } from '@kea/core/src/terminal/shellEnv.ts'

const r = await resolveShellEnv()
process.stdout.write(JSON.stringify({ source: r.source, claude: findOnPath('claude', r.env.PATH), path: r.env.PATH ?? null }))
