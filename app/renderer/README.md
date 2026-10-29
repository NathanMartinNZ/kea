# app/renderer

The window's UI: Svelte 5 with runes, built with Vite (no SvelteKit), and xterm.js with its WebGL renderer for the
terminals. The window talks to core over one RPC port (stores and calls) and to ptyhost over one stream port per
attached terminal; the preload (`app/preload`) hands both over. It imports `packages/protocol`, `packages/terminal`,
`packages/ui` and `@kea/kit/fsm`, never `app/core` or `app/ptyhost`.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | Installs the window's stores, commands and menus, then mounts `shell/App.svelte` once |
| `src/shell/` | The frame: three columns (sidebar, file panel, main pane) with resizable dividers, the main header, the session pane and its tab strip of terminals and file tabs, banners, the Reconnecting bar, the overlay over an ended session, F6 focus regions, and the header's menu button on Linux |
| `src/lib/` | The preload bridge (`bridge.ts`), the RPC client that survives a core restart (`rpc.ts`), `FrameStore` (a core store applied at most once per animation frame), the bridge between plain stores and runes (`reactive.svelte.ts`), and the probes installed only under `--kea-perf` (`perf.ts`, `testProbes.ts`) |
| `src/features/sessions/` | The sidebar, the window's copies of core's `projects`, `sessions` and `terminals` stores, the session and project commands, context menus, confirmation sheets, the toast and project settings |
| `src/features/composer/` | The new-session composer: prompt, project, agent and its options, base branch, worktree and branch name, with a draft per project |
| `src/features/terminal/` | Terminal views (WebGL, with the DOM renderer after a lost context), the registry that decides which views stay alive, find, links, paste and drop, clipboard writes (OSC 52), the screen-reader mode and font zoom |
| `src/features/files/` | The file panel: the file tree and its file operations, the Changes list, Go to File and Discard |
| `src/features/viewer/` | Read-only file and diff tabs on CodeMirror, syntax highlighting with Shiki in a worker, the Markdown preview and images |
| `src/features/server/` | The dev-server control in the header: Run, Stop and the port chip |
| `src/features/editor/` | Open in editor: the header's split button and its commands |
| `src/features/status/` | Session status in the window: what the user is viewing, the needs-you count in the title, the session popover and the account-condition notes |
| `src/features/commands/` | The command registry, the key router, key bindings and the Keyboard Shortcuts sheet |
| `src/features/palette/` | The command palette |
| `src/features/settings/` | The Settings sheet, drawn from the settings schema, and the window's copy of the settings |
| `src/features/disk/` | Settings › Disk: what each worktree costs on disk, removing build folders, restoring deleted sessions |
| `src/features/diagnostics/` | Copy Diagnostics, and the performance HUD of a development build |
| `src/features/resources/` | The renderer's resource report |
| `src/styles.css`, `src/shell/window.css`, `src/features/*/*.css` | Styles, written only with the design tokens of `packages/ui` |

The shell mounts the features and hands them props; features never import `shell/`. Each feature registers its own
commands in `features/<feature>/commands.ts`.

## Svelte conventions

- **Layout.** Components are `PascalCase.svelte` next to the plain `.ts` logic they use (`Sidebar.svelte` with
  `sidebar.ts` and `model.ts`). Logic that needs no runes stays in `.ts` and is unit-tested there; a module that
  declares runes is `name.svelte.ts`. `<script lang="ts">` is erasable TypeScript like every `.ts` file. A component
  with no props or logic still has an empty `<script lang="ts"></script>`, so svelte-check types it.
- **Stores.** Window UI state is a class in a `.svelte.ts` module with one `$state.raw` field per value (`$state` only
  for primitives), exported as one instance: `ui` in `features/sessions/state.svelte.ts`, `layoutState` in
  `shell/layoutStore.svelte.ts`, `uiState` + `terminalUi` (actions) in `features/terminal/ui.svelte.ts`. Components read
  the fields; code assigns them (`ui.sheet = …`) or patches several at once (`ui.set({ … })`). Replace values, never
  mutate them in place: `$state.raw` only notices a new value.
- **Core's stores** stay framework-neutral: `FrameStore` (`lib/frameStore.ts`) coalesces deltas to one flush per
  animation frame; a window that gets no frames (hidden or covered) flushes after `L.frameFallbackMs`, longer than any
  display's frame, so a shown window never flushes twice in one. A component follows one with
  `new External(subscribe, get)` (`lib/reactive.svelte.ts`, built on `createSubscriber`): `subscribeRow(id, …)` for
  one row, `subscribeList` for the list, so a status change re-renders only its row. `watch(read, cb)` runs plain code
  when rune state changes (command availability: `commands.changed()`).
- **Heavy objects.** xterm `Terminal`s, addons, WebGL canvases, ports and the registries live only in plain module
  registries (`features/terminal/views.ts` `terminals`), never in `$state`, `$derived`, props or context; `$state`
  deep-proxies whatever it holds. Components hold ids. A view's element goes into its host with an attachment
  (`{@attach mountView(id)}` in `TerminalArea.svelte`) whose cleanup takes it out; the registry creates and disposes
  the views.
- **Effects.** Name what an effect follows by reading it first and run the body in `untrack` when only those reads may
  re-run it (the React `deps` lists, kept). Props are live getters: a handler that clears the state its props come
  from reads the values it needs first (`Menu.svelte` `pick`, `ToastHost.svelte`). A component that follows one id
  (a session row, the composer of a project) is mounted per id (`{#key}` or a keyed `{#each}`) and copies the id at
  init with `untrack`. Ordering differs from React's layout-then-passive effects: in one flush a component's effects
  run before its children's, and an effect can run before the DOM reflects a state write made by another effect.
  Work that needs the updated DOM (focus, measuring) or must follow a child's effects waits for `tick()`:
  `TerminalArea.svelte` focuses the revealed terminal after its host is shown, and `TerminalPane.svelte` sends
  `terminal.setVisible` after the area has switched, so a parked terminal's stream is asked for first.
- **Tests.** Logic is tested as plain `.ts` (`*.test.ts` next to it). Rune modules can be imported by the unit
  project, which compiles `.svelte` and `.svelte.ts` (vitest.config.ts) in Svelte's server mode: runes are plain
  fields there and `$effect` does not run. A component's markup is tested with `render` from `svelte/server`
  (`packages/ui/src/icons.test.ts`); a test that needs a component's effects or events needs the browser build of
  Svelte (`resolve.conditions: ['browser']`) and a DOM environment, which no test uses. Behaviour in the window is
  tested at app level (tests/e2e, tests/memory), by role and accessible name.
- **Lint** (`tools/lint`) reads `.svelte` files: `boundaries` checks the imports of `<script>` blocks; `tokens` checks
  `<style>` blocks, `style="…"` attributes, `style:prop="…"` directives, colours in other attributes, and the `<script>`
  blocks and `{…}` expressions as TS; `agent-strings` scans scripts, markup text and attributes (comments excepted).
  `pnpm typecheck` runs svelte-check with warnings as failures: an a11y warning that the markup keeps on purpose gets
  `<!-- svelte-ignore code, code (reason) -->` (codes comma-separated).

## Finding elements in tests

The app-level tests find the window's elements by ARIA role and accessible name, and by a few `data-*` attributes
(`data-session-id`, `data-path`, `data-command`, …). A component's header comment says how it is found
("Locatable as …").

## Building and testing

`tools/build.ts` (which `pnpm dev` runs) builds the window with Vite into `dist/app/renderer`; main serves it from
`kea://app/`. There is no Vite dev server.

```sh
pnpm exec vitest run --project unit app/renderer
```
