import net from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { parseForkerOutput } from './forker.ts'
import { announceLine, parseServerArgs } from './server.ts'
import { jsonLines, killAll, track, waitGone, zoo } from './test-support.ts'

afterAll(killAll)

interface Line {
  server: 'ready' | 'signal'
  pid: number
  port: number
}

/** Whether something accepts TCP connections on 127.0.0.1:port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })
}

/** Three consecutive ports nothing listens on, outside Kea's own range and the system's (a zoo test has no session block). */
async function freeBlock(): Promise<number> {
  for (let base = 15010; base < 19900; base += 97) {
    const taken = await Promise.all([0, 1, 2].map((i) => listening(base + i)))
    if (!taken.some(Boolean)) return base
  }
  throw new Error('no free ports for the test')
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write('GET / HTTP/1.0\r\n\r\n'))
    s.setEncoding('utf8')
    s.on('data', (d: string) => (text += d))
    s.on('end', () => resolve(text))
    s.on('error', reject)
  })
}

describe('process zoo: server', () => {
  it('U-ZOO-13 · server listens on loopback on --port or $PORT, prints its URL (coloured on request), answers, and exits 0 on SIGINT; --exit ends it at once; a taken port is its own EADDRINUSE error; forker --listen holds one port per process', async () => {
    const s = zoo('server', ['--port', '0', '--color'], { env: { ...process.env, PORT: '4321' } })
    await s.until((o) => jsonLines<Line>(o, 'server').length === 1 && o.includes('Local'), 'the URL line')
    const ready = jsonLines<Line>(s.out(), 'server')[0] as Line
    expect(ready).toMatchObject({ server: 'ready', pid: s.child.pid })
    expect(s.out().startsWith('PORT=4321\n')).toBe(true)
    expect(s.out()).toContain(announceLine({ announce: 'url', printHost: 'localhost', color: true }, ready.port))
    expect(await get(ready.port)).toContain(`ok ${s.child.pid} ${ready.port} PORT=4321`)

    // the same port again: Node's own error, and the exit code asked for
    const second = zoo('server', ['--port', String(ready.port), '--exit-code', '3'])
    expect(await second.exited).toEqual({ code: 3, signal: null })
    expect(second.out()).toContain(`Error: listen EADDRINUSE: address already in use 127.0.0.1:${ready.port}`)

    s.child.kill('SIGINT')
    expect(await s.exited).toEqual({ code: 0, signal: null })
    expect(jsonLines<Line>(s.out(), 'server').at(-1)).toMatchObject({ server: 'signal', signal: 'SIGINT' })
    expect(await listening(ready.port)).toBe(false)

    // the server that exits at once, and the one that crashes later
    const gone = zoo('server', ['--exit', '1'])
    expect(await gone.exited).toEqual({ code: 1, signal: null })
    expect(gone.out()).toBe('PORT=\nexiting 1\n')
    const later = zoo('server', ['--port', '0', '--announce', 'listening', '--exit-after', '0', '--exit-code', '7'])
    expect(await later.exited).toEqual({ code: 7, signal: null })
    expect(later.out()).toMatch(/Server listening on port \d+\n/)

    expect(announceLine({ announce: 'url', printHost: '0.0.0.0', color: false }, 3000)).toBe('  ➜  Local:   http://0.0.0.0:3000/\n')
    expect(announceLine({ announce: 'none', printHost: 'localhost', color: false }, 3000)).toBe('')
    expect(parseServerArgs([], { PORT: '20000' }).port).toBe(20000)
    expect(() => parseServerArgs([], {})).toThrow(/no port/)
    expect(() => parseServerArgs(['--announce', 'loud', '--port', '1'])).toThrow(/--announce/)
    expect(parseServerArgs(['--exit', '0'], {}).port).toBeNull()

    // forker --listen: the parent on the port, each orphaned grandchild on the next ones
    const base = await freeBlock()
    const f = zoo('forker', ['--double-fork', '--children', '2', '--setpgid', '--listen', String(base), '--sleep', '60'])
    await f.until((o) => parseForkerOutput(o).ready !== null, 'the ready line')
    const pids = parseForkerOutput(f.out()).ready as number[]
    track(pids)
    expect(pids).toHaveLength(3)
    expect(await Promise.all([0, 1, 2].map((i) => listening(base + i)))).toEqual([true, true, true])
    for (const pid of pids) process.kill(pid, 'SIGKILL')
    await waitGone(pids)
    expect(await Promise.all([0, 1, 2].map((i) => listening(base + i)))).toEqual([false, false, false])
  })
})
