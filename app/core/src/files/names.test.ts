// File names as file operations take them: a name written decomposed (NFD), as a Mac's file system hands names to a
// sync tool or an archive, listed, opened and discarded. APFS ignores normalisation, so macOS takes every name as NFC;
// ext4 keeps a name's bytes, and there two spellings are two files.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gitText, nameKey } from '@kea/kit'
import { describe, expect, it } from 'vitest'
import { coreOs } from '../os/index.ts'
import { readFile } from '../viewer/read.ts'
import { discardFile } from './discard.ts'
import { listDirectory } from './listing.ts'

const NFD = 'Café.txt'
const NFC = 'Café.txt'
const env = { PATH: process.env.PATH, HOME: '', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

describe('file names', () => {
  it('U-PLT-8 · names kept as stored, NFC only in keys: a name written decomposed is listed, opened and discarded by its own bytes on Linux, beside its composed twin; macOS takes it as NFC', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-plt-8-')))
    try {
      const repo = path.join(tmp, 'repo')
      fs.mkdirSync(repo)
      await gitText(['init', '-q', '-b', 'main'], { cwd: repo, env })
      fs.writeFileSync(path.join(repo, NFD), 'decomposed\n')
      const linux = coreOs.system === 'linux'
      // Linux: the composed spelling is another file; macOS: the same one, so it is not written there
      if (linux) fs.writeFileSync(path.join(repo, NFC), 'composed\n')

      // listed
      const names = (await listDirectory(repo))!.entries.map((e) => e.name)
      expect([...names].sort()).toEqual(linux ? [NFC, NFD].sort() : [NFC])
      const listed = names.find((n) => n.normalize('NFD') === n && nameKey(n) === NFC)
      expect(listed, 'the decomposed name is listed').toBe(linux ? NFD : undefined)
      const name = linux ? NFD : NFC

      // opened, by the name the listing gave
      const read = await readFile(repo, name)
      const text = (r: Awaited<ReturnType<typeof readFile>>): string | null => (r.text ? Buffer.from(r.text.bytes).toString('utf8') : null)
      expect([read.kind, text(read)]).toEqual(['text', 'decomposed\n'])
      if (linux) expect(text(await readFile(repo, NFC))).toBe('composed\n')

      // discarded (untracked: to the trash): the tool is given the file's own bytes, and the twin stays
      const given = path.join(tmp, 'given')
      const tool = path.join(tmp, 'trash')
      fs.writeFileSync(tool, `#!/bin/sh\nfor a; do last=$a; done\nprintf '%s' "$last" > '${given}'\nexec /bin/rm -- "$last"\n`, { mode: 0o755 })
      expect(await discardFile({ root: repo, rel: name, base: null, expect: 'trash', env, trashTool: tool })).toEqual({ ok: true, did: 'trash' })
      expect(path.basename(fs.readFileSync(given, 'utf8'))).toBe(name)
      expect((await listDirectory(repo))!.entries.map((e) => e.name)).toEqual(linux ? [NFC] : [])
      if (linux) expect(fs.readFileSync(path.join(repo, NFC), 'utf8')).toBe('composed\n')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
