import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlTailer, parseLine, readTail } from './jsonl.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt17-'))
  dirs.push(d)
  return path.join(d, 't.jsonl')
}
const line = (i: number, pad = 0) => JSON.stringify({ i, pad: 'x'.repeat(pad) })

describe('adapters/kit JSONL tailer', () => {
  it('U-AGT-17 · reconcile reads at most the tail cap; a watcher resumes at its last offset, reads only what was appended, in capped reads', () => {
    const file = tmp()
    // a transcript three caps long
    const big = Array.from({ length: Math.ceil((3 * L.transcriptTailBytes) / 1000) }, (_, i) => line(i, 980)).join('\n') + '\n'
    fs.writeFileSync(file, big)
    const tail = readTail(file)!
    expect(tail.bytesRead).toBeLessThanOrEqual(L.transcriptTailBytes)
    expect(tail.size).toBe(Buffer.byteLength(big))
    // complete lines only: the cut first line is dropped, the last one is whole
    for (const l of tail.lines) expect(parseLine(l)).not.toBeNull()
    expect(parseLine(tail.lines.at(-1)!)?.i).toBe(Math.ceil((3 * L.transcriptTailBytes) / 1000) - 1)
    // a small read cap for the watcher
    const t = new JsonlTailer(file, { maxReadBytes: 4096 })
    expect(t.position).toBe(Buffer.byteLength(big)) // starts at the end
    expect(t.read()).toEqual([])
    fs.appendFileSync(file, `${line(-1)}\n${line(-2)}\n`)
    expect(t.read().map((l) => parseLine(l)?.i)).toEqual([-1, -2])
    expect(t.bytesRead).toBe(Buffer.byteLength(`${line(-1)}\n${line(-2)}\n`))
    // a burst bigger than the cap: one capped read at a time, nothing lost or repeated
    const burst = Array.from({ length: 40 }, (_, i) => line(100 + i, 300))
    fs.appendFileSync(file, burst.join('\n') + '\n')
    const got: number[] = []
    let reads = 0
    while (t.behind) {
      const before = t.bytesRead
      got.push(...t.read().map((l) => parseLine(l)!.i as number))
      expect(t.bytesRead - before).toBeLessThanOrEqual(4096)
      reads++
    }
    expect(got).toEqual(burst.map((_, i) => 100 + i))
    expect(reads).toBeGreaterThan(1)
    // a partial line waits for its newline
    fs.appendFileSync(file, '{"i":7')
    expect(t.read()).toEqual([])
    fs.appendFileSync(file, '}\n')
    expect(t.read()).toEqual(['{"i":7}'])
    // a line longer than the cap is skipped whole; the next one is read
    fs.appendFileSync(file, `${line(8, 10_000)}\n${line(9)}\n`)
    const after: string[] = []
    while (t.behind) after.push(...t.read())
    expect(after.map((l) => parseLine(l)?.i)).toEqual([9])
    // a new tailer resumes where it is told
    const t2 = new JsonlTailer(file, { from: t.position })
    fs.appendFileSync(file, `${line(10)}\n`)
    expect(t2.read().map((l) => parseLine(l)?.i)).toEqual([10])
    // rewritten (shorter): followed from its new end
    fs.writeFileSync(file, `${line(11)}\n`)
    expect(t2.read()).toEqual([])
    fs.appendFileSync(file, `${line(12)}\n`)
    expect(t2.read().map((l) => parseLine(l)?.i)).toEqual([12])
    expect(readTail('/nonexistent/x')).toBeNull()
  })

  it('U-AGT-29 · a multi-byte character split between two reads (a title, a prompt) is decoded whole, not as U+FFFD', () => {
    const file = tmp()
    fs.writeFileSync(file, '')
    const t = new JsonlTailer(file, { from: 0, maxReadBytes: 64 })
    const title = 'Réparer les tests — 修复 🦜'
    const text = `${JSON.stringify({ type: 'ai-title', aiTitle: title })}\n`
    const bytes = Buffer.from(text)
    // every cut inside a character: a read ends mid-character, the next one starts there
    for (let cut = 1; cut < bytes.length; cut++) {
      const at = fs.statSync(file).size
      fs.appendFileSync(file, bytes.subarray(0, cut))
      const first = t.read()
      fs.appendFileSync(file, bytes.subarray(cut))
      const lines = [...first]
      while (t.behind || lines.length === 0) {
        const got = t.read()
        if (got.length === 0 && !t.behind) break
        lines.push(...got)
      }
      expect(lines.map((l) => parseLine(l)?.aiTitle), `cut at byte ${cut} of the line starting at ${at}`).toEqual([title])
    }
  })
})
