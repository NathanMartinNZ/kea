// Main's session-bus client: the wire format checked by hand, and the client against a fake bus on a temporary socket
// that answers as the real one does (AUTH EXTERNAL, Hello, AddMatch, NameHasOwner and the NameOwnerChanged signal).
// Checked against GNOME 46's own bus as well.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeMessage, encodeMessage, messageLength, sessionBusPath, watchBusNames, type BusMessage } from './dbus.ts'

const TRAY = 'org.kde.StatusNotifierWatcher'
const NOTIFY = 'org.freedesktop.Notifications'

/** A bus that answers main's client as dbus-daemon does; `quiet` leaves calls unanswered. */
function fakeBus(owners: Map<string, boolean>, o: { quiet?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-bus-'))
  const file = path.join(dir, 'bus')
  const seen = { auth: '', nul: false, begin: false, calls: [] as BusMessage[], closed: false }
  let onClosed: () => void = () => undefined
  const closed = new Promise<void>((resolve) => (onClosed = resolve))
  let client: net.Socket | null = null
  let serial = 1000
  const onCall = new Set<(m: BusMessage) => void>()
  const send = (m: Omit<BusMessage, 'body' | 'serial'> & { body?: (string | boolean)[] }) => client?.write(encodeMessage({ serial: ++serial, ...m }))
  const server = net.createServer((c) => {
    client = c
    let buf: Buffer = Buffer.alloc(0)
    let phase: 'auth' | 'begin' | 'messages' = 'auth'
    c.on('close', () => {
      seen.closed = true
      onClosed()
    })
    c.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (phase !== 'messages') {
          const nl = buf.indexOf('\r\n')
          if (nl < 0) return
          let line = buf.toString('latin1', 0, nl)
          buf = buf.subarray(nl + 2)
          if (phase === 'auth') {
            seen.nul = line.charCodeAt(0) === 0
            line = line.replace(/^\0/, '')
            seen.auth = line
            c.write('OK 0123456789abcdef0123456789abcdef\r\n')
            phase = 'begin'
          } else {
            seen.begin = line === 'BEGIN'
            phase = 'messages'
          }
          continue
        }
        const n = messageLength(buf)
        if (n === null || buf.length < n) return
        const m = decodeMessage(buf.subarray(0, n))
        buf = buf.subarray(n)
        seen.calls.push(m)
        for (const cb of [...onCall]) cb(m)
        if (o.quiet || m.type !== 'call') continue
        const reply = { type: 'return' as const, replySerial: m.serial, destination: ':1.42', sender: 'org.freedesktop.DBus' }
        if (m.member === 'Hello') send({ ...reply, signature: 's', body: [':1.42'] })
        else if (m.member === 'AddMatch') send({ ...reply, signature: '' })
        else if (m.member === 'NameHasOwner') send({ ...reply, signature: 'b', body: [owners.get(String(m.body?.[0])) === true] })
      }
    })
  })
  return {
    file,
    seen,
    /** The client's connection closed. */
    closed,
    listening: new Promise<void>((resolve) => server.listen(file, resolve)),
    /** The next call the bus receives with this member. */
    called: (member: string) =>
      new Promise<BusMessage>((resolve) => {
        const cb = (m: BusMessage) => {
          if (m.member !== member) return
          onCall.delete(cb)
          resolve(m)
        }
        onCall.add(cb)
      }),
    owner(name: string, present: boolean) {
      owners.set(name, present)
      send({ type: 'signal', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged', sender: 'org.freedesktop.DBus', signature: 'sss', body: [name, present ? '' : ':1.7', present ? ':1.7' : ''] })
    },
    /** The bus ends the connection (a bus restarting). */
    hangUp() {
      client?.destroy()
    },
    /** A header that says its message is bigger than main reads. */
    oversize() {
      const b = Buffer.alloc(16)
      b.write('l', 0, 'latin1')
      b[1] = 4
      b[3] = 1
      b.writeUInt32LE(L.dbusMessageMaxBytes, 4)
      b.writeUInt32LE(1, 8)
      b.writeUInt32LE(0, 12)
      client?.write(b)
    },
    close: () =>
      new Promise<void>((resolve) => {
        client?.destroy()
        server.close(() => resolve())
        fs.rmSync(dir, { recursive: true, force: true })
      }),
  }
}

/** A warn callback, and the next warning it hears. */
function warnings() {
  const said: string[] = []
  let waiter: (() => void) | null = null
  return {
    said,
    warn: (m: string) => {
      said.push(m)
      waiter?.()
      waiter = null
    },
    next: () => new Promise<void>((resolve) => (waiter = resolve)),
  }
}

/** Resolves once every one of `names` has an answer (`has` not null). */
function answered(bus: ReturnType<typeof watchBusNames>, names: string[]): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (names.every((n) => bus.has(n) !== null)) {
        off()
        resolve()
      }
    }
    const off = bus.onChange(check)
    check()
  })
}

