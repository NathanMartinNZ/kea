# tools/gallery

`pnpm gallery`: the screenshot gallery. It drives the real app through UI states that are slow to reach by hand and
writes one static page of labelled screens, `dist/gallery/index.html`, for a person to check against Kea's design
system when a component changes. Nothing compares pixels, and it is never part of `pnpm verify`.

## Running

```sh
pnpm gallery                      # the V sets: V-1, 2, 5, 6, 7, 10, 13, 14, 15, 16
pnpm gallery --only V-5,V-10      # some sets; the others' screens from an earlier run stay on the page
pnpm gallery --review             # also the review sets R-1 … R-7
```

Then open `dist/gallery/index.html`. The page lists each set with its screens at 1440 × 900 @2x (a part of the window
where a set is about one component), each with a caption that says what to look for and the parts of the design system
it is held against. A set that failed to run is named at the top of the page.

## How it works

- A set is a `src/*.gallery.ts` file run by Playwright (`playwright.config.ts`, one worker). The files are not
  `*.spec.ts` or `*.test.ts`, so `pnpm test:e2e`, Vitest and `pnpm test:trace` do not see them.
- Each set launches Kea through the e2e fixtures (`tests/e2e/fixtures.ts`, so `KeaRun.launch`): unfocused, on a
  temporary `KEA_HOME`, with `tools/fake-agent` as the agent and repo-factory repositories as projects. No real agent
  CLI, editor, browser or file manager window is ever started, the window never takes the keyboard, and clipboard
  writes are recorded in the page instead of reaching the clipboard (`scene.ts` `openKea`).
- `shots.ts` sizes the window, pins the terminal font in the run's `settings.json` (a set may add to it: R-5 sets the
  light theme), and writes each screen with its caption (`GallerySet.shot`); a note without a screen
  (`GallerySet.note`) carries what a screenshot cannot show, such as the native menu of the menu-bar item (V-14 prints
  main's model of it).
- Statuses are given through core's intake as an agent's hooks would give them (`scene.ts` `status`), so a row's state
  is real state, not markup.
- Project and session names are the fixtures' (`atlas-web`, "Fix auth redirect"); paths are under the temporary home.
  No real name, home path or host name appears on a screen.

## Sets

| Set | File | What |
|---|---|---|
| V-1, V-2 | `v1-window.gallery.ts` | The full window with every status glyph and git decoration; the sidebar's states |
| V-5 | `v5-composer.gallery.ts` | The composer: empty, filled, each menu, problems, in place; an agent CLI missing |
| V-6 | `v6-terminal.gallery.ts` | Tab strip variants, the find bar, "Jump to bottom", the detached overlay |
| V-7, V-13 | `v7-viewer.gallery.ts` | The diff tab; the file viewer |
| V-10, V-14 | `v10-dialogs.gallery.ts` | Delete confirmation, toast, session log, first-quit sheet; the menu-bar item, a trust-pending row |
| V-15 | `v15-conditions.gallery.ts` | Account condition, report wrong status, teardown failed, "Copied by terminal"; Settings › Disk and the Remove Build Folders confirmation |
| V-16 | `v16-icons.gallery.ts` | The icon files of `assets/icon/` as committed: the app icon's PNGs at their real size and enlarged, at 16–128 pt as a Retina screen shows them, the 1024 px PNG beside the SVG, on light and dark grounds; the menu-bar template tinted as on a light and a dark menu bar; the Linux tray icon on a light and a dark panel. Drawn on a page of its own in Playwright's Chromium, with no Kea launched |
| R-1 | `r1-first-run.gallery.ts` | Review: the first run and the empty states |
| R-2 … R-6 | `r2-review.gallery.ts` | Review: header and dev server, file panel, tooltips; palette, finder, shortcuts; every Settings page; the light theme; setup strips, the banner strip, the reconnecting bar |
| R-7 | `r7-fault-states.gallery.ts` | Review: states made with a fault — the dev server stopping, the creation view and its row, a worktree that is gone, a project whose folder is gone, a creation cut short, an archived session, the first-quit sheet over an open composer |

The review sets are skipped unless `--review` is given (or `--only` names one): they show states one or two clicks
away in the running app, kept for a design review of the whole app.
