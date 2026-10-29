// A window's one-time hints through core as main.ts assembles it: `hints.once` says a hint is due the first time it is
// asked for its KEA_HOME and never again, across a restart of Kea, with the answer kept in the database.

import { hintShownKey } from '@kea/protocol'
import { kvGet } from '@kea/core/src/platform/db/db.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { ptyhostHarness, testEnv, type Harness } from '../support/holders.ts'
import { ownPtyIds, startFullCore, type FullCoreUnderTest } from './core-support.ts'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function harness(): Promise<Harness> {
  const h = await ptyhostHarness()
  cleanup.push(async () => {
    for (const id of ownPtyIds(h.home)) h.spawned.add(id)
    await h.dispose()
  })
  return h
}

function core(h: Harness): FullCoreUnderTest {
  const c = startFullCore(h, { env: testEnv() })
  cleanup.push(() => c.dispose())
  return c
}

describe('one-time hints', () => {
  it('I-TERM-2 · the copy hint is due the first time a window asks for its KEA_HOME, then never again, across a restart of Kea', async () => {
    const h = await harness()
    let c = core(h)
    await c.reconciled()
    expect(kvGet(c.core.db, hintShownKey('ctrlCopy')), 'nothing recorded before it is asked').toBeUndefined()
    expect(await c.call('hints.once', { hint: 'ctrlCopy' })).toEqual({ show: true })
    expect(kvGet(c.core.db, hintShownKey('ctrlCopy')), 'recorded for this home').toBeDefined()
    // a second window, or the same one again
    expect(await c.call('hints.once', { hint: 'ctrlCopy' })).toEqual({ show: false })

    // Kea again: the database keeps it
    c.dispose()
    h.stop()
    await h.restart()
    c = core(h)
    await c.reconciled()
    expect(await c.call('hints.once', { hint: 'ctrlCopy' })).toEqual({ show: false })
  })
})
