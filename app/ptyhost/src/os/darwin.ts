// macOS's side of ptyhost's OS layer (index.ts).
import { runProcess } from '@kea/kit'
import { L } from '@kea/protocol'
import type { ClientOption, PtyhostOs } from './index.ts'

/** `kea-helper`'s signing identifier: an agent can run it, so holders must never admit it. */
const HELPER_IDENTIFIER = 'dev.kea.helper'

/**
 * The code requirement holders admit: this process's own designated requirement, i.e. what ptyhost runs as.
 * Signed with the local certificate that is `identifier "<ptyhost's identifier>" and certificate leaf = H"…"`,
 * and both parts are kept: every Kea build shares the identifier (the bundle id never changes) and the leaf, so build
 * N+1's ptyhost is admitted by build N's holders, while nothing else the certificate signs is: not the app's
 * other executables, and above all not `kea-helper`, which any agent can run. A requirement that would pin the leaf
 * without an identifier, or that names `kea-helper`, is refused (null). Ad-hoc signatures (npm's Electron, Homebrew's
 * node) have only a `cdhash`, which is used as is.
 */
export function requirementFrom(codesignOutput: string): string | null {
  const m = /designated => (.+)$/m.exec(codesignOutput)
  if (!m) return null
  const dr = (m[1] as string).trim()
  const leaf = /certificate leaf = H"[0-9a-fA-F]+"/.exec(dr)
  if (!leaf) return dr
  const id = /(?:^|\(|\band )identifier "([^"]+)"/.exec(dr)?.[1]
  if (!id || id === HELPER_IDENTIFIER) return null
  return `identifier "${id}" and ${leaf[0]}`
}

/** `codesign -d -r-` of the executable: its designated requirement, as `requirementFrom` keeps it, for `--client-req`. */
async function codesignRequirement(execPath: string): Promise<ClientOption> {
  const res = await runProcess('/usr/bin/codesign', ['-d', '-r-', execPath], { pool: 'other', timeoutMs: L.codesignTimeoutMs, maxBytes: L.codesignOutputMaxBytes })
  const req = requirementFrom(`${res.stdout?.toString('utf8') ?? ''}\n${res.stderr}`)
  if (!req) throw new Error(`no designated requirement holders may use for ${execPath} (codesign exit ${res.code}): ${res.stderr.slice(0, 300)}`)
  return { option: '--client-req', value: req }
}

export const darwin: PtyhostOs = {
  system: 'darwin',
  // a test runner's node is admitted by its own signature, as Kea is
  clientRequirement: { of: codesignRequirement, unchecked: codesignRequirement },
}
