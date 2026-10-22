import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { createMemoryLogger } from '@kea/kit'
import { isAvailable } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type KeaDb } from '../platform/db/db.ts'
import { findGit } from '../worktrees/git.ts'
import { coreOs } from '../os/index.ts'
import { Projects } from './projects.ts'

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

function tempDir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-projects-test-')))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function memory(): KeaDb {
  const { db } = openDatabase({ file: ':memory:', log: createMemoryLogger({ process: 'core' }) })
  cleanup.push(() => db.abandon())
  return db
}

function projects(db: KeaDb, gitReady: Promise<boolean> = Promise.resolve(false)): Projects {
  let t = 0
  const p = new Projects({ db, log: createMemoryLogger({ process: 'core' }), gitReady, now: () => ++t })
  cleanup.push(() => p.dispose())
  return p
}

describe('projects', () => {
  it('U-PRJ-1 · manual order: any sequence of moves gives the order an array would, also once the gaps between neighbours run out', async () => {
    const root = tempDir()
    const db = memory()
    const p = projects(db)
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const dir = path.join(root, `p${i}`)
      fs.mkdirSync(dir)
      ids.push((await p.add(dir)).project.id)
    }
    expect(p.list().map((x) => x.id)).toEqual(ids)
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.nat(5), fc.integer({ min: -1, max: 7 })), { minLength: 1, maxLength: 80 }), async (moves) => {
        const model = p.list().map((x) => x.id)
        for (const [which, index] of moves) {
          const id = model[which]!
          model.splice(model.indexOf(id), 1)
          model.splice(Math.max(0, Math.min(index, model.length)), 0, id)
          await p.move(id, index)
        }
        expect(p.list().map((x) => x.id)).toEqual(model)
        // what the store shows is what the database has
        expect(db.all<{ id: string }>('SELECT id FROM projects ORDER BY sort_order, created_at').map((r) => r.id)).toEqual(model)
      }),
      { numRuns: 60 },
    )
    // the same slot between two neighbours, again and again: halving runs out of floating-point room and renumbers
    for (let i = 0; i < 80; i++) await p.move(p.list()[5]!.id, 1)
    const orders = p.list().map((x) => x.sortOrder)
    expect(new Set(orders).size, 'no two projects share a place').toBe(orders.length)
  })

  it.runIf(isAvailable(coreOs.gitProbe))('U-PRJ-2 · without git a repository opens as a plain folder; the first executable git on the login PATH is the one used', async () => {
    const dir = tempDir()
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'src'))
    const p = projects(memory(), Promise.resolve(false))
    expect(await p.add(path.join(repo, 'src'))).toMatchObject({ registered: 'asGiven', project: { isGit: false, rootPath: path.join(repo, 'src'), name: 'src' } })

    // PATH order wins; a git that is not executable, or not a file, is skipped
    const [a, b, c] = ['a', 'b', 'c'].map((n) => path.join(dir, n))
    for (const d of [a!, b!, c!]) fs.mkdirSync(d)
    fs.writeFileSync(path.join(a!, 'git'), '#!/bin/sh\n', { mode: 0o644 })
    fs.mkdirSync(path.join(b!, 'git'))
    fs.writeFileSync(path.join(c!, 'git'), '#!/bin/sh\n', { mode: 0o755 })
    expect(await findGit([a, 'relative/dir', b, c].join(':'))).toEqual({ binary: path.join(c!, 'git'), missing: null })
  })
})
