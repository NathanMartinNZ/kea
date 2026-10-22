// Fixtures of the e2e suite: `launch` starts Kea on the test's own KEA_HOME (tests/support/app.ts: unfocused, temp
// home, identity-checked signals) and records a Playwright trace of each instance; a failed test keeps that trace and
// a screenshot of each instance's window. Afterwards the run is disposed: every process it started is ended and its
// directories removed, or the test fails.

import { test as base } from '@playwright/test'
import { KeaRun, type Kea } from '../support/app.ts'

export { expect } from '@playwright/test'

type Fixtures = {
  run: KeaRun
  launch: (o?: Parameters<KeaRun['launch']>[0]) => Promise<Kea>
}

export const test = base.extend<Fixtures>({
  run: async ({}, use) => {
    const run = KeaRun.create()
    try {
      await use(run)
    } finally {
      await run.dispose()
    }
  },
  launch: async ({ run }, use, info) => {
    const keas: Kea[] = [] // bounded: the instances one test launches (a handful)
    await use(async (o) => {
      const kea = await run.launch(o)
      keas.push(kea)
      await kea.app
        .context()
        .tracing.start({ screenshots: true, snapshots: true, title: info.title })
        .catch(() => undefined)
      return kea
    })
    const failed = info.status !== info.expectedStatus
    for (const [i, kea] of keas.entries()) {
      if (failed) {
        const page = kea.app.windows()[0]
        if (page) await info.attach(`window-${i}.png`, { body: await page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' })
        const trace = info.outputPath(`trace-${i}.zip`)
        await kea.app
          .context()
          .tracing.stop({ path: trace })
          .then(() => info.attachments.push({ name: `trace-${i}`, path: trace, contentType: 'application/zip' }))
          .catch(() => undefined)
      } else {
        await kea.app
          .context()
          .tracing.stop()
          .catch(() => undefined)
      }
    }
  },
})
