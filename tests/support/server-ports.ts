// Port blocks for the suites that run real stand-in dev servers in a core of their own.
//
// Every test core starts with an empty database, so every one of them would give its first session the lowest free
// block; two test files running side by side would then start their servers on the same ports (a block is only
// skipped once something listens in it). A suite that listens passes `ownBlocks()` as core's port probe: the blocks
// below a base of this worker's own read as taken, so its sessions get blocks no other worker's sessions get. The base
// is in the upper half of the range core allocates from (the system's: on Linux it ends below the ephemeral ports),
// clear of the lowest blocks every other suite's sessions take.

import { coreOs } from '@kea/core/src/os/index.ts'
import { bindProbe, blockBases, type PortProbe } from '@kea/core/src/server/ports.ts'

/** The first port this worker's sessions may be given: a block base in the upper half of the range, by pid. */
export function ownPortBase(pid = process.pid): number {
  const range = coreOs.portRange.range()
  const bases = blockBases(range.start, range.end)
  const half = Math.floor(bases.length / 2)
  return bases[half + (pid % Math.floor(half / 2))] as number
}

/** Core's port probe (`CoreOptions.portProbe`) under which this worker's sessions get blocks of their own. */
export function ownBlocks(base = ownPortBase()): PortProbe {
  return (port, host) => (port < base ? Promise.resolve(false) : bindProbe(port, host))
}
