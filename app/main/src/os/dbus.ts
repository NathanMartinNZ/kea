// A small session-bus client for main's Linux layer: just enough of the D-Bus wire protocol to ask whether a well-known
// name has an owner and to hear when that changes, over the bus's own socket. No child process runs: a `busctl monitor`
// or `gdbus monitor` child would outlive a Kea that crashed, and the bus connection closes with main by itself. It
// speaks only to the bus itself (`org.freedesktop.DBus`): `Hello`, `NameHasOwner` and `AddMatch` for `NameOwnerChanged`
// with `arg0` each watched name. EXTERNAL authentication as the user's own uid, no file descriptors, either byte order
// read, little-endian written.
//
//   message  = fixed header (endianness, type, flags, version 1, body length, serial)
//              + header fields a(yv) (path, interface, member, error name, reply serial, destination, sender, signature)
//              + padding to 8 + body (the signature's values, each aligned to its type)

import net from 'node:net'
import { L } from '@kea/protocol'

export type BusValue = string | number | boolean

/** A message as main's client reads and writes it: the header fields it uses and a body of simple values. */
export interface BusMessage {
  type: 'call' | 'return' | 'error' | 'signal'
  serial: number
  path?: string
  interface?: string
  member?: string
  errorName?: string
  replySerial?: number
  destination?: string
  sender?: string
  /** The body's signature; '' for none. Only `s`, `o`, `g`, `u`, `i`, `b` and `y` are read; any other body is null. */
  signature: string
  body: BusValue[] | null
}

const TYPES = { call: 1, return: 2, error: 3, signal: 4 } as const
const TYPE_NAMES: Readonly<Record<number, BusMessage['type']>> = { 1: 'call', 2: 'return', 3: 'error', 4: 'signal' }
/** Header field codes (the D-Bus specification's table). */
const FIELDS = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8 } as const
const FIELD_TYPES: Readonly<Record<number, string>> = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g', 9: 'u' }
/** The fixed part of a header: 4 bytes, the body's length, the serial and the fields array's length. */
const FIXED = 16
const LITTLE = 0x6c // 'l'
const BIG = 0x42 // 'B'
const ALIGN: Readonly<Record<string, number>> = { y: 1, g: 1, b: 4, u: 4, i: 4, s: 4, o: 4 }

const align = (n: number, a: number): number => (n + a - 1) & ~(a - 1)

class Writer {
  private readonly buf: Buffer
  len = 0
  constructor(cap: number) {
    this.buf = Buffer.alloc(cap)
  }
  private room(n: number): void {
    if (this.len + n > this.buf.length) throw new RangeError(`a D-Bus message over ${this.buf.length} bytes`)
  }
  pad(a: number): void {
    const to = align(this.len, a)
    this.room(to - this.len)
    this.buf.fill(0, this.len, to)
    this.len = to
  }
  byte(v: number): void {
    this.room(1)
    this.buf[this.len++] = v
  }
  u32(v: number): void {
    this.pad(4)
    this.room(4)
    this.buf.writeUInt32LE(v >>> 0, this.len)
    this.len += 4
  }
  i32(v: number): void {
    this.pad(4)
    this.room(4)
    this.buf.writeInt32LE(v, this.len)
    this.len += 4
  }
  str(s: string): void {
    const b = Buffer.from(s, 'utf8')
    this.u32(b.length)
    this.room(b.length + 1)
    b.copy(this.buf, this.len)
    this.len += b.length
    this.buf[this.len++] = 0
  }
  sig(s: string): void {
    const b = Buffer.from(s, 'latin1')
    this.byte(b.length)
    this.room(b.length + 1)
    b.copy(this.buf, this.len)
    this.len += b.length
    this.buf[this.len++] = 0
  }
  value(t: string, v: BusValue): void {
    if (t === 's' || t === 'o') this.str(String(v))
    else if (t === 'g') this.sig(String(v))
    else if (t === 'u') this.u32(Number(v))
    else if (t === 'i') this.i32(Number(v))
    else if (t === 'b') this.u32(v ? 1 : 0)
    else if (t === 'y') this.byte(Number(v))
    else throw new TypeError(`D-Bus type ${t} is not written here`)
  }
  setU32(at: number, v: number): void {
    this.buf.writeUInt32LE(v >>> 0, at)
  }
  bytes(): Buffer {
    return this.buf.subarray(0, this.len)
  }
}

