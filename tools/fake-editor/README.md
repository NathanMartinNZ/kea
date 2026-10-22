# tools/fake-editor

The stand-in for everything Kea launches outside itself for a folder: an editor's bundled CLI (`code`, `cursor`, `zed`
…), the system's `open`, Spotlight's `mdfind` and the GitHub CLI `gh` (for `session.createPR`). **It opens nothing.**
Each run appends one JSON line to a log (`{"tool","argv","cwd","env"}`) and exits; a test asserts the argv Kea produced.
No test launches a real editor, browser or terminal app: the launcher takes what it may look at and run as a parameter
(`app/core/src/editor/host.ts`), and tests hand it these.

| File | What |
|---|---|
| `src/main.ts` | The program: `node main.ts --as NAME --log FILE [--exit N] [--stderr TEXT] [--bundles FILE] -- ARGS…` |
| `src/index.ts` | `installTool(file, o)` writes an executable that runs it with the options fixed · `installBundle(appsDir, def, o)` makes a stand-in `.app` (folder, `Info.plist`, optionally its bundled CLI) · `writeBundles(file, map)` is what a fake `mdfind` answers from · `readCalls(log)` |

- **A failing tool:** `exit` and `stderr` (when every strategy fails, the toast shows the last one's stderr).
- **`mdfind`:** `installTool(file, { as: 'mdfind', log, bundles })` prints, for every bundle id quoted in its query that
  the map lists, the line the real `mdfind -attr kMDItemCFBundleIdentifier` prints.
- **In the app** (e2e): a harness launch looks for editors only under the run's own HOME (`<HOME>/Applications`,
  `<HOME>/bin/open`, `<HOME>/bin/gh`; `sandboxEditorHost`), so a test installs its stand-ins there before launching.

Used by `tests/integration/core-editor.test.ts` and the e2e editor tests (`tests/e2e/editor.spec.ts`,
`tests/support/app-server.ts`), and by `tests/integration/core-server.test.ts` as `docker` and `pnpm` on a session's
`PATH` (Docker is never run from a test). Its own test: `src/fake.test.ts`.
