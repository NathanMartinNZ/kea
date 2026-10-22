// The static contract of Command Code: the installed `cmd` answers `--version`, `--help`, `--list-models` and
// `status --json` as packages/adapters/src/commandcode/contract.ts expects. The answers come from commandcode-cli.ts's
// cache, filled once per installed binary inside the recorder's world and only when asked
// (`pnpm test:contract:capture:cmd`, 4 launches): a cache hit runs nothing, and on a miss each test checks what it can
// without the CLI (the recorded answers of fixtures/cli/commandcode/<version>/), then skips, naming the installed
// version and the capture command.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FLAGS, MIN_VERSION, PERMISSION_MODES, STATUS_FIELDS } from '../../../packages/adapters/src/commandcode/contract.ts'
import { modesOffered, options, parseHelpFlags, parseHelpModes, parseModels, parseStatus, parseVersion } from '../../../packages/adapters/src/commandcode/detect.ts'
import { modeArg } from '../../../packages/adapters/src/commandcode/launch.ts'
import { atLeast } from '../../../packages/adapters/src/kit/version.ts'
import { captureCommandCode, CM_CAPTURE_COMMAND, CM_CAPTURE_ENV, CM_RUNS, cmCaptureAllowed, installedCommandCode, type CmCapture } from './commandcode-cli.ts'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/cli/commandcode')
const read = (v: string, f: string) => fs.readFileSync(path.join(FIXTURES, v, f), 'utf8')
const recorded = fs.existsSync(FIXTURES)
  ? fs
      .readdirSync(FIXTURES)
      .filter((v) => fs.existsSync(path.join(FIXTURES, v, 'help.txt')))
      .map((v) => ({ v, version: read(v, 'version.txt'), help: read(v, 'help.txt'), models: read(v, 'list-models.txt'), status: read(v, 'status.json') }))
  : []

const bin = installedCommandCode()
let cap: CmCapture | null = null
/** Why the installed CLI's half is skipped: its contract is not cached and no capture was asked for. */
let missing: string | null = null

beforeAll(async () => {
  if (!bin) return
  const r = await captureCommandCode(bin)
  cap = r.capture
  missing = r.skipped ?? null
  // straight to stderr: a reporter that hides the console of passing files still shows these
  if (missing) process.stderr.write(`K-CM: ${missing}\n`)
  if (r.ran && r.capture) process.stderr.write(`K-CM: captured ${r.capture.realpath} in the recorder world (${CM_RUNS.length} launches); cached\n`)
  for (const l of r.leftovers) process.stderr.write(`K-CM: ${l}\n`)
}, 120_000)

function skipIfMissing(skip: (note?: string) => never): void {
  if (!cap && missing) skip(missing)
}

/** Each answer to check: the installed CLI's (when cached) and every recorded version's. */
function answers<K extends 'version' | 'help' | 'models' | 'status'>(k: K): { from: string; out: string; code: number | null }[] {
  return [...(cap ? [{ from: `installed ${cap.realpath}`, out: cap[k].out, code: cap[k].code }] : []), ...recorded.map((r) => ({ from: `recorded ${r.v}`, out: r[k], code: k === 'status' ? null : 0 }))]
}

