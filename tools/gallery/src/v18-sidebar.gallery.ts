// V-18: the sidebar's colours and widths. One project's seven sessions in every status, each drawn in its session's
// colour where the glyph takes one (the palette wraps at the sixth), a second project's first session sharing the
// first colour, the idle and detached rings large; then the sidebar at its minimum (compact rows) and at its default.

import { projectRow, selectSession, sessionRow, waitRow } from '../../../tests/support/app-sessions.ts'
import type { Kea } from '../../../tests/support/app.ts'
import { test } from '../../../tests/e2e/fixtures.ts'
import { demoProject, failed, finished, limited, openKea, permission, QUIET, runCommand, session, status, working } from './scene.ts'
import { GallerySet } from './shots.ts'

/** Seven sessions of one project in order of making, and a second project's first. */
async function palette(kea: Kea): Promise<Record<'working' | 'asking' | 'unread' | 'idle' | 'stopped' | 'failed' | 'limited' | 'other', string>> {
  await demoProject(kea, 'atlas-web')
  const working1 = await session(kea, 'v18-working', 'refactor the api client', QUIET, { open: false })
  const asking = await session(kea, 'v18-asking', 'add the billing page', QUIET, { open: false })
  const unread = await session(kea, 'v18-unread', 'update the readme', QUIET, { open: false })
  const idle = await session(kea, 'v18-idle', 'fix the auth redirect', QUIET, { open: false })
  const stopped = await session(kea, 'v18-stopped', 'seo pass', QUIET, { open: false })
  const failing = await session(kea, 'v18-failed', 'find broken links', QUIET, { open: false })
  const limit = await session(kea, 'v18-limited', 'invoice rounding', QUIET, { open: false })
  await demoProject(kea, 'docs-site')
  const other = await session(kea, 'v18-other', 'retry failed webhooks', QUIET, { open: false })

  await status(kea, working1, 'working', ...working)
  await status(kea, asking, 'needsYou', ...permission('npm test'))
  await status(kea, unread, 'unread', ...finished('Done.'))
  await selectSession(kea, idle)
  await kea.pretendFocused(true)
  await status(kea, idle, 'idle', ...finished('Done.'))
  await kea.pretendFocused(false)
  await runCommand(kea, 'session.stop', { id: stopped })
  await waitRow(kea, stopped, 'detached', (r) => r.lifecycle === 'detached')
  await status(kea, failing, 'failed', ...failed('API error'))
  await status(kea, limit, 'limited', ...limited(Date.now() + 3 * 3600_000))
  return { working: working1, asking, unread, idle, stopped, failed: failing, limited: limit, other }
}

test('V-18 · sidebar colours and widths', async ({ run, launch }) => {
  const set = new GallerySet('V-18', 'Session colours and the sidebar’s widths')
  const kea = await openKea(run, launch)
  const p = await kea.page()
  const s = await palette(kea)
  await p.mouse.move(1000, 700)
  const rows = { x: 0, y: 0, width: 240, height: 420 }
  await set.shot(kea, 'colours', 'Seven sessions made in order: working (lemon), needs you (accent, the dot in a ring), unread (blue), idle (pink), detached (deep teal), failed (danger), limited (text-3); the palette wraps at the sixth. The second project’s first session is lemon too', 'Sidebar, Session colours', { rect: rows })

  // the thinnest marks, large: idle's ring and detached's dashed ring, beside unread's dot and needs-you's ring
  await p.evaluate(() => {
    for (const g of document.querySelectorAll<SVGElement>('aside .kea-glyph')) g.style.transform = 'scale(3)'
  })
  await set.shot(kea, 'glyphs-large', 'The glyphs drawn three times their size: the session colours on the idle ring and the detached dashed ring, the thinnest marks; needs-you’s dot in its ring against unread’s plain dot', 'Session colours, Status glyphs', { rect: rows })
  await p.evaluate(() => {
    for (const g of document.querySelectorAll<SVGElement>('aside .kea-glyph')) g.style.transform = ''
  })

  // the sidebar at its minimum: the header's lights and +, compact rows
  await kea.setLayout({ sidebarWidth: 0 })
  await p.mouse.move(1000, 700)
  await set.shot(kea, 'minimum', 'The sidebar at its minimum: the traffic lights and the + in the header; rows draw the glyph and the title; the meta, the hover buttons and the footer line’s button move or go', 'Window layout, Sidebar', { rect: { x: 0, y: 0, width: 400, height: 900 } })
  await sessionRow(p, s.asking).hover()
  await set.shot(kea, 'minimum-hover', 'A compact row hovered: no archive button; its tooltip leads with the full title and says what the meta would show', 'Sidebar', { rect: { x: 0, y: 0, width: 520, height: 420 } })
  await projectRow(p, 'atlas-web').hover()
  await set.shot(kea, 'minimum-project', 'A compact project row hovered: the + and the name as its tooltip', 'Sidebar', { rect: { x: 0, y: 0, width: 520, height: 420 } })

  // back at the default width
  await kea.setLayout({ sidebarWidth: 240 })
  await p.mouse.move(1000, 700)
  await set.shot(kea, 'default', 'The same sidebar at its default width, for comparison', 'Sidebar', { rect: { x: 0, y: 0, width: 400, height: 900 } })
})
