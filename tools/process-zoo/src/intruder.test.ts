import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ClientFrame, clientFrameSplitter, encodeHolderFrame } from '../../../packages/protocol/src/holder.ts'
import { type IntruderReport, intruderBytes, parseIntruderArgs } from './intruder.ts'
import { killAll, zoo } from './test-support.ts'

// unix socket paths are short on macOS (104 bytes): tmpdir, not a deep scratch path
const dir = mkdtempSync(join(tmpdir(), 'zoo-int-'))
const servers: Server[] = [] // bounded: one per test case below
const conns: Socket[] = [] // bounded: one per intruder run below
afterAll(async () => {
  await killAll()
  for (const c of conns) c.destroy()
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  rmSync(dir, { recursive: true, force: true })
})

/** A unix socket server; `onConn` decides what the "holder" does with a connection. */
function serve(name: string, onConn: (c: Socket) => void): Promise<string> {
  const path = join(dir, name)
  const s = createServer((c) => {
    conns.push(c)
    onConn(c)
  })
  servers.push(s)
  return new Promise((resolve) => s.listen(path, () => resolve(path)))
}

async function intrude(args: readonly string[]): Promise<{ code: number | null; report: IntruderReport }> {
  const p = zoo('intruder', args)
  const { code } = await p.exited
  return { code, report: JSON.parse(p.out()) as IntruderReport }
}

describe('process zoo: intruder', () => {
  it('U-ZOO-11 · intruder writes raw bytes or holder frames to a unix socket and reports how the other side refused it', async () => {
    // raw bytes, then the server hangs up
    let rawGot = Buffer.alloc(0)
    const rawPath = await serve('raw', (c) =>
      c.on('data', (d: Buffer) => {
        rawGot = Buffer.concat([rawGot, d])
        if (rawGot.length >= 2) c.end()
      }),
    )
    const raw = await intrude(['--socket', rawPath])
    expect(raw.code).toBe(0)
    expect(raw.report).toMatchObject({ connected: true, connectError: null, wrote: 2, writeError: null, received: 0, frames: null, closedBy: 'peer' })
    expect(rawGot.toString()).toBe('y\r')

    // holder frames: the server reads HELLO, ATTACH, INPUT, answers with an ERROR frame and closes
    const frames: ClientFrame[] = []
    const holderPath = await serve('holder', (c) => {
      const split = clientFrameSplitter()
      c.on('data', (d: Buffer) => {
        frames.push(...split.push(d))
        if (frames.length === 3) c.end(encodeHolderFrame({ t: 'error', code: 3, message: 'refused: unsigned client' }))
      })
    })
    const holder = await intrude(['--socket', holderPath, '--holder', '--data', 'y\\r'])
    expect(holder.code).toBe(0)
    expect(frames.map((f) => (f.t === 'input' ? { t: f.t, data: [...f.data] } : f))).toEqual([
      { t: 'hello', proto: 1 },
      { t: 'attach', mode: 'latest', seq: 0 },
      { t: 'input', data: [0x79, 0x0d] },
    ])
    expect(holder.report).toMatchObject({ connected: true, wrote: intruderBytes({ payload: Buffer.from('y\r'), holder: true }).length, frames: [{ t: 'error', code: 3, message: 'refused: unsigned client' }], closedBy: 'peer' })

    // a server that keeps the connection open: the wait ends it
    const silentPath = await serve('silent', () => {})
    const silent = await intrude(['--socket', silentPath, '--hex', '1b5b41', '--wait-ms', '50'])
    expect(silent.report).toMatchObject({ connected: true, wrote: 3, closedBy: 'timeout' })

    // nothing listening
    const none = await intrude(['--socket', join(dir, 'missing')])
    expect(none.code).toBe(1)
    expect(none.report).toMatchObject({ connected: false, connectError: 'ENOENT', closedBy: null })

    expect(() => parseIntruderArgs([])).toThrow(/--socket is required/)
    expect(() => parseIntruderArgs(['--socket', 'x', '--hex', 'abc'])).toThrow(/pairs of hex digits/)
    expect(parseIntruderArgs(['--socket', 'x', '--data', '\\e[A']).payload).toEqual(Buffer.from('\x1b[A'))
  })
})
