// Reading an `app.asar`: the list of its files and one file's bytes, with no dependency. The format is a header, then
// the files end to end:
//   bytes 0–3   4 (the size of the next field)        bytes 4–7    the header's size
//   bytes 8–11  the header's payload size             bytes 12–15  the length of its JSON
//   bytes 16…   the JSON: `{ files: { <name>: { files: … } | { size, offset, unpacked? } | { link } } }`
// A packed file's bytes start at `8 + header size + offset`; an unpacked one (`unpacked: true`) lives beside the
// archive, in `app.asar.unpacked/`.

import fs from 'node:fs'

export interface AsarEntry {
  /** Path inside the archive, `/`-separated. */
  name: string
  size: number
  /** Where the bytes start in the archive; null when the file is unpacked. */
  at: number | null
  unpacked: boolean
}

type Node = { files?: Record<string, Node>; size?: number; offset?: string; unpacked?: boolean; link?: string }

const PREFIX_BYTES = 16

/** The files of the archive at `file` (links are left out). Throws when it is not an asar. */
export function asarEntries(file: string): AsarEntry[] {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(PREFIX_BYTES)
    if (fs.readSync(fd, head, 0, PREFIX_BYTES, 0) !== PREFIX_BYTES || head.readUInt32LE(0) !== 4) throw new Error(`${file} is not an asar archive`)
    const headerSize = head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    const size = fs.fstatSync(fd).size
    if (jsonLength > headerSize || PREFIX_BYTES + jsonLength > size) throw new Error(`${file}: its header does not fit the file`)
    const json = Buffer.alloc(jsonLength)
    fs.readSync(fd, json, 0, jsonLength, PREFIX_BYTES)
    const root = JSON.parse(json.toString('utf8')) as Node
    const base = 8 + headerSize
    const out: AsarEntry[] = []
    const walk = (n: Node, dir: string): void => {
      for (const [k, v] of Object.entries(n.files ?? {})) {
        const name = dir ? `${dir}/${k}` : k
        if (v.files) walk(v, name)
        else if (typeof v.size === 'number') out.push({ name, size: v.size, at: v.unpacked === true ? null : base + Number(v.offset ?? 0), unpacked: v.unpacked === true })
      }
    }
    walk(root, '')
    return out
  } finally {
    fs.closeSync(fd)
  }
}

/** The bytes of the packed file `name` in the archive at `file`; null when it is not there or is unpacked. */
export function asarFile(file: string, name: string, entries: readonly AsarEntry[] = asarEntries(file)): Buffer | null {
  const e = entries.find((x) => x.name === name)
  if (!e || e.at === null) return null
  const fd = fs.openSync(file, 'r')
  try {
    const out = Buffer.alloc(e.size)
    if (fs.readSync(fd, out, 0, e.size, e.at) !== e.size) throw new Error(`${file}: ${name} is cut short`)
    return out
  } finally {
    fs.closeSync(fd)
  }
}
