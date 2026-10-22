// The static contract of Claude Code: the installed `claude` answers `--version`, `--help` and `auth status` as
// packages/adapters/src/claude/contract.ts expects. The answers come from claude-cli.ts's cache, filled once per
// installed binary inside the recorder's world, and only when asked (`pnpm test:contract:capture`): a cache hit runs
// nothing, and on a miss each test checks what it can without the CLI, then skips, naming the installed version and the
// capture command. The recorded help of the fixture version (fixtures/cli/claude/<version>/) is checked the same way,
// so the parser is exercised with no CLI installed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EFFORTS, FLAGS, MIN_VERSION, PERMISSION_MODES } from '../../../packages/adapters/src/claude/contract.ts'
import { parseAuth, parseVersion } from '../../../packages/adapters/src/claude/detect.ts'
import { atLeast } from '../../../packages/adapters/src/kit/version.ts'
import { capture, CAPTURE_COMMAND, captureAllowed, choicesOf, helpFlags, installedClaude, listOf, optionText, type CliCapture } from './claude-cli.ts'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/cli/claude')
const recorded = fs.existsSync(FIXTURES)
  ? fs
      .readdirSync(FIXTURES)
      .filter((v) => fs.existsSync(path.join(FIXTURES, v, 'help.txt')))
      .map((v) => ({ v, help: fs.readFileSync(path.join(FIXTURES, v, 'help.txt'), 'utf8'), version: fs.readFileSync(path.join(FIXTURES, v, 'version.txt'), 'utf8') }))
  : []

const bin = installedClaude()
let cap: CliCapture | null = null
/** Why the installed CLI's half is skipped: its contract is not cached and no capture was asked for. */
let missing: string | null = null

beforeAll(async () => {
  if (!bin) return
  const r = await capture(bin)
  cap = r.capture
  missing = r.skipped ?? null
  if (missing) process.stderr.write(`K-CL: ${missing}\n`)
  // straight to stderr: a reporter that hides the console of passing files (Vitest's minimal one) still shows these
  if (r.ran && r.capture) process.stderr.write(`K-CL: captured ${r.capture.realpath} in the recorder world (3 launches); cached\n`)
  for (const l of r.leftovers) process.stderr.write(`K-CL: ${l}\n`)
}, 120_000)

/** After the checks that need no CLI: skip, visibly, when the installed CLI's contract is missing from the cache. */
function skipIfMissing(skip: (note?: string) => never): void {
  if (!cap && missing) skip(missing)
}

/** The help texts to check: the installed CLI's (when there is one) and every recorded version's. */
function helps(): { from: string; help: string }[] {
  return [...(cap ? [{ from: `installed ${cap.realpath}`, help: cap.help.out }] : []), ...recorded.map((r) => ({ from: `recorded ${r.v}`, help: r.help }))]
}

describe('Claude Code static contract', () => {
  it('K-CL-1 · `claude --version` parses, at or above the contract’s minimum', ({ skip }) => {
    for (const r of recorded) expect(atLeast(parseVersion(r.version), MIN_VERSION), `recorded ${r.v}`).toBe(true)
    skipIfMissing(skip)
    if (!cap) return
    expect(cap.version.code, cap.version.err).toBe(0)
    const v = parseVersion(cap.version.out)
    expect(v, `version of ${cap.realpath}: ${cap.version.out}`).not.toBeNull()
    expect(atLeast(v, MIN_VERSION), `${v} ≥ ${MIN_VERSION}`).toBe(true)
  })

  it('K-CL-2 · `claude --help` lists every flag of claude/contract.ts (and the contract has no --plugin-dir: Kea loads no Claude session mod)', ({ skip }) => {
    expect(Object.values(FLAGS)).not.toContain('--plugin-dir')
    expect(helps().length).toBeGreaterThan(0)
    for (const h of helps()) {
      if (cap && h.from.startsWith('installed')) expect(cap.help.code, cap.help.err).toBe(0)
      const listed = helpFlags(h.help)
      expect(Object.values(FLAGS).filter((f) => !listed.has(f)), `flags missing from the help (${h.from})`).toEqual([])
    }
    skipIfMissing(skip)
  })

  it('K-CL-3 · the `--permission-mode` choices include every contract mode, at least one name of each alias group (`manual` / `default`)', ({ skip }) => {
    for (const h of helps()) {
      const choices = choicesOf(optionText(h.help, FLAGS.permissionMode) ?? '')
      expect(choices.length, `choices parsed (${h.from})`).toBeGreaterThan(0)
      const absent = PERMISSION_MODES.filter((m) => ![m.id, ...m.aliases].some((n) => choices.includes(n))).map((m) => m.id)
      expect(absent, `modes missing from ${choices.join(', ')} (${h.from})`).toEqual([])
    }
    skipIfMissing(skip)
  })

  it('K-CL-4 · the `--effort` levels include every contract effort level', ({ skip }) => {
    for (const h of helps()) {
      const levels = listOf(optionText(h.help, FLAGS.effort) ?? '')
      expect(levels.length, `levels parsed (${h.from})`).toBeGreaterThan(0)
      expect(EFFORTS.filter((e) => !levels.includes(e)), `levels missing from ${levels.join(', ')} (${h.from})`).toEqual([])
    }
    skipIfMissing(skip)
  })

  it('K-CL-5 · `claude auth status` prints JSON and exits 0 (logged in) or 1 (not)', ({ skip }) => {
    skipIfMissing(skip)
    if (!cap) return
    expect([0, 1], `exit ${cap.auth.code}: ${cap.auth.err}`).toContain(cap.auth.code)
    expect(() => JSON.parse(cap!.auth.out), `JSON: ${cap.auth.out}`).not.toThrow()
    expect(parseAuth(cap.auth.code, cap.auth.out)).toBe(cap.auth.code === 0)
  })
})

describe('the static contract’s cache', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    for (const c of cleanup.splice(0).reverse()) c()
  })

  it('K-CL-6 · a cache miss launches nothing unless the capture is asked for (KEA_CONTRACT_CAPTURE=1, `pnpm test:contract:capture`): it reports the installed version and the capture command instead', async () => {
    // a stand-in installed as the installer lays it out (…/claude/versions/<version>, linked from …/bin/claude); never the real one
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-contract-')))
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const marker = path.join(root, 'launched')
    const version = path.join(root, 'claude', 'versions', '9.9.9')
    fs.mkdirSync(path.dirname(version), { recursive: true })
    fs.writeFileSync(version, `#!/bin/sh\necho launched >> '${marker}'\necho '9.9.9 (Claude Code)'\n`, { mode: 0o755 })
    const bin = path.join(root, 'bin', 'claude')
    fs.mkdirSync(path.dirname(bin))
    fs.symlinkSync(version, bin)
    const empty = path.join(root, 'cache')
    fs.mkdirSync(empty)

    expect(captureAllowed({}), 'not asked for').toBe(false)
    expect(captureAllowed({ KEA_CONTRACT_CAPTURE: '1' })).toBe(true)
    const r = await capture(bin, { cacheDir: empty, allow: captureAllowed({}) })
    expect({ ran: r.ran, capture: r.capture, launched: fs.existsSync(marker), cached: fs.readdirSync(empty) }).toEqual({ ran: false, capture: null, launched: false, cached: [] })
    expect(r.skipped).toContain('claude 9.9.9')
    expect(r.skipped).toContain(CAPTURE_COMMAND)
  })
})

