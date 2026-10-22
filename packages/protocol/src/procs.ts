// `kea-helper procs [--args] [<pid>…]`: this user's processes, one line each, on both systems. The helper's `procs.rs`
// writes the lines; this is their one reader, for every `ps` Kea ran before: core's holder liveness, the pruning of old
// helper copies and the install tool's process list.
//
// A line is tab-separated: pid, ppid, start time in µs since the epoch (on Linux followed by `/` and the raw start in
// clock ticks since boot), the executable file (`-` when it cannot be read), `argv[0]`, and with `--args` every
// further argument. `\\`, `\t`, `\n` and `\xHH` (any other control byte, and
// a byte that is no UTF-8) are escapes, so a line is one line of UTF-8 whatever the process was started with.

/** One process as `kea-helper procs` lists it. */
export interface ProcRow {
  pid: number
  ppid: number
  /** Start time, µs since the epoch. */
  startUs: number
  /** Linux: the raw start, clock ticks since boot (`/proc/<pid>/stat`'s `starttime`); null where there is none. */
  startTicks: number | null
  /** The executable file, in full; null when it cannot be read (a zombie, or a file that is gone). */
  exe: string | null
  /**
   * `argv[0]` (what `ps -o comm` printed on macOS: the path the process was started by) and, with `--args`, every
   * further argument; empty when they cannot be read.
   */
  argv: string[]
}

const DIGITS = /^\d+$/
/** The start field: µs since the epoch, then on Linux `/` and the raw ticks. */
const START = /^(\d+)(?:\/(\d+))?$/
const HEX2 = /^[0-9a-fA-F]{2}$/
const utf8 = new TextEncoder()
// bytes that are no UTF-8 become U+FFFD: such a path names no file, which every caller takes as "cannot tell"
const text = new TextDecoder()

/** One field, its escapes undone. */
function unescapeField(field: string): string {
  if (!field.includes('\\')) return field
  const bytes: number[] = []
  for (let i = 0; i < field.length; i++) {
    if (field[i] === '\\') {
      const next = field[i + 1]
      const hex = field.slice(i + 2, i + 4)
      const byte = next === '\\' ? 0x5c : next === 't' ? 0x09 : next === 'n' ? 0x0a : next === 'x' && HEX2.test(hex) ? parseInt(hex, 16) : null
      if (byte !== null) {
        bytes.push(byte)
        i += next === 'x' ? 3 : 1
        continue
      }
    }
    const cp = field.codePointAt(i)!
    for (const b of utf8.encode(String.fromCodePoint(cp))) bytes.push(b)
    if (cp > 0xffff) i++
  }
  return text.decode(new Uint8Array(bytes))
}

/** The rows of `kea-helper procs` output, in its order; a line that is not one (too few fields, no numbers) is skipped. */
export function parseProcs(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const f = line.split('\t')
    const [pid, ppid, start, exe] = f
    const st = START.exec(start ?? '')
    if (exe === undefined || !DIGITS.test(pid!) || !DIGITS.test(ppid!) || !st) continue
    const row = { pid: Number(pid), ppid: Number(ppid), startUs: Number(st[1]), startTicks: st[2] === undefined ? null : Number(st[2]) }
    if (row.pid <= 0 || !Number.isSafeInteger(row.startUs) || !(row.startTicks === null || Number.isSafeInteger(row.startTicks))) continue
    rows.push({ ...row, exe: exe === '-' ? null : unescapeField(exe), argv: f.slice(4).map(unescapeField) })
  }
  return rows
}