describe('Command Code static contract', () => {
  it('K-CM-1 · `cmd --version` parses, at or above the contract’s minimum', ({ skip }) => {
    expect(answers('version').length).toBeGreaterThan(0)
    for (const a of answers('version')) {
      const v = parseVersion(a.out)
      expect(v, `version (${a.from}): ${a.out}`).not.toBeNull()
      expect(atLeast(v, MIN_VERSION), `${v} ≥ ${MIN_VERSION} (${a.from})`).toBe(true)
      if (a.code !== null) expect(a.code, a.from).toBe(0)
    }
    skipIfMissing(skip)
  })

  it('K-CM-2 · `cmd --help` lists every flag of commandcode/contract.ts; its --permission-mode values parse to a list with `default` or `standard`, and every mode the composer offers is in it and has an argument the CLI takes', ({ skip }) => {
    expect(answers('help').length).toBeGreaterThan(0)
    for (const a of answers('help')) {
      const listed = parseHelpFlags(a.out)
      expect(Object.values(FLAGS).filter((f) => !listed.has(f)), `flags missing from the help (${a.from})`).toEqual([])
      const names = parseHelpModes(a.out)
      expect(names.length, `modes parsed (${a.from})`).toBeGreaterThan(0)
      expect(names.includes('default') || names.includes('standard'), `the default mode under either name in ${names.join(', ')} (${a.from})`).toBe(true)
      // what the composer offers: each is a mode the help names (under one of its spellings), and what the
      // adapter passes for it is one of those names
      const offered = options({ listed: { models: null, permissionModes: names } }).permissionModes
      expect(offered.length).toBeGreaterThan(0)
      for (const m of offered) {
        const known = PERMISSION_MODES.find((x) => x.id === m.id)
        const spellings: readonly string[] = known ? known.names : [m.id]
        expect(spellings.some((n) => names.includes(n)), `${m.id} is in the help's list ${names.join(', ')} (${a.from})`).toBe(true)
        const arg = modeArg(m.id)
        expect(arg, `${m.id} has an argument`).not.toBeNull()
        // the argument is a name the help lists, or (the default mode's two names) an alias of one
        expect(names.includes(arg!) || spellings.includes(arg!), `--permission-mode ${arg} for ${m.id} (${a.from})`).toBe(true)
      }
      // the modes offered before any help is read are the ones this help lists
      if (a.from.startsWith('recorded')) expect(modesOffered(null).map((m) => m.id)).toEqual(modesOffered(names).map((m) => m.id))
    }
    skipIfMissing(skip)
  })

  it('K-CM-3 · `cmd --list-models` parses to at least one model with the current parser, one of them the default', ({ skip }) => {
    expect(answers('models').length).toBeGreaterThan(0)
    for (const a of answers('models')) {
      const models = parseModels(a.out)
      expect(models.length, `models parsed (${a.from})`).toBeGreaterThan(0)
      const said = /(\d+) models/.exec(a.out)?.[1]
      if (said) expect(models.length, `the count the list states (${a.from})`).toBe(Number(said))
      expect(models.filter((m) => m.isDefault).length, `default models (${a.from})`).toBeLessThanOrEqual(1)
      if (a.code !== null) expect(a.code, a.from).toBe(0)
    }
    skipIfMissing(skip)
  })

  it('K-CM-4 · `cmd status --json` prints JSON with `authenticated` and `version`, and exits 0 (signed in) or 1 (not)', ({ skip }) => {
    expect(answers('status').length).toBeGreaterThan(0)
    for (const a of answers('status')) {
      const o = JSON.parse(a.out) as Record<string, unknown>
      expect(typeof o[STATUS_FIELDS.authenticated], `authenticated (${a.from}): ${a.out}`).toBe('boolean')
      expect(typeof o[STATUS_FIELDS.version], `version (${a.from})`).toBe('string')
      if (a.code !== null) {
        expect([0, 1], `exit ${a.code} (${a.from})`).toContain(a.code)
        expect(parseStatus(a.code, a.out)).toBe(a.code === 0)
      }
    }
    skipIfMissing(skip)
  })
})

describe('Command Code’s static contract cache', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    for (const c of cleanup.splice(0).reverse()) c()
  })

  it('K-CM-5 · a cache miss launches nothing unless Command Code’s own capture is asked for (KEA_CONTRACT_CAPTURE_CM=1, `pnpm test:contract:capture:cmd`); Claude’s capture switch does not start `cmd`', async () => {
    // a stand-in laid out as npm installs the package (…/command-code/dist/index.mjs, linked from …/bin/cmd); never the real one
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-contract-cm-')))
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const marker = path.join(root, 'launched')
    const pkg = path.join(root, 'lib', 'node_modules', 'command-code')
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'command-code', version: '9.9.9' }))
    const entry = path.join(pkg, 'dist', 'index.mjs')
    fs.writeFileSync(entry, `#!/bin/sh\necho launched >> '${marker}'\necho 9.9.9\n`, { mode: 0o755 })
    const stand = path.join(root, 'bin', 'cmd')
    fs.mkdirSync(path.dirname(stand))
    fs.symlinkSync(entry, stand)
    const empty = path.join(root, 'cache')
    fs.mkdirSync(empty)

    expect(cmCaptureAllowed({}), 'not asked for').toBe(false)
    expect(cmCaptureAllowed({ KEA_CONTRACT_CAPTURE: '1' }), 'Claude’s switch is not Command Code’s').toBe(false)
    expect(cmCaptureAllowed({ [CM_CAPTURE_ENV]: '1' })).toBe(true)
    const r = await captureCommandCode(stand, { cacheDir: empty, allow: cmCaptureAllowed({ KEA_CONTRACT_CAPTURE: '1' }) })
    expect({ ran: r.ran, capture: r.capture, launched: fs.existsSync(marker), cached: fs.readdirSync(empty) }).toEqual({ ran: false, capture: null, launched: false, cached: [] })
    expect(r.skipped).toContain('Command Code 9.9.9')
    expect(r.skipped).toContain(CM_CAPTURE_COMMAND)
    expect(r.skipped).toContain(`${CM_RUNS.length} launches`)
  })
})
