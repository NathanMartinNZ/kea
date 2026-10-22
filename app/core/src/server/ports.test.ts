import fc from 'fast-check'
import net from 'node:net'
import { createMemoryLogger } from '@kea/kit'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type KeaDb } from '../platform/db/db.ts'
import { insertSession } from '../sessions/rows.ts'
import { bindProbe, blockBases, PortBlocks, type PortProbe } from './ports.ts'

const log = createMemoryLogger({ process: 'core' })
let dbs: KeaDb[] = []
afterEach(() => {
  for (const d of dbs.splice(0)) d.close()
})

function db(): KeaDb {
  const d = openDatabase({ file: ':memory:', log }).db
  dbs.push(d)
  d.tx(() => d.run(`INSERT INTO projects (id, name, root_path, sort_order, created_at) VALUES ('P', 'p', '/p', 1, 0)`))
  return d
}

let n = 0
function session(d: KeaDb): string {
  const id = `S${String(++n).padStart(25, '0')}`
  d.tx(() =>
    insertSession(d, {
      id, projectId: 'P', slug: `s${n}`, title: 't', titleSource: 'auto', isolation: 'inplace', cwd: '/p', worktreeRoot: null, branch: null, baseBranch: null,
      baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{"prompt":""}', lifecycle: 'detached',
      endReason: 'stopped', deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null, sortOrder: 0, pinnedOrder: 0, createdAt: 0, archivedAt: null,
    }),
  )
  return id
}

const free: PortProbe = async () => true

describe('port blocks', () => {
  it('U-SRV-4 · lowest free block, within the range, released on demand, never overlapping (property, against the partial unique index)', async () => {
    const bases = blockBases()
    expect(bases[0]).toBe(L.portRangeStart)
    expect(bases.at(-1)! + L.portBlockSize - 1).toBeLessThanOrEqual(L.portRangeEnd)
    expect(bases.length).toBe(Math.floor((L.portRangeEnd - L.portRangeStart + 1) / L.portBlockSize))
    await fc.assert(
      fc.asyncProperty(fc.array(fc.oneof(fc.constant('alloc' as const), fc.nat({ max: 30 })), { minLength: 1, maxLength: 40 }), async (ops) => {
        const d = db()
        const ports = new PortBlocks({ db: d, log, probe: free })
        const ids: string[] = []
        for (const op of ops) {
          if (op === 'alloc') {
            const id = session(d)
            ids.push(id)
            const base = await ports.allocate(id)
            const taken = d.all<{ port_base: number }>('SELECT port_base FROM sessions WHERE port_base IS NOT NULL AND id != ?', id).map((r) => r.port_base)
            // the lowest block nobody holds
            expect(base).toBe(bases.find((b) => !taken.includes(b)))
            expect(await ports.allocate(id)).toBe(base) // keeps its block
          } else if (ids.length) ports.release(ids[op % ids.length]!)
        }
        const held = d.all<{ port_base: number }>('SELECT port_base FROM sessions WHERE port_base IS NOT NULL').map((r) => r.port_base).sort((a, b) => a - b)
        for (let i = 1; i < held.length; i++) expect(held[i]! - held[i - 1]!).toBeGreaterThanOrEqual(L.portBlockSize)
        for (const b of held) expect(bases).toContain(b)
        // the index is the allocation record: one block, one session
        const [a, b] = ids
        if (a && b && held.length) {
          const pb = d.get<{ port_base: number | null }>('SELECT port_base FROM sessions WHERE id = ?', a)?.port_base
          if (pb !== null && pb !== undefined) expect(() => d.tx(() => d.run('UPDATE sessions SET port_base = ? WHERE id = ?', pb, b))).toThrow(/UNIQUE/)
        }
      }),
      { numRuns: 60 },
    )
  })

  it('U-SRV-4 · allocations asked at once (five creations reaching their base step together) get five distinct blocks, none refused by the index', async () => {
    const d = db()
    // a probe that yields, as the real bind probe does: without one-at-a-time allocation every caller would see the same free block
    const ports = new PortBlocks({ db: d, log, probe: async () => new Promise<boolean>((resolve) => setImmediate(() => resolve(true))) })
    const ids = [1, 2, 3, 4, 5].map(() => session(d))
    const bases = await Promise.all(ids.map((id) => ports.allocate(id)))
    expect(new Set(bases).size).toBe(5)
    expect(bases.slice().sort((a, b) => a! - b!)).toEqual(blockBases().slice(0, 5))
  })

  it('U-SRV-6 · a block with any port busy on 127.0.0.1 or ::1 is skipped; the next fully free block is chosen', async () => {
    const d = db()
    const [b0, b1, b2] = blockBases()
    const busy = new Map<string, true>([
      [`127.0.0.1:${b0! + 7}`, true], // a container a failed teardown left
      [`::1:${b1! + L.portBlockSize - 1}`, true],
    ])
    const asked: string[] = []
    const probe: PortProbe = async (port, host) => {
      asked.push(`${host}:${port}`)
      return !busy.has(`${host}:${port}`)
    }
    const ports = new PortBlocks({ db: d, log, probe })
    expect(await ports.allocate(session(d))).toBe(b2)
    // both hosts were probed for every port of the block it took
    for (let p = b2!; p < b2! + L.portBlockSize; p++) expect(asked).toEqual(expect.arrayContaining([`127.0.0.1:${p}`, `::1:${p}`]))
    busy.clear()
    expect(await ports.allocate(session(d))).toBe(b0)

    // the real probe: a listener on a port makes it busy on that host
    const srv = net.createServer()
    await new Promise<void>((r) => srv.listen({ port: 0, host: '127.0.0.1' }, r))
    const port = (srv.address() as net.AddressInfo).port
    expect(await bindProbe(port, '127.0.0.1')).toBe(false)
    await new Promise<void>((r) => srv.close(() => r()))
    expect(await bindProbe(port, '127.0.0.1')).toBe(true)
  })
})
