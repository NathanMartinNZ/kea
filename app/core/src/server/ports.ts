// Port blocks: each non-archived session reserves L.portBlockSize consecutive ports from the system's range (the OS
// layer's `portRange`: L.portRangeStart…L.portRangeEnd on macOS; on Linux only below `ip_local_port_range`'s low end),
// recorded as its `port_base` (the partial unique index on `sessions.port_base` is the allocation record). Allocation
// picks the lowest block that no session holds and whose every port bind-probes free on both 127.0.0.1 and ::1: a
// container a failed teardown left behind, or anything started by hand, can hold any port of a block. Blocks are
// released on archive and delete, so a block recorded inside a range that has since shrunk is kept until the session's
// next unarchive.

import net from 'node:net'
import type { Logger } from '@kea/kit'
import { L, type Banner } from '@kea/protocol'
import { coreOs } from '../os/index.ts'
import type { KeaDb } from '../platform/db/db.ts'

export type ProbeHost = '127.0.0.1' | '::1'
/** True when `port` can be bound on `host` now. */
export type PortProbe = (port: number, host: ProbeHost) => Promise<boolean>

/** Bind and close at once. A host the machine does not have (no IPv6: EADDRNOTAVAIL) counts as free. */
export const bindProbe: PortProbe = (port, host) =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.unref()
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'))
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)))
  })

/** Every block base of the range, lowest first. */
export function blockBases(start: number = L.portRangeStart, end: number = L.portRangeEnd, size: number = L.portBlockSize): number[] {
  const out: number[] = []
  for (let b = start; b + size - 1 <= end; b += size) out.push(b)
  return out
}

/**
 * The banner for too few port blocks: fewer than L.portBlocksMin blocks fit in `range` because `cut` (the system's
 * ephemeral range) ends it early; null when enough fit, or nothing cut it.
 */
export function portBlocksBanner(range: { start: number; end: number }, cut: { setting: string; low: number } | null): Omit<Banner, 'at'> | null {
  const blocks = blockBases(range.start, range.end).length
  if (cut === null || blocks >= L.portBlocksMin) return null
  return {
    kind: 'portBlocks',
    source: 'ports',
    severity: 'warning',
    message: `Only ${blocks} port blocks fit below the system's ephemeral ports (from ${cut.low}), so sessions past that many get no KEA_PORT.`,
    fix: `Move the ephemeral range higher with sysctl ${cut.setting}, then restart Kea.`,
  }
}

/** Whether every port of the block at `base` is free on both hosts. */
export async function blockFree(base: number, probe: PortProbe, size = L.portBlockSize): Promise<boolean> {
  for (let p = base; p < base + size; p++) {
    if (!(await probe(p, '127.0.0.1')) || !(await probe(p, '::1'))) return false
  }
  return true
}

export class PortBlocks {
  private readonly db: KeaDb
  private readonly probe: PortProbe
  private readonly log: Logger
  /** Allocations run one at a time, so two sessions never pick the same block. */
  private queue: Promise<unknown> = Promise.resolve()

  /** Where blocks are allocated (the OS layer's `portRange`, read once at start). */
  readonly range: { start: number; end: number }

  constructor(o: { db: KeaDb; log: Logger; probe?: PortProbe; range?: { start: number; end: number } }) {
    this.db = o.db
    this.log = o.log
    this.probe = o.probe ?? bindProbe
    this.range = o.range ?? coreOs.portRange.range()
  }

  /** Give the session the lowest free block (keeping the one it has); null when the range is exhausted. */
  allocate(sessionId: string): Promise<number | null> {
    const run = this.queue.then(async () => {
      const cur = this.db.get<{ port_base: number | null }>('SELECT port_base FROM sessions WHERE id = ?', sessionId)
      if (!cur) return null
      if (cur.port_base !== null) return cur.port_base
      const taken = new Set(this.db.all<{ port_base: number }>('SELECT port_base FROM sessions WHERE port_base IS NOT NULL').map((r) => r.port_base))
      for (const base of blockBases(this.range.start, this.range.end)) {
        if (taken.has(base)) continue
        if (!(await blockFree(base, this.probe))) {
          this.log.info('port block busy, skipped', { base })
          continue
        }
        const n = this.db.tx(() => this.db.run('UPDATE sessions SET port_base = ? WHERE id = ? AND port_base IS NULL', base, sessionId))
        return n ? base : (this.db.get<{ port_base: number | null }>('SELECT port_base FROM sessions WHERE id = ?', sessionId)?.port_base ?? null)
      }
      this.log.warn('no free port block', { sessionId })
      return null
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Release the session's block (archive, delete). */
  release(sessionId: string): void {
    this.db.tx(() => this.db.run('UPDATE sessions SET port_base = NULL WHERE id = ?', sessionId))
  }
}
