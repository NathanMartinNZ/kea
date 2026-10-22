# tools/repo-factory

Builds temporary git repositories on demand for the tests and the perf harness: `tiny`, `medium` and `large` (300 000
files, generated once and cached). The special shapes (submodules, LFS pointers, renames, conflicts, unicode/newline
filenames, linked worktrees) are built from `tiny` by the tests that need them.

| Entry | What |
|---|---|
| `tinyRepo({ parent?, name? })` | ten committed files (`README.md`, `package.json`, `.gitignore`, `src/{math,hello,counter,index}.js`, two `node --test` files, and the `.kea-fixture-repo` marker that lets recorders run there: `tools/scrubber/src/guard.ts`) → `{ root, dispose() }`. The files are what `tools/recorder/demo-prompts.json` talks about (the greeting typo, `x` in the counter, the tests) |
| `mediumRepo({ parent?, name? })` | `MEDIUM_FILES` (20 000) committed files in one commit, a mid-sized TypeScript project's shape: 156 modules of 100 source files (`src/mNNN/fNNN.ts`) and 25 tests each, docs to fill the count, the top-level files and the marker → `{ root, dispose() }`, in a few seconds. `mediumSourceFile(module, i)` names a committed source file (to modify some). Used by the perf suites (`tests/perf/core-micro.test.ts` checks the count) and by `tests/integration/core-files.test.ts` |
| `largeRepo({ parent?, name?, cache? })` | `LARGE_FILES` (300 000) committed files in one commit: 100 wide folders of generated records (`data/dNNN/rNNNN.json`, 2 000 each: one first page of a big directory) and a source tree of 1 000 modules of 100 files (`src/mNNN/fNNN.ts`), the top-level files and the marker → `{ root, dispose() }`. The commit is written once with `git fast-import` into a bare template (`largeTemplate()`, a few seconds) kept in `fixtureCacheDir()` (`node_modules/.cache/kea-repo-factory/`, or `KEA_FIXTURE_CACHE`); each call clones it (hard-linked objects, no remote) and checks out the work tree, which takes tens of seconds, as does `dispose()`. `largeDataFile(dir, i)` and `largeSourceFile(module, i)` name committed files. Used by `tests/perf/app-files.test.ts` |
| `fixtureGitEnv()` | the environment every git command here runs with: no global or system config (the user's identity, hooks, signing and templates never apply), a fixed author `Kea Fixture <fixture@example.invalid>` and a fixed date, so commits are identical every time |

Tests: `tiny.test.ts`; `medium` is checked where it is used (`tests/perf/core-micro.test.ts` counts its files), and
`large` counts its own files when the template is built.
