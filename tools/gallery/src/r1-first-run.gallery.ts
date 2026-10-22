// Review set R-1: the first run and the empty states. One click away in the running app, so taken only with
// `pnpm gallery --review`.

import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { promptBox } from '../../../tests/support/app-sessions.ts'
import { STEP_MS } from '../../../tests/support/app.ts'
import { demoProject, openKea, REVIEW } from './scene.ts'
import { GallerySet } from './shots.ts'

test('R-1 · first run and empty states', async ({ run, launch }) => {
  test.skip(!REVIEW, 'a review set: pnpm gallery --review')
  const set = new GallerySet('R-1', 'First run and empty states')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  await set.shot(kea, 'no-projects', 'No projects: the sidebar says "Add a project to get started." with the quiet "Add project… ⌘O"; the main pane keeps plain shell tabs', 'Empty states')
  await set.shot(kea, 'no-projects-sidebar', 'The sidebar alone', 'Empty states', { part: page.getByRole('complementary', { name: 'Sidebar' }), pad: 0 })
  await demoProject(kea, 'atlas-web')
  await expect(promptBox(page)).toBeFocused({ timeout: STEP_MS })
  await set.shot(kea, 'project-no-sessions', 'A project with no sessions: the composer, already focused', 'Empty states')
})
