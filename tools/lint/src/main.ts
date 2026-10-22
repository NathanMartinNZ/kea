// `pnpm lint` — architecture lint (tools/lint/README.md):
//   boundaries     U-LINT-1  package boundaries: imports follow the package graph
//   tokens         DS-2      design tokens only, in renderer, ui and main code
//   agent-strings  U-AGT-11  agent-specific strings only in packages/adapters
//   os             U-PLT-1   OS-specific code only in os/ folders; `// os-ok` lines counted
// Prints `file:line rule message` per violation; exits 1 if there is any.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AgentString, checkAgentStrings, contractStrings, isAgentScanned, SEED } from './agent-strings.ts'
import { type PackageInfo, checkImports, packageInfo } from './boundaries.ts'
import { checkOsNames, isOsScanned } from './os-names.ts'
import { checkTokens, isTokenLinted } from './tokens.ts'
import { formatViolation, type Violation } from './types.ts'

function repoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error('kea repo root not found')
    dir = up
  }
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target', 'coverage', '.vite'])

function walk(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile()) out.push(p)
  }
  return out
}

const root = repoRoot()
const rel = (p: string) => relative(root, p)
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

const packages: PackageInfo[] = []
for (const top of ['app', 'packages']) {
  const dir = join(root, top)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir).sort()) {
    const pj = join(dir, name, 'package.json')
    if (existsSync(pj)) packages.push(packageInfo(`${top}/${name}`, readJson(pj)))
  }
}
const rootPkg = readJson(join(root, 'package.json'))
const rootDevDeps = new Set(Object.keys((rootPkg.devDependencies as Record<string, string>) ?? {}))

// The agent-strings list: the seed plus whatever the adapters' contracts declare
const agentList: AgentString[] = [...SEED]
const adaptersSrc = join(root, 'packages/adapters/src')
if (existsSync(adaptersSrc)) {
  for (const d of readdirSync(adaptersSrc, { withFileTypes: true })) {
    const c = join(adaptersSrc, d.name, 'contract.ts')
    if (d.isDirectory() && existsSync(c)) agentList.push(...contractStrings(readFileSync(c, 'utf8'), rel(c)))
  }
}
const seen = new Set<string>()
const agentStrings = agentList.filter((a) => (seen.has(a.text) ? false : (seen.add(a.text), true)))

const violations: Violation[] = []
let files = 0
for (const pkg of packages) {
  for (const abs of walk(join(root, pkg.dir, 'src'))) {
    if (!/\.(?:[cm]?[jt]sx?|svelte)$/.test(abs) || abs.endsWith('.d.ts')) continue
    files++
    violations.push(...checkImports(rel(abs), readFileSync(abs, 'utf8'), pkg, { packages, rootDevDeps }))
  }
}
for (const abs of [...walk(join(root, 'app/renderer/src')), ...walk(join(root, 'packages/ui/src'))]) {
  if (!isTokenLinted(rel(abs))) continue
  files++
  violations.push(...checkTokens(rel(abs), readFileSync(abs, 'utf8')))
}
for (const abs of [...walk(join(root, 'app')), ...walk(join(root, 'native/kea-helper/src'))]) {
  const p = rel(abs)
  if (!isAgentScanned(p)) continue
  files++
  violations.push(...checkAgentStrings(p, readFileSync(abs, 'utf8'), agentStrings))
}

// The os rule covers the whole repository: app/, packages/, tools/, tests/, the helper, and the root's own config files
let osAllowed = 0
for (const abs of [...['app', 'packages', 'tools', 'tests', 'native/kea-helper'].flatMap((d) => walk(join(root, d))), ...readdirSync(root).map((f) => join(root, f))]) {
  const p = rel(abs)
  if (!isOsScanned(p) || !existsSync(abs) || !statSync(abs).isFile()) continue
  files++
  const r = checkOsNames(p, readFileSync(abs, 'utf8'))
  violations.push(...r.violations)
  osAllowed += r.allowed
}

violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
for (const v of violations) console.log(formatViolation(v))
const contracts = agentStrings.filter((a) => a.source !== 'seed').length
console.error(
  `lint: ${violations.length} violation${violations.length === 1 ? '' : 's'} (${packages.length} packages, ${files} file checks; ` +
    `${agentStrings.length} agent strings, ${contracts} from adapter contracts; ${osAllowed} line${osAllowed === 1 ? '' : 's'} let through by os-ok)`,
)
process.exit(violations.length > 0 ? 1 : 0)
