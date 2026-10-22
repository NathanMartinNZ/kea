// tools/scrubber — fixture privacy: the length-preserving scrubber, the privacy gate's scan and the recorder guard.
export {
  type Finding,
  type Identity,
  type ScrubContext,
  type ScrubResult,
  currentIdentity,
  findAbsolutePaths,
  isEnvFile,
  placeholder,
  scanForPrivateData,
  scrubBuffer,
  SECRET_PATTERNS,
} from './scrub.ts'
export { assertRecordable, DEMO_PROMPTS_FILE, demoPrompts, FIXTURE_REPO_MARKER, gitRoot, NotRecordableError } from './guard.ts'
export { fixtureFiles, rawFixtures, scrubTree } from './files.ts'
