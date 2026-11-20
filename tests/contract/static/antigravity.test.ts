// The static contract of Antigravity CLI: the installed `agy` answers `--version` (stdout), `--help` (stderr, Go's
// `flag` package), and `models` as packages/adapters/src/antigravity/contract.ts expects. Answers come from
// antigravity-cli.ts's cache, filled once per installed binary inside the recorder's world and only when asked
// (`pnpm test:contract:capture:agy`, 3 launches): a cache hit runs nothing, and on a miss each test checks the
// committed fixtures under fixtures/cli/antigravity/<version>/ first, then skips the live half naming the binary and
// the capture command.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  EFFORTS,
  FEED_FIELDS,
  FLAGS,
  MIN_VERSION,
  PERMISSION_MODES,
  SETTINGS_KEYS,
  SUBCOMMANDS,
} from '../../../packages/adapters/src/antigravity/contract.ts'
import {
  groupModels,
  modesOffered,
  options,
  parseHelpEfforts,
  parseHelpFlags,
  parseHelpModes,
  parseModels,
  parseVersion,
} from '../../../packages/adapters/src/antigravity/detect.ts'
import { modeArg } from '../../../packages/adapters/src/antigravity/launch.ts'
import { atLeast } from '../../../packages/adapters/src/kit/version.ts'
import {
  AG_CAPTURE_COMMAND,
  AG_CAPTURE_ENV,
  AG_RUNS,
  agCaptureAllowed,
  captureAntigravity,
  installedAntigravity,
  type AgCapture,
} from './antigravity-cli.ts'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/cli/antigravity')
const read = (v: string, f: string) => fs.readFileSync(path.join(FIXTURES, v, f), 'utf8')
const recorded = fs.existsSync(FIXTURES)
  ? fs
      .readdirSync(FIXTURES)
      .filter((v) => fs.existsSync(path.join(FIXTURES, v, 'help.txt')))
      .map((v) => ({
        v,
        version: read(v, 'version.txt'),
        help: read(v, 'help.txt'),
        models: read(v, 'models.txt'),
      }))
  : []

const bin = installedAntigravity()
let cap: AgCapture | null = null
/** Why the installed CLI's half is skipped: its contract is not cached and no capture was asked for. */
let missing: string | null = null

beforeAll(async () => {
  if (!bin) return
  const r = await captureAntigravity(bin)
  cap = r.capture
  missing = r.skipped ?? null
  if (missing) process.stderr.write(`K-AG: ${missing}\n`)
  if (r.ran && r.capture) {
    process.stderr.write(`K-AG: captured ${r.capture.realpath} in the recorder world (${AG_RUNS.length} launches); cached\n`)
  }
  for (const l of r.leftovers) process.stderr.write(`K-AG: ${l}\n`)
}, 120_000)

function skipIfMissing(skip: (note?: string) => never): void {
  if (!cap && missing) skip(missing)
}

/** The `--help` texts to check: the installed CLI's (Go prints `--help` to stderr; stdout fallback) and every recorded version's. */
function helps(): { from: string; text: string; code: number | null }[] {
  return [
    ...(cap
      ? [
          {
            from: `installed ${cap.realpath}`,
            text: cap.help.err.trim() ? cap.help.err : cap.help.out,
            code: cap.help.code,
          },
        ]
      : []),
    ...recorded.map((r) => ({ from: `recorded ${r.v}`, text: r.help, code: 0 })),
  ]
}

/** How much of a binary is read at a time while looking for strings in it. */
const SCAN_CHUNK_BYTES = 8 << 20

/** Which of `needles` occur in `file`'s bytes: read in overlapping chunks, never run. */
function stringsIn(file: string, needles: readonly string[]): Set<string> {
  const want = needles.map((n) => Buffer.from(n))
  const overlap = Math.max(...want.map((b) => b.length)) - 1
  const found = new Set<string>()
  const buf = Buffer.alloc(SCAN_CHUNK_BYTES + overlap)
  const fd = fs.openSync(file, 'r')
  try {
    let carry = 0
    let pos = 0
    while (found.size < needles.length) {
      const n = fs.readSync(fd, buf, carry, SCAN_CHUNK_BYTES, pos)
      if (n <= 0) break
      pos += n
      const view = buf.subarray(0, carry + n)
      want.forEach((w, i) => {
        if (view.includes(w)) found.add(needles[i]!)
      })
      carry = Math.min(overlap, view.length)
      buf.copyWithin(0, view.length - carry, view.length)
    }
  } finally {
    fs.closeSync(fd)
  }
  return found
}

