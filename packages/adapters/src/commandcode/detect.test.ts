import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMANDS, FLAGS, MIN_VERSION, PERMISSION_MODES } from './contract.ts'
import { detect, modesOffered, options, parseHelpFlags, parseHelpModes, parseModels, parseStatus, parseVersion } from './detect.ts'

const CLI = fileURLToPath(new URL('../../../../fixtures/cli/commandcode/1.79.2/', import.meta.url))
const read = (f: string) => fs.readFileSync(path.join(CLI, f), 'utf8')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A stand-in `cmd` that answers the four detection commands from files, each with its exit code. */
function stub(o: { version: string; status?: { out: string; code: number }; help?: string; models?: string; name?: string }): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt21-'))
  dirs.push(dir)
  const put = (name: string, text: string) => {
    fs.writeFileSync(path.join(dir, name), text)
    return path.join(dir, name)
  }
  const status = o.status ?? { out: '{"authenticated":true,"version":"1.79.2"}', code: 0 }
  const lines = [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then /bin/cat '${put('v.txt', `${o.version}\n`)}'; exit 0; fi`,
    `if [ "$1" = "status" ] && [ "$2" = "--json" ]; then /bin/cat '${put('s.txt', status.out)}'; exit ${status.code}; fi`,
    o.help === undefined ? 'if [ "$1" = "--help" ]; then exit 2; fi' : `if [ "$1" = "--help" ]; then /bin/cat '${put('h.txt', o.help)}'; exit 0; fi`,
    o.models === undefined ? 'if [ "$1" = "--list-models" ]; then exit 2; fi' : `if [ "$1" = "--list-models" ]; then /bin/cat '${put('m.txt', o.models)}'; exit 0; fi`,
    'exit 2',
  ]
  const file = path.join(dir, o.name ?? 'cmd')
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 })
  return { dir, file }
}

describe('commandcode detection and options', () => {
  it('U-AGT-6 · --list-models: the recorded text → its rows (provider headings skipped, the (default) marker, :free ids); garbage → an empty list, never a throw', () => {
    const text = read('list-models.txt')
    const models = parseModels(text)
    // the header says how many there are; the rows under "Decision models" (after the hint) are not offered
    expect(models).toHaveLength(Number(/(\d+) models/.exec(text)?.[1]))
    expect(models).toHaveLength(87)
    expect(models[0]).toEqual({ id: 'deepseek/deepseek-v4-pro', description: 'hybrid-attention long-context reasoning', isDefault: false })
    expect(models.filter((m) => m.isDefault)).toEqual([{ id: 'deepseek/deepseek-v4-flash', description: 'fast hybrid-attention reasoning', isDefault: true }])
    expect(models.find((m) => m.id === 'inclusionai/ling-3.0-flash-sante:free')?.description).toMatch(/^FREE health/)
    expect(models.filter((m) => m.id.endsWith(':free')).length).toBeGreaterThanOrEqual(3)
    expect(models.map((m) => m.id)).not.toContain('typesafe/jev')
    // no heading, header or hint line is taken for a model
    for (const m of models) expect(m.id).toMatch(/^[a-z0-9][\w.:/-]*[a-z0-9]$/)
    for (const heading of ['Open Source', 'Anthropic', 'OpenAI', 'xAI', 'Meta', 'Available', 'Docs', 'cmd']) expect(models.map((m) => m.id)).not.toContain(heading)
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length)

    // colours (a terminal run), CRLF, a repeated row
    expect(parseModels('\x1b[1mOpenAI\x1b[0m\r\n\x1b[36mopenai/gpt-x\x1b[0m   \x1b[2mfast\x1b[0m (default)\r\nopenai/gpt-x   again\r\n')).toEqual([{ id: 'openai/gpt-x', description: 'fast', isDefault: true }])
    // anything else: nothing, and no throw
    for (const garbage of ['', '\n\n', 'Error: Not authenticated. Please run "cmd login" first.', '{"models":[{"id":"a/b"}]}', '<html><body>502</body></html>', '\x00\x01\x02 binary \xff', 'one two three four', 'x'.repeat(100_000)]) {
      expect(parseModels(garbage)).toEqual([])
    }
    // a list longer than the cap is cut, not refused
    const many = Array.from({ length: L.ccModelsMax + 50 }, (_, i) => `vendor/model-${i}   text`).join('\n')
    expect(parseModels(many)).toHaveLength(L.ccModelsMax)

    // the composer's models: Default first (no --model), then the CLI's own, each with the effort levels; free text stays
    const o = options({ listed: { models, permissionModes: null } })
    expect(o.allowCustomModel).toBe(true)
    expect(o.models).toHaveLength(88)
    expect(o.models[0]).toEqual({ id: 'default', label: 'Default (Command Code’s own)', efforts: ['low', 'medium', 'high'], isDefault: true })
    expect(o.models[1]).toEqual({ id: 'deepseek/deepseek-v4-pro', label: 'deepseek/deepseek-v4-pro', efforts: ['low', 'medium', 'high'], isDefault: false })
    expect(o.models.filter((m) => m.isDefault)).toHaveLength(1)
    // no list (the parser failed soft, or nothing detected yet): Default alone, and a model can still be typed
    for (const d of [{}, { listed: { models: null, permissionModes: null } }]) {
      expect(options(d).models.map((m) => m.id)).toEqual(['default'])
      expect(options(d).allowCustomModel).toBe(true)
    }
  })

  it('U-AGT-13 · permission modes come from the recorded --help: 1.79.2 lists standard, plan, accept-edits, yolo; standard ≡ default; a help that names default and dont-ask offers those', () => {
    const help = read('help.txt')
    expect(parseHelpModes(help)).toEqual(['standard', 'plan', 'accept-edits', 'yolo'])
    // what is offered: Kea's ids in the contract's order; `standard` is the default mode; yolo is dangerous
    expect(modesOffered(parseHelpModes(help))).toEqual([
      { id: 'default', label: 'Ask before edits', dangerous: false },
      { id: 'accept-edits', label: 'Accept edits', dangerous: false },
      { id: 'plan', label: 'Plan', dangerous: false },
      { id: 'yolo', label: 'Bypass permissions (yolo)', dangerous: true },
    ])
    // a help that lists the newer names (not recorded: a line in 1.79.2's layout): default and dont-ask are offered
    const newer = help.replace('(standard, plan, accept-edits, yolo)', '(default, plan, accept-edits, dont-ask, yolo)')
    expect(newer).not.toBe(help)
    expect(parseHelpModes(newer)).toEqual(['default', 'plan', 'accept-edits', 'dont-ask', 'yolo'])
    expect(modesOffered(parseHelpModes(newer)).map((m) => m.id)).toEqual(['default', 'accept-edits', 'plan', 'dont-ask', 'yolo'])
    // both spellings at once are one mode
    expect(modesOffered(['standard', 'default']).map((m) => m.id)).toEqual(['default'])
    // a name the contract does not know is offered under its own name; one that sounds dangerous is gated like yolo
    expect(modesOffered(['standard', 'review', 'skip-all'])).toEqual([
      { id: 'default', label: 'Ask before edits', dangerous: false },
      { id: 'review', label: 'review', dangerous: false },
      { id: 'skip-all', label: 'skip-all', dangerous: true },
    ])
    // no help text read (not detected yet, a help in another layout): the modes of the verified version
    for (const none of [null, [], parseHelpModes('usage: cmd [options]'), parseHelpModes('')]) expect(modesOffered(none).map((m) => m.id)).toEqual(['default', 'accept-edits', 'plan', 'yolo'])
    expect(options({}).permissionModes.map((m) => m.id)).toEqual(['default', 'accept-edits', 'plan', 'yolo'])
    for (const m of options({ listed: { models: null, permissionModes: ['default', 'plan', 'accept-edits', 'dont-ask', 'yolo'] } }).permissionModes) expect(PERMISSION_MODES.map((x) => x.id)).toContain(m.id)
    // every flag the adapter passes is in the recorded help (K-CM-2 checks the installed CLI's)
    const flags = parseHelpFlags(help)
    for (const f of Object.values(FLAGS)) expect(flags).toContain(f)
  })

  it('U-AGT-38 · detect: path, version against the minimum, signed in from status --json, the two lists; missing, outdated, signed out and unreadable are values, never throws', async () => {
    expect(parseVersion(read('version.txt'))).toBe('1.79.2')
    expect(parseVersion('command-code v1.80.0\n')).toBeNull()
    expect(parseVersion('v1.80.0\n')).toBe('1.80.0')
    expect(parseVersion('')).toBeNull()
    // the recorded answer of a signed-out CLI (exit 1); the JSON wins over the exit code; no JSON: the exit code
    expect(parseStatus(1, read('status.json'))).toBe(false)
    expect(parseStatus(0, '{"authenticated":true,"version":"1.79.2","user":"u"}')).toBe(true)
    expect(parseStatus(0, '{"authenticated":false}')).toBe(false)
    expect(parseStatus(0, 'Signed in')).toBe(true)
    expect(parseStatus(1, '')).toBe(false)
    expect(parseStatus(2, 'boom')).toBeNull()
    expect(parseStatus(null, '')).toBeNull()

    const ok = stub({ version: '1.79.2', help: read('help.txt'), models: read('list-models.txt') })
    const d = await detect({ PATH: `/nonexistent:${ok.dir}` }, null)
    expect(d).toMatchObject({ installed: true, path: ok.file, version: '1.79.2', supported: true, loggedIn: true, notice: null })
    expect(d.listed?.models).toHaveLength(87)
    expect(d.listed?.permissionModes).toEqual(['standard', 'plan', 'accept-edits', 'yolo'])
    expect(options(d).models).toHaveLength(88)

    // only `cmd` is looked up (the first of its names); the override wins and must be executable
    expect(COMMANDS[0]).toBe('cmd')
    const other = stub({ version: '1.79.2', name: 'commandcode' })
    expect((await detect({ PATH: other.dir }, null)).installed).toBe(false)
    expect((await detect({ PATH: '/nonexistent' }, other.file)).installed).toBe(true)
    const gone = await detect({ PATH: ok.dir }, '/nonexistent/cmd')
    expect(gone).toMatchObject({ installed: false, path: null, supported: false })
    expect(gone.notice).toContain('/nonexistent/cmd')
    const missing = await detect({ PATH: '/nonexistent' }, null)
    expect(missing).toMatchObject({ installed: false, path: null, version: null, loggedIn: null })
    expect(missing.notice).toContain('not installed')

    // signed out: installed and supported, with the command that signs in
    const out = await detect({ PATH: stub({ version: '1.79.2', status: { out: read('status.json'), code: 1 } }).dir }, null)
    expect(out).toMatchObject({ installed: true, supported: true, loggedIn: false })
    expect(out.notice).toBe('Command Code is signed out: run cmd login in a terminal')
    // no help, no list (each exits 2): detection stands, the lists are null and the options fall back
    expect(out.listed).toEqual({ models: null, permissionModes: null })

    // below the minimum: outdated; at it and an unknown newer one: supported
    const old = await detect({ PATH: stub({ version: '1.73.9' }).dir }, null)
    expect(old).toMatchObject({ installed: true, version: '1.73.9', supported: false })
    expect(old.notice).toContain(MIN_VERSION)
    expect((await detect({ PATH: stub({ version: MIN_VERSION }).dir }, null)).supported).toBe(true)
    expect((await detect({ PATH: stub({ version: '9.0.0' }).dir }, null)).supported).toBe(true)
    // a version that cannot be read is not refused, and says so
    const odd = await detect({ PATH: stub({ version: 'nightly build' }).dir }, null)
    expect(odd).toMatchObject({ installed: true, version: null, supported: true })
    expect(odd.notice).toContain('version')
  })
})
