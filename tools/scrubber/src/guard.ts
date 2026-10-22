// The recorder guard: anything that records an agent session (`pnpm record:cassette`) calls assertRecordable before it
// starts. Recording is allowed only in a repo made by the repo factory (its root holds `.kea-fixture-repo`) and only
// with a prompt from the demo prompt list.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_REPO_MARKER = '.kea-fixture-repo'

/** tools/recorder/demo-prompts.json */
export const DEMO_PROMPTS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../recorder/demo-prompts.json')

export class NotRecordableError extends Error {
  override name = 'NotRecordableError'
}

/** The git work-tree root containing `dir` (nearest ancestor with a `.git` directory or file), or null. */
export function gitRoot(dir: string): string | null {
  let d = dir
  for (;;) {
    if (existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

export function demoPrompts(file: string = DEMO_PROMPTS_FILE): string[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { prompts?: unknown }
  if (!Array.isArray(raw.prompts) || !raw.prompts.every((p) => typeof p === 'string')) throw new Error(`${file}: expected { "prompts": string[] }`)
  return raw.prompts as string[]
}

/**
 * Throws NotRecordableError unless `cwd` is inside a git repo whose root holds `.kea-fixture-repo` and `prompt` is
 * one of the demo prompts (exact match after trimming). Symlinks are resolved first.
 */
export function assertRecordable(opts: { cwd: string; prompt: string; promptsFile?: string }): { root: string } {
  let cwd: string
  try {
    cwd = realpathSync(opts.cwd)
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new NotRecordableError(`refusing to record: ${opts.cwd} is not a directory`)
  }
  const root = gitRoot(cwd)
  if (!root) throw new NotRecordableError(`refusing to record: ${cwd} is not inside a git repo (record only in repo-factory demo repos)`)
  if (!existsSync(join(root, FIXTURE_REPO_MARKER))) {
    throw new NotRecordableError(`refusing to record: ${root} has no ${FIXTURE_REPO_MARKER} marker — only repo-factory demo repos may be recorded`)
  }
  const prompts = demoPrompts(opts.promptsFile)
  if (!prompts.includes(opts.prompt.trim())) {
    throw new NotRecordableError(`refusing to record: the prompt is not in ${opts.promptsFile ?? 'tools/recorder/demo-prompts.json'}`)
  }
  return { root }
}
