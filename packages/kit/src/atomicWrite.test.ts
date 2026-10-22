import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { atomicWrite, atomicWriteSync } from './atomicWrite.ts'

let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'kea-kit-atomic-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function freshDir(name: string): string {
  const d = join(tmp, name)
  fs.mkdirSync(d)
  return d
}

const variants = [
  ['sync', async (p: string, d: string | Uint8Array, o?: { mode?: number }) => atomicWriteSync(p, d, o)],
  ['async', (p: string, d: string | Uint8Array, o?: { mode?: number }) => atomicWrite(p, d, o)],
] as const

describe.each(variants)('atomicWrite (%s)', (name, write) => {
  it('U-ATOMIC-1 · writes the content with the requested mode and leaves no temp file', async () => {
    const dir = freshDir(`ok-${name}`)
    const p = join(dir, 'state.json')
    await write(p, '{"a":1}', { mode: 0o600 })
    expect(fs.readFileSync(p, 'utf8')).toBe('{"a":1}')
    expect(fs.statSync(p).mode & 0o777).toBe(0o600)
    await write(p, new Uint8Array([104, 105]))
    expect(fs.readFileSync(p, 'utf8')).toBe('hi')
    expect(fs.statSync(p).mode & 0o777).toBe(0o600) // existing mode kept when none is given
    expect(fs.readdirSync(dir)).toEqual(['state.json'])
  })

  it('U-ATOMIC-1 · a failed rename leaves the old content and no temp file behind', async () => {
    const dir = freshDir(`fail-${name}`)
    const p = join(dir, 'state.json')
    fs.writeFileSync(p, 'old')
    if (name === 'sync') vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) })
    else vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }))
    await expect(write(p, 'new')).rejects.toThrow('EIO')
    expect(fs.readFileSync(p, 'utf8')).toBe('old')
    expect(fs.readdirSync(dir)).toEqual(['state.json'])
  })

  it('U-ATOMIC-1 · a real failure (target is a directory) cleans up the temp file', async () => {
    const dir = freshDir(`isdir-${name}`)
    const target = join(dir, 'target')
    fs.mkdirSync(join(target, 'sub'), { recursive: true })
    await expect(write(target, 'x')).rejects.toThrow()
    expect(fs.readdirSync(dir)).toEqual(['target'])
    await expect(write(join(dir, 'missing', 'f'), 'x')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
