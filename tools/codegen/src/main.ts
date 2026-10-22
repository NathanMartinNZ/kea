// `pnpm codegen` writes the generated files; `pnpm codegen --check` fails if any is stale (R-LIM-1).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateAll } from './codegen.ts'
import { repoRoot } from './paths.ts'

const root = repoRoot()
const check = process.argv.includes('--check')
const files = generateAll({
  limits: readFileSync(join(root, 'constants/limits.toml'), 'utf8'),
  budgets: readFileSync(join(root, 'constants/budgets.toml'), 'utf8'),
  tokens: readFileSync(join(root, 'constants/tokens.json'), 'utf8'),
})

const stale: string[] = []
for (const f of files) {
  const abs = join(root, f.path)
  const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null
  if (current === f.content) continue
  if (check) {
    stale.push(f.path)
  } else {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.content)
    console.log(`wrote ${f.path}`)
  }
}
if (check && stale.length > 0) {
  console.error(`codegen: stale generated files (run \`pnpm codegen\`):\n  ${stale.join('\n  ')}`)
  process.exit(1)
}
if (check) console.log('codegen: generated files are fresh')
