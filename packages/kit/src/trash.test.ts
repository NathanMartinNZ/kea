import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CrossDeviceError, emptyTrash, emptyTrashEntry, moveToTrash } from './trash.ts'

let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'kea-kit-trash-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeTree(name: string): string {
  const dir = join(tmp, name)
  fs.mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(join(dir, 'file.txt'), 'content')
  fs.writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x')
  return dir
}

describe('moveToTrash', () => {
  it('U-WT-10 · renames into a 0700 trash dir: same inode, original path gone at once', async () => {
    const dir = makeTree('wt-a')
    const ino = fs.statSync(dir).ino
    const trashDir = join(tmp, 'root', '.trash')
    const dest = await moveToTrash(dir, trashDir)
    expect(fs.existsSync(dir)).toBe(false)
    expect(dest.startsWith(`${trashDir}/`)).toBe(true)
    expect(fs.statSync(dest).ino).toBe(ino) // a rename, not a copy
    expect(fs.readFileSync(join(dest, 'file.txt'), 'utf8')).toBe('content')
    expect(fs.statSync(trashDir).mode & 0o777).toBe(0o700)

    const second = await moveToTrash(makeTree('wt-a'), trashDir)
    expect(second).not.toBe(dest)
    expect(fs.readdirSync(trashDir)).toHaveLength(2)
  })

  it('U-WT-10 · a cross-volume rename surfaces as CrossDeviceError and nothing is copied', async () => {
    const dir = makeTree('wt-b')
    const trashDir = join(tmp, 'xdev', '.trash')
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }))
    const err = await moveToTrash(dir, trashDir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CrossDeviceError)
    expect((err as CrossDeviceError).code).toBe('EXDEV')
    expect(fs.existsSync(join(dir, 'file.txt'))).toBe(true)
    expect(fs.readdirSync(trashDir)).toEqual([])
  })

  it('U-WT-10 · other rename errors are rethrown unchanged', async () => {
    await expect(moveToTrash(join(tmp, 'missing'), join(tmp, 'm', '.trash'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('emptyTrashEntry', () => {
  it('U-WT-10 · deletes a trash entry at background priority; emptyTrash clears what moveToTrash put there, nothing else', async () => {
    const trashDir = join(tmp, 'e', '.trash')
    const a = await moveToTrash(makeTree('wt-c'), trashDir)
    await emptyTrashEntry(a)
    expect(fs.existsSync(a)).toBe(false)
    await moveToTrash(makeTree('wt-d'), trashDir)
    await moveToTrash(makeTree('wt-e'), trashDir)
    fs.writeFileSync(join(trashDir, 'not-keas.txt'), 'x')
    expect(await emptyTrash(trashDir)).toBe(2)
    expect(fs.readdirSync(trashDir), 'only what moveToTrash put there goes').toEqual(['not-keas.txt'])
    expect(await emptyTrash(join(tmp, 'never-created'))).toBe(0)
  })

  it('U-WT-10 · refuses relative, root-level and un-normalised paths', async () => {
    await expect(emptyTrashEntry('relative/path')).rejects.toThrow('refusing')
    await expect(emptyTrashEntry('/')).rejects.toThrow('refusing')
    await expect(emptyTrashEntry('/Users')).rejects.toThrow('refusing')
    await expect(emptyTrashEntry(`${tmp}/x/../..`)).rejects.toThrow('refusing')
  })
})