describe('Antigravity CLI static contract', () => {
  it('K-AG-1 · `agy --version` parses semver at or above MIN_VERSION across committed fixtures and cached capture', ({ skip }) => {
    expect(recorded.length).toBeGreaterThan(0)
    for (const r of recorded) {
      const v = parseVersion(r.version)
      expect(v, `recorded ${r.v}: ${r.version}`).not.toBeNull()
      expect(atLeast(v, MIN_VERSION), `${v} >= ${MIN_VERSION} (recorded ${r.v})`).toBe(true)
    }
    skipIfMissing(skip)
    if (!cap) return
    expect(cap.version.code, cap.version.err).toBe(0)
    const v = parseVersion(cap.version.out)
    expect(v, `version of ${cap.realpath}: ${cap.version.out}`).not.toBeNull()
    expect(atLeast(v, MIN_VERSION), `${v} >= ${MIN_VERSION}`).toBe(true)
  })

  it('K-AG-2 · `agy --help` (stderr) lists every launch/detect flag in antigravity/contract.ts and the `models` subcommand', ({ skip }) => {
    expect(helps().length).toBeGreaterThan(0)
    const contractFlags = Object.entries(FLAGS)
      .filter(([k]) => k !== 'version' && k !== 'help')
      .map(([, f]) => f)
    for (const h of helps()) {
      if (h.code !== null) expect(h.code, h.from).toBe(0)
      const listed = parseHelpFlags(h.text)
      expect(
        contractFlags.filter((f) => !listed.has(f)),
        `flags missing from --help (${h.from})`,
      ).toEqual([])
      expect(
        new RegExp(`^\\s+${SUBCOMMANDS.models}\\s+`, 'm').test(h.text),
        `subcommand '${SUBCOMMANDS.models}' listed in --help (${h.from})`,
      ).toBe(true)
    }
    skipIfMissing(skip)
  })

  it('K-AG-3 · `parseHelpModes` & `parseHelpEfforts` cover all contract modes and efforts; committed `models.txt` parses and groups cleanly into multi-effort families and single-variant models', ({ skip }) => {
    expect(helps().length).toBeGreaterThan(0)
    const flagModes = PERMISSION_MODES.filter((m) => m.flag !== null).map((m) => m.flag!)
    for (const h of helps()) {
      const modes = parseHelpModes(h.text)
      expect(modes.length, `modes parsed (${h.from})`).toBeGreaterThan(0)
      expect(
        flagModes.filter((m) => !modes.includes(m)),
        `contract modes missing from --help (${h.from}): ${modes.join(', ')}`,
      ).toEqual([])

      const offered = options({ listed: { models: null, permissionModes: modes } }).permissionModes
      expect(offered.map((m) => m.id)).toContain('default')
      expect(offered.map((m) => m.id)).toContain('yolo')
      for (const m of offered) {
        if (m.id === 'default' || m.id === 'yolo') {
          expect(modeArg(m.id)).toBeNull()
        } else {
          const arg = modeArg(m.id)
          expect(arg, `${m.id} has a --mode argument`).not.toBeNull()
          expect(modes, `--mode=${arg} for ${m.id} (${h.from})`).toContain(arg)
        }
      }
      if (h.from.startsWith('recorded')) {
        expect(modesOffered(null).map((m) => m.id)).toEqual(modesOffered(modes).map((m) => m.id))
      }

      const efforts = parseHelpEfforts(h.text)
      expect(efforts.length, `efforts parsed (${h.from})`).toBeGreaterThan(0)
      expect(
        EFFORTS.filter((e) => !efforts.includes(e)),
        `contract efforts missing from --help (${h.from}): ${efforts.join(', ')}`,
      ).toEqual([])
    }

    // Committed models.txt parses cleanly and groups into >= 1 multi-effort family and >= 1 ungrouped model
    for (const r of recorded) {
      const models = parseModels(r.models)
      expect(models.length, `recorded ${r.v} models`).toBeGreaterThan(0)
      const grouped = groupModels(models)
      expect(grouped.some((m) => m.efforts.length >= 2), `recorded ${r.v} has >= 1 grouped family`).toBe(true)
      expect(grouped.some((m) => m.efforts.length === 0), `recorded ${r.v} has >= 1 ungrouped model`).toBe(true)
    }

    skipIfMissing(skip)
    if (!cap) return
    // Inside the recorder's offline sandbox, `agy models` exits 0 (if cached/offline) or 1 ("Please sign in"), and parseModels never throws
    expect([0, 1], `exit ${cap.models.code}: ${cap.models.err}`).toContain(cap.models.code)
    expect(() => parseModels(cap!.models.out)).not.toThrow()
  })

  it('K-AG-4 · the installed binary contains the statusLine settings keys and feed payload fields Kea relies on (read from disk, never executed)', ({ skip }) => {
    const needles = [
      SETTINGS_KEYS.statusLine,
      SETTINGS_KEYS.statusLineStack,
      FEED_FIELDS.agentState,
      FEED_FIELDS.toolConfirmationPending,
      FEED_FIELDS.conversationId,
    ]
    expect(needles).toEqual([
      'statusLine',
      'stack_with_default',
      'agent_state',
      'tool_confirmation_pending',
      'conversation_id',
    ])
    if (!bin) {
      skip('no agy on PATH (KEA_CONTRACT_AGY names another): nothing to read')
      return
    }
    const real = fs.realpathSync(bin)
    const found = stringsIn(real, needles)
    expect(
      needles.filter((n) => !found.has(n)),
      `missing from ${real}`,
    ).toEqual([])
  })
})

