// `pnpm record:cassette`: record scenarios from tools/recorder/scenarios into fixtures/cassettes/.raw/ (gitignored).
// Commit them only through `pnpm fixtures:scrub`.
//
//   pnpm record:cassette <name|file.json>… | --all  [--agent-bin <path>] [--helper <path>] [--out <dir>] [--repo <dir>]
//
// The agent binary defaults to the first `claude` on PATH; the helper to the release build of kea-helper.

import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { record, validateScenario } from './record.ts'

const root = resolve(import.meta.dirname, '..', '..', '..')
const scenarioDir = join(root, 'tools/recorder/scenarios')
const argv = process.argv.slice(2)
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const valueFlags = new Set(['--agent-bin', '--helper', '--out', '--repo'])
const names = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1] ?? ''))

function onPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, bin)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // next
    }
  }
  return null
}

const files = argv.includes('--all')
  ? readdirSync(scenarioDir).filter((f) => f.endsWith('.json')).map((f) => join(scenarioDir, f))
  : names.map((n) => (n.endsWith('.json') ? resolve(n) : join(scenarioDir, `${n}.json`)))
if (files.length === 0) {
  console.error('usage: pnpm record:cassette <name|file.json>… | --all [--agent-bin <path>] [--helper <path>] [--out <dir>] [--repo <dir>]')
  process.exit(2)
}
const agentBin = opt('agent-bin') ?? onPath('claude')
if (!agentBin) throw new Error('no `claude` on PATH: pass --agent-bin')
const helper = opt('helper') ?? join(root, 'native/kea-helper/target/release/kea-helper')
if (!existsSync(helper)) throw new Error(`no helper at ${helper}: run pnpm helper:build`)
const outDir = resolve(opt('out') ?? join(root, 'fixtures/cassettes/.raw'))
const repo = opt('repo')

let failed = 0
for (const f of files) {
  const s = validateScenario(JSON.parse(readFileSync(f, 'utf8')), f)
  try {
    const r = await record(s, { agentBin, helper, outDir, ...(repo ? { repo: resolve(repo) } : {}), log: (m) => console.log(`  ${m}`) })
    console.log(
      `✓ ${s.name}: ${(r.bytes / 1024).toFixed(1)} KiB in ${r.seconds.toFixed(1)} s, ${r.modelRequests} model requests, alt screen ${r.altScreen ? 'yes' : 'no'} → ${r.file}`,
    )
    if (r.refusedNetwork.length) console.log(`  refused network attempts (${r.refusedNetwork.length}): ${r.refusedNetwork.slice(0, 5).join('; ')}`)
  } catch (e) {
    failed++
    console.error(`✗ ${s.name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
if (failed) process.exitCode = 1
else console.log(`\nraw cassettes in ${outDir}: review, then \`pnpm fixtures:scrub\` before committing`)
