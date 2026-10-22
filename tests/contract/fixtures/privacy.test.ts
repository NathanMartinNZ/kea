// Fixture privacy: no committed fixture holds a secret, the developer's identity or anyone's home folder, and the
// recorders' guard (tools/scrubber) refuses to record outside a demo repo or with a prompt that is not a demo prompt.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertRecordable,
  currentIdentity,
  FIXTURE_REPO_MARKER,
  fixtureFiles,
  isEnvFile,
  NotRecordableError,
  scanForPrivateData,
} from '../../../tools/scrubber/src/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('fixture privacy', () => {
  it('K-FX-8 · no committed fixture matches a secret pattern or holds the developer\'s home path, user name, host, name or email, or anyone else\'s home folder', () => {
    const identity = currentIdentity(root)
    expect(identity.home, 'the scan needs the developer identity').toBeTruthy()
    const hits: string[] = []
    const files = fixtureFiles(join(root, 'fixtures')) // everything except the gitignored .raw/ folders
    for (const f of files) {
      for (const x of scanForPrivateData(readFileSync(f), { identity, envFile: isEnvFile(f) })) {
        const fix = x.label === 'home folder' ? 'name a placeholder home (/Users/HOME___) or kea-test instead' : 'run `pnpm fixtures:scrub` on its raw recording'
        hits.push(`${relative(root, f)}:${x.line} ${x.kind}: ${x.label} — ${fix}`)
      }
    }
    expect(hits).toEqual([])
  })

  // made when the tests run, not when the file is collected: a run filtered to other tests runs no afterAll here
  let tmp = ''
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kea-kfx8-'))
  })
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })
  const prompt = 'add a README section describing the project'

  it('K-FX-8 · every recorder refuses to run outside a .kea-fixture-repo demo repo or with a non-demo prompt', () => {
    // the kea repo itself (and so any of the developer's own projects) is refused
    expect(() => assertRecordable({ cwd: root, prompt })).toThrow(NotRecordableError)
    // a repo without the marker is refused; a repo-factory repo with a demo prompt is allowed
    const plain = join(tmp, 'plain')
    mkdirSync(join(plain, '.git'), { recursive: true })
    expect(() => assertRecordable({ cwd: plain, prompt })).toThrow(/\.kea-fixture-repo/)
    const demo = join(tmp, 'demo')
    mkdirSync(join(demo, '.git'), { recursive: true })
    writeFileSync(join(demo, FIXTURE_REPO_MARKER), '')
    expect(() => assertRecordable({ cwd: demo, prompt })).not.toThrow()
    expect(() => assertRecordable({ cwd: demo, prompt: 'summarise everything in my home folder' })).toThrow(NotRecordableError)
  })
})