describe("main's session-bus client", () => {
  const closers: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    vi.useRealTimers()
    for (const c of closers.splice(0).reverse()) await c()
  })

  // The bytes: a little-endian call as main writes it (header, fields aligned to 8, the body after the padded header),
  // read back; a big-endian return laid out by hand from the specification, read as the bus would send it; the bus's
  // address from DBUS_SESSION_BUS_ADDRESS (a path, an abstract name with its escapes) or $XDG_RUNTIME_DIR/bus.
  it('U-PLT-35 · the wire format: a call written and read back, a big-endian return read as laid out by hand, the bus address', () => {
    const call = encodeMessage({ type: 'call', serial: 1, path: '/org/freedesktop/DBus', destination: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameHasOwner', signature: 's', body: [TRAY] })
    expect([...call.subarray(0, 4)]).toEqual([0x6c, 1, 0, 1])
    expect(call.readUInt32LE(4), 'the body: a string of the name, its length and NUL').toBe(4 + TRAY.length + 1)
    expect(call.readUInt32LE(8)).toBe(1)
    expect(messageLength(call)).toBe(call.length)
    expect((call.length - call.readUInt32LE(4)) % 8, 'the body starts on an 8-byte boundary').toBe(0)
    expect(decodeMessage(call)).toEqual({ type: 'call', serial: 1, path: '/org/freedesktop/DBus', destination: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameHasOwner', signature: 's', body: [TRAY] })
    // 'B', return, flags 0, version 1 · body 4 · serial 7 · fields 15 · REPLY_SERIAL u 3 · (pad) SIGNATURE g "b" · (pad) · true
    const be = Buffer.from([0x42, 2, 0, 1, 0, 0, 0, 4, 0, 0, 0, 7, 0, 0, 0, 15, 5, 1, 0x75, 0, 0, 0, 0, 3, 8, 1, 0x67, 0, 1, 0x62, 0, 0, 0, 0, 0, 1])
    expect(messageLength(be)).toBe(36)
    expect(decodeMessage(be)).toEqual({ type: 'return', serial: 7, replySerial: 3, signature: 'b', body: [true] })
    expect(() => messageLength(Buffer.alloc(16, 0x58)), 'not a D-Bus byte order').toThrow(RangeError)
    expect(messageLength(be.subarray(0, 15)), 'the fixed header not all there').toBeNull()
    expect(() => encodeMessage({ type: 'call', serial: 1, member: 'X', signature: 's', body: ['x'.repeat(L.dbusMessageMaxBytes)] })).toThrow()
    // the bus's address
    expect(sessionBusPath({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })).toBe('/run/user/1000/bus')
    expect(sessionBusPath({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-%41b,guid=0123' })).toBe('\0/tmp/dbus-Ab')
    expect(sessionBusPath({ DBUS_SESSION_BUS_ADDRESS: 'tcp:host=x', XDG_RUNTIME_DIR: '/run/user/1000' })).toBe('/run/user/1000/bus')
    expect(sessionBusPath({})).toBeNull()
  })

  // The client: AUTH EXTERNAL with the uid in hex after a NUL, BEGIN, Hello, a match per name before NameHasOwner (so
  // no change between them is missed), then each name's owner; NameOwnerChanged says when a name comes or goes. A
  // message bigger than the limit, or a call unanswered within its time, ends the connection: the names then read null
  // and nothing is asked again. No bus: every name reads null. dispose() closes the socket.
  it('U-PLT-35 · the client: auth, Hello, a match then the owner of each name, changes heard; an oversized message or a silent bus ends it; dispose closes it', async () => {
    const bus = fakeBus(new Map([[TRAY, true]]))
    closers.push(bus.close)
    await bus.listening
    const w = warnings()
    const warned = w.said
    const names = watchBusNames([TRAY, NOTIFY], { path: bus.file, uid: 1000, warn: w.warn })
    closers.push(() => names.dispose())
    expect([names.has(TRAY), names.has(NOTIFY)], 'before the bus answers').toEqual([null, null])
    await answered(names, [TRAY, NOTIFY])
    expect([names.has(TRAY), names.has(NOTIFY)]).toEqual([true, false])
    expect([bus.seen.nul, bus.seen.auth, bus.seen.begin]).toEqual([true, `AUTH EXTERNAL ${Buffer.from('1000').toString('hex')}`, true])
    expect(bus.seen.calls.map((m) => m.member)).toEqual(['Hello', 'AddMatch', 'AddMatch', 'NameHasOwner', 'NameHasOwner'])
    expect(bus.seen.calls[1]!.body).toEqual([`type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${TRAY}'`])
    // a name that comes and goes
    const changes: [string, boolean | null][] = []
    const heard = (n: number) =>
      new Promise<void>((resolve) => {
        const off = names.onChange((name, present) => {
          changes.push([name, present])
          if (changes.length >= n) {
            off()
            resolve()
          }
        })
      })
    let next = heard(1)
    bus.owner(TRAY, false)
    await next
    next = heard(2)
    bus.owner(NOTIFY, true)
    await next
    expect(changes).toEqual([
      [TRAY, false],
      [NOTIFY, true],
    ])
    expect([names.has(TRAY), names.has(NOTIFY)]).toEqual([false, true])
    // a message over the limit: the connection ends, and the names read null
    const ended = w.next()
    bus.oversize()
    await ended
    expect(warned).toEqual(['session bus: a message over the size limit'])
    expect([names.has(TRAY), names.has(NOTIFY)]).toEqual([null, null])

    // no bus at all
    const none = watchBusNames([TRAY], { path: null, uid: 1000 })
    expect(none.has(TRAY)).toBeNull()
    none.dispose()
  })

  it('U-PLT-49 · a lost connection is told: when the bus closes the socket, or a message over the limit ends it, each name that had an answer is reported unknown (null) to every listener, so main stops trusting a tray host it heard of', async () => {
    for (const end of ['closed by the bus', 'oversized'] as const) {
      const bus = fakeBus(new Map([[TRAY, true]]))
      closers.push(bus.close)
      await bus.listening
      const w = warnings()
      const names = watchBusNames([TRAY, NOTIFY], { path: bus.file, uid: 1000, warn: w.warn })
      closers.push(() => names.dispose())
      await answered(names, [TRAY, NOTIFY])
      const heard: [string, boolean | null][] = []
      const unknown = new Promise<void>((resolve) => {
        names.onChange((name, present) => {
          heard.push([name, present])
          if (heard.length === 2) resolve()
        })
      })
      if (end === 'oversized') bus.oversize()
      else bus.hangUp()
      await unknown
      expect(heard, end).toEqual([
        [TRAY, null],
        [NOTIFY, null],
      ])
      expect([names.has(TRAY), names.has(NOTIFY)], end).toEqual([null, null])
    }
  })

  it('U-PLT-35 · a bus that does not answer: the call ends after L.dbusCallTimeoutMs, the names read null; dispose closes the socket', async () => {
    const bus = fakeBus(new Map(), { quiet: true })
    closers.push(bus.close)
    await bus.listening
    const warned: string[] = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hello = bus.called('Hello')
    const names = watchBusNames([TRAY], { path: bus.file, uid: 1000, warn: (m) => warned.push(m) })
    await hello
    vi.advanceTimersByTime(L.dbusCallTimeoutMs - 1)
    expect(warned).toEqual([])
    vi.advanceTimersByTime(1)
    expect(warned).toEqual([`session bus: Hello had no answer within ${L.dbusCallTimeoutMs} ms`])
    expect(names.has(TRAY)).toBeNull()
    names.dispose()
    // a client that is disposed while connected closes its socket
    vi.useRealTimers()
    const bus2 = fakeBus(new Map([[TRAY, true]]))
    closers.push(bus2.close)
    await bus2.listening
    const live = watchBusNames([TRAY], { path: bus2.file, uid: 1000 })
    await answered(live, [TRAY])
    live.dispose()
    await bus2.closed
    expect([bus2.seen.closed, live.has(TRAY)]).toEqual([true, null])
  })
})