class Reader {
  private readonly b: Buffer
  private readonly le: boolean
  off: number
  constructor(b: Buffer, le: boolean, off = 0) {
    this.b = b
    this.le = le
    this.off = off
  }
  private need(n: number): void {
    if (this.off + n > this.b.length) throw new RangeError('a D-Bus message cut short')
  }
  pad(a: number): void {
    this.off = align(this.off, a)
  }
  byte(): number {
    this.need(1)
    return this.b[this.off++] as number
  }
  u32(): number {
    this.pad(4)
    this.need(4)
    const v = this.le ? this.b.readUInt32LE(this.off) : this.b.readUInt32BE(this.off)
    this.off += 4
    return v
  }
  i32(): number {
    this.pad(4)
    this.need(4)
    const v = this.le ? this.b.readInt32LE(this.off) : this.b.readInt32BE(this.off)
    this.off += 4
    return v
  }
  str(): string {
    const n = this.u32()
    this.need(n + 1)
    const s = this.b.toString('utf8', this.off, this.off + n)
    this.off += n + 1
    return s
  }
  sig(): string {
    const n = this.byte()
    this.need(n + 1)
    const s = this.b.toString('latin1', this.off, this.off + n)
    this.off += n + 1
    return s
  }
  value(t: string): BusValue {
    if (t === 's' || t === 'o') return this.str()
    if (t === 'g') return this.sig()
    if (t === 'u') return this.u32()
    if (t === 'i') return this.i32()
    if (t === 'b') return this.u32() !== 0
    if (t === 'y') return this.byte()
    throw new TypeError(`D-Bus type ${t} is not read here`)
  }
}

/** One message's bytes (little-endian). Header fields that are undefined are left out. */
export function encodeMessage(m: Omit<BusMessage, 'body'> & { body?: readonly BusValue[] }, cap: number = L.dbusMessageMaxBytes): Buffer {
  const body = new Writer(cap)
  const types = [...m.signature]
  const values = m.body ?? []
  if (types.length !== values.length) throw new TypeError(`signature ${m.signature} names ${types.length} values, ${values.length} given`)
  types.forEach((t, i) => body.value(t, values[i] as BusValue))
  const w = new Writer(cap)
  w.byte(LITTLE)
  w.byte(TYPES[m.type])
  w.byte(0)
  w.byte(1)
  w.u32(body.len)
  w.u32(m.serial)
  const lengthAt = w.len
  w.u32(0)
  w.pad(8)
  const start = w.len
  const field = (code: number, v: BusValue | undefined) => {
    if (v === undefined) return
    const t = FIELD_TYPES[code] as string
    w.pad(8)
    w.byte(code)
    w.sig(t)
    w.value(t, v)
  }
  field(FIELDS.path, m.path)
  field(FIELDS.interface, m.interface)
  field(FIELDS.member, m.member)
  field(FIELDS.errorName, m.errorName)
  field(FIELDS.replySerial, m.replySerial)
  field(FIELDS.destination, m.destination)
  field(FIELDS.sender, m.sender)
  if (m.signature !== '') field(FIELDS.signature, m.signature)
  w.setU32(lengthAt, w.len - start)
  w.pad(8)
  return Buffer.concat([w.bytes(), body.bytes()])
}

/** How many bytes the message at the start of `buf` takes, or null while its fixed header is not all there. */
export function messageLength(buf: Buffer): number | null {
  if (buf.length < FIXED) return null
  const le = buf[0] === LITTLE
  if (!le && buf[0] !== BIG) throw new RangeError(`not a D-Bus message (byte order ${buf[0]})`)
  const bodyLen = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4)
  const fieldsLen = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12)
  return align(FIXED + fieldsLen, 8) + bodyLen
}

