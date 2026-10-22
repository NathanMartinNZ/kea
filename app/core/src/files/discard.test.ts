// Discard Changes on one file, the parts a unit can show with a real git and no window: what a system without its
// `trash` tool gets (a Mac before macOS 15; Linux without GLib's gio). The integration tests I-FT-17…21 cover the rest
// of the action.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gitText } from '@kea/kit'
import { isAvailable, need } from '@kea/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreOs } from '../os/index.ts'
import { discardFile, trashToolFor } from './discard.ts'

let tmp: string
let repo: string
let base: string
/** Hermetic git: no user or system config. */
const env = { PATH: process.env.PATH, HOME: '', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Kea Test', GIT_AUTHOR_EMAIL: 'test@kea.invalid', GIT_COMMITTER_NAME: 'Kea Test', GIT_COMMITTER_EMAIL: 'test@kea.invalid' }
const g = (...args: string[]) => gitText(args, { cwd: repo, env })
const write = (rel: string, data: string) => fs.writeFileSync(path.join(repo, rel), data)
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8')

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-discard-')))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  await g('init', '-q', '-b', 'main')
  write('tracked.txt', 'as committed\n')
  write('gone.txt', 'as committed\n')
  await g('add', '-A')
  await g('commit', '-q', '-m', 'base')
  base = (await g('rev-parse', 'HEAD')).trim()
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('Discard Changes without the system’s trash tool', () => {
  it.runIf(isAvailable(coreOs.trash))('U-FT-21 · on a Mac without the `trash` tool (none named, or no executable where it is looked for) a file that would go to the Trash is refused as `noTrash` and left exactly as it was, on disk and in the index; putting a tracked file back needs no tool and still works', async () => {
    // where it is looked for: the system's (macOS's trash; Linux's gio), or only the test run's own folder
    expect(trashToolFor(null)).toBe(coreOs.system === 'darwin' ? '/usr/bin/trash' : '/usr/bin/gio') // os-ok: each system's answer from its OS layer
    expect(trashToolFor('/x/sandbox')).toBe('/x/sandbox/bin/trash')
    // the refusal: macOS's says nothing more (the window names the macOS version); Linux's names the tool it needs
    const missing = need(coreOs.trash).missing
    if (coreOs.system === 'darwin') expect(missing).toBeNull()
    else expect(missing).toMatch(/gio/)
    const noTrash = missing === null ? { ok: false, refused: 'noTrash' } : { ok: false, refused: 'noTrash', detail: missing }

    write('new.txt', 'untracked\n')
    write('added.txt', 'added since\n')
    await g('add', '--', 'added.txt')
    const index = await g('ls-files', '-s')
    const notATool = path.join(tmp, 'trash') // there, but not executable
    fs.writeFileSync(notATool, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    for (const trashTool of [null, path.join(tmp, 'absent', 'trash'), notATool, tmp]) {
      for (const rel of ['new.txt', 'added.txt']) {
        expect(await discardFile({ root: repo, rel, base, expect: 'trash', env, trashTool })).toEqual(noTrash)
      }
      expect(read('new.txt')).toBe('untracked\n')
      expect(read('added.txt')).toBe('added since\n')
      expect(await g('ls-files', '-s')).toBe(index)
    }

    // what does not go to the Trash needs no tool: a modified file and a deleted one are put back as the base has them
    write('tracked.txt', 'edited\n')
    fs.rmSync(path.join(repo, 'gone.txt'))
    expect(await discardFile({ root: repo, rel: 'tracked.txt', base, expect: 'restore', env, trashTool: null })).toEqual({ ok: true, did: 'restore' })
    expect(await discardFile({ root: repo, rel: 'gone.txt', base, expect: 'restore', env, trashTool: null })).toEqual({ ok: true, did: 'restore' })
    expect(read('tracked.txt')).toBe('as committed\n')
    expect(read('gone.txt')).toBe('as committed\n')
  })
})
