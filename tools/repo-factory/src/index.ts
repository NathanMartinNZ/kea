// tools/repo-factory: temp git repos on demand: `tiny`, `medium` and `large` (generated once and cached).
// The special shapes (submodules, LFS pointers, renames, conflicts, unusual filenames) are built by the tests that need
// them, from `tiny`.
export { FIXTURE_AUTHOR, fixtureGitEnv, type FixtureRepo, TINY_FILES, tinyRepo } from './tiny.ts'
export { MEDIUM_FILES, mediumRepo, mediumSourceFile } from './medium.ts'
export { fixtureCacheDir, LARGE_DATA_DIRS, LARGE_DATA_PER_DIR, LARGE_FILES, LARGE_FILES_PER_MODULE, LARGE_MODULES, largeDataFile, largeRepo, largeSourceFile, largeTemplate } from './large.ts'