/** The message whose bytes are `buf` (one whole message, as `messageLength` says). */
export function decodeMessage(buf: Buffer): BusMessage {
  const le = buf[0] === LITTLE
  if (!le && buf[0] !== BIG) throw new RangeError(`not a D-Bus message (byte order ${buf[0]})`)
  const type = TYPE_NAMES[buf[1] as number]
  if (!type) throw new RangeError(`unknown D-Bus message type ${buf[1]}`)
  const r = new Reader(buf, le, 4)
  const bodyLen = r.u32()
  const serial = r.u32()
  const fieldsLen = r.u32()
  const end = FIXED + fieldsLen
  const m: BusMessage = { type, serial, signature: '', body: null }
  r.pad(8)
  while (r.off < end) {
    r.pad(8)
    const code = r.byte()
    const t = r.sig()
    const v = ALIGN[t] !== undefined ? r.value(t) : null
    if (v === null) throw new RangeError(`header field ${code} of type ${t}`)
    if (code === FIELDS.path) m.path = String(v)
    else if (code === FIELDS.interface) m.interface = String(v)
    else if (code === FIELDS.member) m.member = String(v)
    else if (code === FIELDS.errorName) m.errorName = String(v)
    else if (code === FIELDS.replySerial) m.replySerial = Number(v)
    else if (code === FIELDS.destination) m.destination = String(v)
    else if (code === FIELDS.sender) m.sender = String(v)
    else if (code === FIELDS.signature) m.signature = String(v)
  }
  const bodyAt = align(end, 8)
  if (bodyAt + bodyLen > buf.length) throw new RangeError('a D-Bus message cut short')
  const types = [...m.signature]
  if (types.every((t) => ALIGN[t] !== undefined)) {
    const body = new Reader(buf.subarray(bodyAt, bodyAt + bodyLen), le)
    m.body = types.map((t) => body.value(t))
  }
  return m
}

