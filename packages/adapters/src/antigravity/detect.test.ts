import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMANDS, EFFORTS, FLAGS, MIN_VERSION, PERMISSION_MODES } from './contract.ts'
import { detect, groupModels, modesOffered, options, parseHelpEfforts, parseHelpFlags, parseHelpModes, parseModels, parseVersion } from './detect.ts'

const CLI = fileURLToPath(new URL('../../../../fixtures/cli/antigravity/1.5.13/', import.meta.url))
const read = (f: string) => fs.readFileSync(path.join(CLI, f), 'utf8')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A stand-in `agy` binary answering `--version` (stdout), `--help` (stderr by default), and `models` (stdout). */
function stub(o: {
  version: string
  help?: string
  helpToStdout?: boolean
  models?: string
  modelsCode?: number
  name?: string
}): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt55-'))
  dirs.push(dir)
  const put = (name: string, text: string) => {
    fs.writeFileSync(path.join(dir, name), text)
    return path.join(dir, name)
  }
  const helpRedirect = o.helpToStdout ? '' : ' >&2'
  const lines = [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then /bin/cat '${put('v.txt', `${o.version}\n`)}'; exit 0; fi`,
    o.help === undefined
      ? 'if [ "$1" = "--help" ]; then exit 2; fi'
      : `if [ "$1" = "--help" ]; then /bin/cat '${put('h.txt', o.help)}'${helpRedirect}; exit 0; fi`,
    o.models === undefined
      ? 'if [ "$1" = "models" ]; then exit 2; fi'
      : `if [ "$1" = "models" ]; then echo "Fetching available models..." >&2; /bin/cat '${put('m.txt', o.models)}'; exit ${o.modelsCode ?? 0}; fi`,
    'exit 2',
  ]
  const file = path.join(dir, o.name ?? 'agy')
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 })
  return { dir, file }
}

describe('antigravity detection and options', () => {
  it('U-AGT-55 · --version, --help (stderr and stdout fallback), and agy models parsing with soft failure and cap', () => {
    expect(parseVersion(read('version.txt'))).toBe('1.5.13')
    expect(parseVersion('v1.5.13\n')).toBe('1.5.13')
    expect(parseVersion('agy version 1.5.13\n')).toBe('1.5.13')
    expect(parseVersion('nightly build\n')).toBeNull()
    expect(parseVersion('')).toBeNull()

    const help = read('help.txt')
    expect(parseHelpModes(help)).toEqual(['accept-edits', 'auto', 'plan'])
    expect(parseHelpEfforts(help)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(parseHelpEfforts(help)).toEqual([...EFFORTS])
    const flags = parseHelpFlags(help)
    for (const [k, f] of Object.entries(FLAGS)) {
      if (k !== 'version' && k !== 'help') expect(flags).toContain(f)
    }

    const text = read('models.txt')
    const models = parseModels(text)
    expect(models).toHaveLength(23)
    expect(models[0]).toEqual({ id: 'gemini-4-neon-high', description: 'Gemini 4 Neon (High)', isDefault: false })
    expect(models.find((m) => m.id === 'gemini-pro-orchestrator-neon')).toEqual({
      id: 'gemini-pro-orchestrator-neon',
      description: 'Orchestrator (Neon)',
      isDefault: false,
    })
    expect(models.find((m) => m.id === 'gpt-oss-120b-medium')).toEqual({
      id: 'gpt-oss-120b-medium',
      description: 'GPT-OSS 120B (Medium)',
      isDefault: false,
    })

    // Skips header, blank lines, ANSI escapes, and deduplicates
    const noisy = [
      'Fetching available models...',
      '',
      '\x1b[36mgemini-3.8-flash-low\x1b[0m\tGemini 3.8 Flash (Low)\r',
      'gemini-3.8-flash-low\tDuplicate row',
      'line without tab separator',
    ].join('\n')
    expect(parseModels(noisy)).toEqual([{ id: 'gemini-3.8-flash-low', description: 'Gemini 3.8 Flash (Low)', isDefault: false }])

    // Garbage or error text fails soft to empty array
    for (const garbage of ['', '\n\n', 'Error: Please sign in to view available models.', '{"models":[]}', 'one two three']) {
      expect(parseModels(garbage)).toEqual([])
    }

    // Caps at L.agModelsMax
    const many = Array.from({ length: L.agModelsMax + 25 }, (_, i) => `model-${i}\tModel ${i}`).join('\n')
    expect(parseModels(many)).toHaveLength(L.agModelsMax)
  })

  it('U-AGT-55 · options: groups multi-variant effort families with canonical efforts, preserves single-variant and non-effort models with efforts: [], and marks yolo dangerous', () => {
    const models = parseModels(read('models.txt'))
    const grouped = groupModels(models)
    expect(grouped).toEqual([
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], isDefault: false },
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'], isDefault: false },
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'], isDefault: false },
      { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', efforts: [], isDefault: false },
      { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)', efforts: [], isDefault: false },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], isDefault: false },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], isDefault: false },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'], isDefault: false },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', efforts: [], isDefault: false },
    ])

    const o = options({ listed: { models, permissionModes: ['accept-edits', 'auto', 'plan'] } })
    expect(o.allowCustomModel).toBe(true)
    expect(o.models[0]).toEqual({
      id: 'default',
      label: "Default (Antigravity's own)",
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      isDefault: true,
    })
    expect(o.models.slice(1)).toEqual(grouped)
    expect(o.permissionModes).toEqual([
      { id: 'default', label: 'Ask before edits', dangerous: false },
      { id: 'accept-edits', label: 'Accept edits', dangerous: false },
      { id: 'plan', label: 'Plan', dangerous: false },
      { id: 'auto', label: 'Auto', dangerous: false },
      { id: 'yolo', label: 'Bypass permissions (yolo)', dangerous: true },
    ])

    // Fallback when listed is null or absent
    for (const d of [{}, { listed: { models: null, permissionModes: null } }]) {
      const fb = options(d)
      expect(fb.models).toEqual([
        { id: 'default', label: "Default (Antigravity's own)", efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
      ])
      expect(fb.allowCustomModel).toBe(true)
      expect(fb.permissionModes.map((m) => m.id)).toEqual(PERMISSION_MODES.map((m) => m.id))
    }

    // Unknown mode names in --help are included and checked for dangerous patterns
    expect(modesOffered(['accept-edits', 'sandbox-only', 'bypass-all'])).toEqual([
      { id: 'default', label: 'Ask before edits', dangerous: false },
      { id: 'accept-edits', label: 'Accept edits', dangerous: false },
      { id: 'yolo', label: 'Bypass permissions (yolo)', dangerous: true },
      { id: 'sandbox-only', label: 'sandbox-only', dangerous: false },
      { id: 'bypass-all', label: 'bypass-all', dangerous: true },
    ])
  })

  it('U-AGT-55 · detect: binary lookup, stderr --help, stdout fallback, version gating, ownStatusLine notice, and soft failure when models fails', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt55-home-'))
    dirs.push(home)

    const ok = stub({ version: '1.5.13', help: read('help.txt'), models: read('models.txt') })
    const d = await detect({ PATH: `/nonexistent:${ok.dir}`, HOME: home }, null)
    expect(d).toMatchObject({
      installed: true,
      path: ok.file,
      version: '1.5.13',
      supported: true,
      loggedIn: null,
      notice: null,
    })
    expect(d.listed?.models).toHaveLength(23)
    expect(d.listed?.permissionModes).toEqual(['accept-edits', 'auto', 'plan'])

    // Fallback when --help prints to stdout instead of stderr
    const stdoutHelp = stub({ version: '1.5.13', help: read('help.txt'), helpToStdout: true, models: read('models.txt') })
    const dStdout = await detect({ PATH: stdoutHelp.dir, HOME: home }, null)
    expect(dStdout.listed?.permissionModes).toEqual(['accept-edits', 'auto', 'plan'])

    // Signed-out / offline `agy models` exit 1 fails soft to listed.models = null without failing detection
    const offline = stub({ version: '1.5.13', help: read('help.txt'), models: '', modelsCode: 1 })
    const dOffline = await detect({ PATH: offline.dir, HOME: home }, null)
    expect(dOffline).toMatchObject({ installed: true, supported: true, notice: null })
    expect(dOffline.listed).toEqual({ models: null, permissionModes: ['accept-edits', 'auto', 'plan'] })

    // Version gating: 1.3.4 and newer (including unknown 2.4.0) supported; 1.0.0 unsupported with notice
    expect((await detect({ PATH: stub({ version: MIN_VERSION }).dir, HOME: home }, null)).supported).toBe(true)
    expect((await detect({ PATH: stub({ version: '2.4.0' }).dir, HOME: home }, null)).supported).toBe(true)
    const old = await detect({ PATH: stub({ version: '1.0.0' }).dir, HOME: home }, null)
    expect(old).toMatchObject({ installed: true, version: '1.0.0', supported: false })
    expect(old.notice).toContain(MIN_VERSION)

    // Unreadable version is not refused, with notice
    const unreadable = await detect({ PATH: stub({ version: 'nightly' }).dir, HOME: home }, null)
    expect(unreadable).toMatchObject({ installed: true, version: null, supported: true })
    expect(unreadable.notice).toContain('version')

    // Active user statusLine in ~/.gemini/antigravity-cli/settings.json surfaces a soft warning notice
    const cfgDir = path.join(home, '.gemini', 'antigravity-cli')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo custom' } }))
    const withOwn = await detect({ PATH: ok.dir, HOME: home }, null)
    expect(withOwn.notice).toBe('Antigravity CLI uses your own status line; Kea will estimate status from terminal activity.')

    // Missing binary and command override
    expect(COMMANDS[0]).toBe('agy')
    const missing = await detect({ PATH: '/nonexistent', HOME: home }, null)
    expect(missing).toMatchObject({ installed: false, path: null, version: null, supported: false, loggedIn: null })
    expect(missing.notice).toContain('not installed')
    const badOverride = await detect({ PATH: ok.dir, HOME: home }, '/nonexistent/agy')
    expect(badOverride).toMatchObject({ installed: false, path: null, supported: false })
    expect(badOverride.notice).toContain('/nonexistent/agy')
    const goodOverride = await detect({ PATH: '/nonexistent', HOME: home }, ok.file)
    expect(goodOverride).toMatchObject({ installed: true, path: ok.file })
  })
})
