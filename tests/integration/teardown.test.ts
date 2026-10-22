// The integration suite's own teardown (global-setup.ts): it ends the holders its invocation left behind and fails on
// them, and it never signals a holder of anyone else — another Vitest invocation (a memory, chaos or perf run going on
// at the same time) or the installed app — whose holders start while it runs.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RUN_TAG_ENV } from '../support/helpers.ts'
import { holderAlive, ptyhostHarness, type Harness } from '../support/holders.ts'
import setup from './global-setup.ts'

/** A harness whose homes carry `tag` (set only while it is made: the home is named then). */
async function harnessTagged(tag: string): Promise<Harness> {
  const was = process.env[RUN_TAG_ENV]
  process.env[RUN_TAG_ENV] = tag
  try {
    return await ptyhostHarness()
  } finally {
    process.env[RUN_TAG_ENV] = was
  }
}

describe('integration teardown', () => {
  it("I-HARN-1 · the teardown kills only its own invocation's strays, by identity, and fails on them; a holder another run started meanwhile is untouched", async () => {
    const was = process.env[RUN_TAG_ENV] as string
    const teardown = setup() // a nested invocation: its own tag from here on
    const tag = process.env[RUN_TAG_ENV] as string
    process.env[RUN_TAG_ENV] = was
    expect(tag).not.toBe(was)
    const other = await harnessTagged(`${was}x`) // another run, started while the nested one runs
    try {
      const theirs = await other.spawn({ argv: ['/bin/cat'] })
      const mine = await harnessTagged(tag)
      const left = await mine.spawn({ argv: ['/bin/cat'] })
      mine.stop() // ptyhost goes, its holder stays: a stray of the nested run
      expect(holderAlive(mine.home, left.ptyId)).toBe(true)

      const failed = await (async () => teardown())().then(() => null, (e: Error) => e.message)
      expect(holderAlive(other.home, theirs.ptyId), "another run's holder is untouched").toBe(true)
      expect(theirs.isRunning).toBe(true)
      expect(failed, 'the run fails on its own stray, and names only it').toMatch(new RegExp(`still alive[^]*${mine.home}`))
      expect(failed).not.toContain(other.home)
      expect(holderAlive(mine.home, left.ptyId), 'its own stray is killed').toBe(false)
      expect(fs.existsSync(mine.home), 'and its home removed').toBe(false)
    } finally {
      await other.dispose()
    }
  })
})