/** The session bus's socket from `DBUS_SESSION_BUS_ADDRESS` (`unix:path=…` or `unix:abstract=…`), else `$XDG_RUNTIME_DIR/bus`. */
export function sessionBusPath(env: NodeJS.ProcessEnv): string | null {
  for (const addr of (env.DBUS_SESSION_BUS_ADDRESS ?? '').split(';')) {
    const m = /^unix:(.*)$/.exec(addr.trim())
    if (!m) continue
    const kv = new Map((m[1] as string).split(',').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as const))
    const unescape = (s: string) => s.replace(/%([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    if (kv.has('path')) return unescape(kv.get('path') as string)
    if (kv.has('abstract')) return `\0${unescape(kv.get('abstract') as string)}`
  }
  return env.XDG_RUNTIME_DIR ? `${env.XDG_RUNTIME_DIR}/bus` : null
}

const BUS = { destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus' } as const

/** Whether each watched name has an owner, followed as the bus reports it. */
export interface BusNames {
  /** True or false once the bus has answered for `name`; null before, and when there is no bus. */
  has(name: string): boolean | null
  /**
   * Called when a watched name gains or loses its owner (and once for each when the first answers come), and with null
   * for each name that had an answer when the connection is lost. Returns an unsubscribe.
   */
  onChange(cb: (name: string, present: boolean | null) => void): () => void
  /** Closes the connection; nothing is called afterwards. */
  dispose(): void
}

export interface BusOptions {
  /** The bus socket (`sessionBusPath`); null: no bus, every name reads null. */
  path: string | null
  uid: number
  /** Where a failed connection or a refused message is said (once each). */
  warn?(message: string, data?: Record<string, unknown>): void
  /** A test's socket instead of `net.connect`. */
  connect?(path: string): net.Socket
}

/**
 * Watch `names` on the session bus: one connection, `Hello`, then for each name `AddMatch` (so no change is missed)
 * and `NameHasOwner`. A message bigger than `L.dbusMessageMaxBytes` or a call unanswered within `L.dbusCallTimeoutMs`
 * ends the connection; the names then read null, each listener is told, and they are not watched again (no retry: the
 * next start asks again).
 */
export function watchBusNames(names: readonly string[], o: BusOptions): BusNames {
  const owned = new Map<string, boolean>() // bounded: one per watched name (the tray host, the notification service, the idle monitor)
  const listeners = new Set<(name: string, present: boolean | null) => void>() // bounded: one per consumer in main (the tray, the report)
  const pending = new Map<number, { resolve(m: BusMessage): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>() // bounded: one per call in flight (at most 1 + 2 per watched name)
  let serial = 0
  let disposed = false
  let socket: net.Socket | null = null
  let buffered: Buffer = Buffer.alloc(0)
  let authed = false

  const set = (name: string, present: boolean) => {
    if (disposed || owned.get(name) === present) return
    owned.set(name, present)
    for (const cb of [...listeners]) cb(name, present)
  }
  const fail = (why: string, data?: Record<string, unknown>) => {
    if (disposed) return
    o.warn?.(`session bus: ${why}`, data)
    close()
  }
  const close = () => {
    socket?.destroy()
    socket = null
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('the session bus connection closed'))
    }
    pending.clear()
    // A lost connection reads as unknown, and the listeners hear it for each name that had an answer
    const known = [...owned.keys()]
    owned.clear()
    if (!disposed) for (const name of known) for (const cb of [...listeners]) cb(name, null)
  }
  const call = (member: string, signature: string, body: BusValue[]): Promise<BusMessage> =>
    new Promise((resolve, reject) => {
      if (!socket) {
        reject(new Error('no session bus'))
        return
      }
      const s = ++serial
      const timer = setTimeout(() => {
        pending.delete(s)
        reject(new Error(`${member}: no answer`))
        fail(`${member} had no answer within ${L.dbusCallTimeoutMs} ms`)
      }, L.dbusCallTimeoutMs)
      pending.set(s, { resolve, reject, timer })
      socket.write(encodeMessage({ type: 'call', serial: s, ...BUS, member, signature, body }))
    })
  const onMessage = (m: BusMessage) => {
    if ((m.type === 'return' || m.type === 'error') && m.replySerial !== undefined) {
      const p = pending.get(m.replySerial)
      if (!p) return
      pending.delete(m.replySerial)
      clearTimeout(p.timer)
      if (m.type === 'error') p.reject(new Error(`${m.errorName ?? 'error'}: ${String(m.body?.[0] ?? '')}`))
      else p.resolve(m)
      return
    }
    if (m.type === 'signal' && m.interface === BUS.interface && m.member === 'NameOwnerChanged' && m.body?.length === 3) {
      const [name, , owner] = m.body as [string, string, string]
      if (names.includes(name)) set(name, owner !== '')
    }
  }
  const onData = (chunk: Buffer) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk
    if (!authed) {
      const nl = buffered.indexOf('\r\n')
      if (nl < 0) {
        if (buffered.length > L.dbusMessageMaxBytes) fail('the authentication answer is too long')
        return
      }
      const line = buffered.toString('latin1', 0, nl)
      buffered = buffered.subarray(nl + 2)
      if (!line.startsWith('OK ')) {
        fail('authentication refused', { answer: line.slice(0, 64) })
        return
      }
      authed = true
      socket?.write('BEGIN\r\n')
      void start()
    }
    try {
      for (;;) {
        const n = messageLength(buffered)
        if (n === null) break
        if (n > L.dbusMessageMaxBytes) {
          fail('a message over the size limit', { bytes: n })
          return
        }
        if (buffered.length < n) break
        const m = decodeMessage(buffered.subarray(0, n))
        buffered = buffered.subarray(n)
        onMessage(m)
      }
    } catch (e) {
      fail('a message that does not read', { error: String(e) })
    }
  }
  const start = async () => {
    try {
      await call('Hello', '', [])
      // the match first, so an owner that changes between the two is heard
      await Promise.all(names.map((n) => call('AddMatch', 's', [`type='signal',sender='${BUS.destination}',interface='${BUS.interface}',member='NameOwnerChanged',arg0='${n}'`])))
      const answers = await Promise.all(names.map((n) => call('NameHasOwner', 's', [n])))
      answers.forEach((a, i) => {
        // a NameOwnerChanged heard meanwhile is newer than this answer
        const name = names[i] as string
        if (!owned.has(name)) set(name, a.body?.[0] === true)
      })
    } catch {
      // fail() has said why, or the connection is closing
    }
  }

  if (o.path) {
    try {
      socket = o.connect ? o.connect(o.path) : net.connect(o.path)
      socket.on('connect', () => socket?.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${Buffer.from(String(o.uid)).toString('hex')}\r\n`, 'latin1')])))
      socket.on('data', onData)
      socket.on('error', (e) => fail('the connection failed', { error: String(e) }))
      socket.on('close', () => {
        if (!disposed && socket) fail('the connection closed')
      })
    } catch (e) {
      fail('no connection', { error: String(e) })
    }
  }

  return {
    has: (name) => owned.get(name) ?? null,
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      close()
    },
  }
}
