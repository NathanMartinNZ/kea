import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FLAGS, MIN_VERSION, PERMISSION_MODES } from './contract.ts'
import { detect, effortsFor, options, parseAuth, parseHelp, parseVersion } from './detect.ts'

const CLI = fileURLToPath(new URL('../../../../fixtures/cli/claude/2.1.296/', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A stand-in `claude` that prints `version` and answers `auth status` with `auth` and exit `code`. */
function stub(version: string, auth: { json: string; code: number }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt8-'))
  dirs.push(dir)
  const file = path.join(dir, 'claude')
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nif [ "$1" = "auth" ]; then echo '${auth.json}'; exit ${auth.code}; fi\nexit 2\n`, { mode: 0o755 })
  return dir
}

describe('claude detection and options', () => {
  it('U-AGT-8 · version gates: options below, at and above each gate; an unknown newer version is assumed compatible', async () => {
    const modeIds = (v: string | null) => options({ version: v }).permissionModes.map((m) => m.id)
    // `manual` names the default mode from its gate on; below it the old name is offered
    expect(modeIds('2.1.199')[0]).toBe('default')
    expect(modeIds('2.1.200')[0]).toBe('manual')
    expect(modeIds('2.1.201')[0]).toBe('manual')
    expect(modeIds('9.0.0')).toEqual(PERMISSION_MODES.map((m) => m.id))
    expect(modeIds(null)).toEqual(PERMISSION_MODES.map((m) => m.id))
    // bypass is listed and marked dangerous (the composer hides it unless allowed)
    expect(options({ version: '2.1.296' }).permissionModes.find((m) => m.id === 'bypassPermissions')?.dangerous).toBe(true)
    // models: the static list plus free text; default first; haiku without efforts; xhigh hidden for 4.6-era ids
    const o = options({ version: '2.1.296' })
    expect(o.allowCustomModel).toBe(true)
    expect(o.models[0]).toMatchObject({ id: 'default', isDefault: true })
    expect(o.models.find((m) => m.id === 'haiku')?.efforts).toEqual([])
    expect(o.models.find((m) => m.id === 'opus')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortsFor('claude-opus-4-6')).not.toContain('xhigh')
    // the minimum: below it usable with a notice; at and above supported; newer assumed compatible
    const at = (v: string) => detect({ PATH: stub(`${v} (Claude Code)`, { json: '{"loggedIn":true}', code: 0 }) }, null)
    const below = await at('2.1.210')
    expect(below).toMatchObject({ installed: true, version: '2.1.210', supported: false, loggedIn: true })
    expect(below.notice).toMatch(new RegExp(MIN_VERSION.replace(/\./g, '\\.')))
    expect(await at(MIN_VERSION)).toMatchObject({ supported: true, notice: null })
    expect(await at('3.0.0')).toMatchObject({ supported: true, notice: null })
    // signed out: exit 1, and the notice names the command that signs in (the one Settings offers to copy); missing: not installed, with no run at all
    expect(await detect({ PATH: stub('2.1.296 (Claude Code)', { json: '{"loggedIn":false}', code: 1 }) }, null)).toMatchObject({ supported: true, loggedIn: false, notice: 'Claude Code is signed out: run claude auth login in a terminal' })
    expect(await detect({ PATH: '/nonexistent' }, null)).toMatchObject({ installed: false, path: null, version: null })
    // the override wins over PATH, and must be executable
    const dir = stub('2.1.296 (Claude Code)', { json: '{}', code: 0 })
    expect(await detect({ PATH: '/nonexistent' }, path.join(dir, 'claude'))).toMatchObject({ installed: true, path: path.join(dir, 'claude') })
    expect(await detect({ PATH: dir }, '/nonexistent/claude')).toMatchObject({ installed: false })
    // parsers
    expect(parseVersion(fs.readFileSync(`${CLI}version.txt`, 'utf8'))).toBe('2.1.296')
    expect(parseVersion('0.1.0 (fake-agent claude)')).toBeNull()
    expect(parseAuth(0, 'not json')).toBe(true)
    expect(parseAuth(1, '')).toBe(false)
    expect(parseAuth(null, '')).toBeNull()
    const help = parseHelp(fs.readFileSync(`${CLI}help.txt`, 'utf8'))
    for (const f of Object.values(FLAGS)) expect(help.flags.has(f)).toBe(true)
    expect(help.permissionModes).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
    expect(help.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})
