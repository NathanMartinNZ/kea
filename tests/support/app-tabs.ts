// The main area's file and diff tabs in a running Kea, for the app-level suites: the strip and the viewer's mount read
// from the DOM as a person sees them, a tab clicked or pinned as a person does it, and `openFile`, a probe that runs
// `viewer.open` without the tree, the Changes list or the finder. The probe is for setting up a suite whose subject is
// something else (a leak cycle, a timing) and for the strip's own rules; a test about opening a file clicks its row
// (tests/support/app-files.ts `clickFile`, `clickChange`).

import type { OpenRequest } from '@kea/protocol'
import type { Locator, Page } from '@playwright/test'
import { STEP_MS, until, type Kea, type KeaProbe } from './app.ts'

declare const __keaProbe: KeaProbe

export interface FileTabProbe {
  path: string
  /** `file` or `diff`. */
  kind: string
  pinned: boolean
  selected: boolean
}

/** A file or diff tab of the session on screen, by its path (`tablist` "Open files"). */
export function fileTab(page: Page, path: string): Locator {
  return page.locator(`[role=tablist][aria-label="Open files"] [role=tab][data-path=${JSON.stringify(path)}]`)
}

/** Click a file tab, as a person switches to it; resolves once the viewer shows that file. */
export async function clickFileTab(kea: Kea, path: string): Promise<void> {
  await fileTab(await kea.page(), path).click({ timeout: STEP_MS })
  await until(`the tab of ${path} on screen`, async () => (await viewerShown(kea))?.path === path || undefined)
}

/** Pin a file tab with a double-click on it; resolves once the strip shows it pinned. */
export async function pinFileTab(kea: Kea, path: string): Promise<void> {
  const tab = fileTab(await kea.page(), path)
  await tab.dblclick({ timeout: STEP_MS })
  await until(`the tab of ${path} pinned`, async () => (await tab.getAttribute('data-pinned')) === 'true' || undefined)
}

/** Probe: run `viewer.open` with `req`; false when the command was not available (the session is not on screen). */
export async function openFile(kea: Kea, req: OpenRequest): Promise<boolean> {
  return (await kea.page()).evaluate((r) => __keaProbe.run('viewer.open', r), req)
}

/** The file and diff tabs of the session on screen, in the strip's order (`tablist` "Open files"). */
export async function fileTabs(kea: Kea): Promise<FileTabProbe[]> {
  return (await kea.page()).locator('[role=tablist][aria-label="Open files"] [role=tab]').evaluateAll((els) =>
    els.map((e) => ({
      path: e.getAttribute('data-path') ?? '',
      kind: e.getAttribute('data-kind') ?? '',
      pinned: e.getAttribute('data-pinned') === 'true',
      selected: e.getAttribute('aria-selected') === 'true',
    })),
  )
}

/** What the viewer's mount shows (the active file or diff tab), and whether the keyboard is in it; null while a terminal shows. */
export async function viewerShown(kea: Kea): Promise<{ path: string; mode: string; focused: boolean } | null> {
  return (await kea.page()).evaluate(() => {
    const m = document.querySelector('.viewer-mount')
    return m ? { path: m.getAttribute('data-path') ?? '', mode: m.getAttribute('data-mode') ?? '', focused: m.contains(document.activeElement) } : null
  })
}