describe('Antigravity CLI static contract cache', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    for (const c of cleanup.splice(0).reverse()) c()
  })

  it('K-AG-5 · a cache miss spawns zero processes unless KEA_CONTRACT_CAPTURE_AG=1 (`pnpm test:contract:capture:agy`); neither KEA_CONTRACT_CAPTURE=1 nor KEA_CONTRACT_CAPTURE_CM=1 starts `agy`', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-contract-ag-')))
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const marker = path.join(root, 'launched')
    const stand = path.join(root, 'bin', 'agy')
    fs.mkdirSync(path.dirname(stand), { recursive: true })
    fs.writeFileSync(stand, `#!/bin/sh\necho launched >> '${marker}'\necho 9.9.9\n`, { mode: 0o755 })
    const empty = path.join(root, 'cache')
    fs.mkdirSync(empty)

    expect(agCaptureAllowed({}), 'unset').toBe(false)
    expect(agCaptureAllowed({ KEA_CONTRACT_CAPTURE: '1' }), 'Claude switch does not enable Antigravity capture').toBe(false)
    expect(agCaptureAllowed({ KEA_CONTRACT_CAPTURE_CM: '1' }), 'Command Code switch does not enable Antigravity capture').toBe(false)
    expect(agCaptureAllowed({ KEA_CONTRACT_CAPTURE: '1', KEA_CONTRACT_CAPTURE_CM: '1' }), 'both other switches').toBe(false)
    expect(agCaptureAllowed({ [AG_CAPTURE_ENV]: '1' })).toBe(true)

    for (const env of [{}, { KEA_CONTRACT_CAPTURE: '1' }, { KEA_CONTRACT_CAPTURE_CM: '1' }, { KEA_CONTRACT_CAPTURE: '1', KEA_CONTRACT_CAPTURE_CM: '1' }]) {
      const r = await captureAntigravity(stand, { cacheDir: empty, allow: agCaptureAllowed(env) })
      expect({
        ran: r.ran,
        capture: r.capture,
        launched: fs.existsSync(marker),
        cached: fs.readdirSync(empty),
      }).toEqual({ ran: false, capture: null, launched: false, cached: [] })
      expect(r.skipped).toContain(AG_CAPTURE_COMMAND)
      expect(r.skipped).toContain(`${AG_RUNS.length} launches`)
    }
  })
})
