// The GPU memory test on its own: runs P-GPU-2 (tests/perf/app-gpu.test.ts, whose scene is tests/perf/app-gpu-soak.ts) for
// the given duration through Vitest's perf project, then prints the report's summary and its draft results row
// (`resultsRow`). The report (time series + summary) is written under test-results/perf/. Run the full two hours on a
// quiet machine, on AC power, with nothing else heavy running.
//
//   node tools/perf/src/gpu-soak.ts [--duration 2h|90m|300s|<ms>] [--sample 10s] [--out <report.json>]
//   node tools/perf/src/gpu-soak.ts --summary <report.json>        (print a saved report's summary again)

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..', '..')
const argv = process.argv.slice(2)
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

/** `2h`, `90m`, `300s` or plain milliseconds. */
function duration(s: string, what: string): number {
  const m = /^(\d+(?:\.\d+)?)(h|m|s|ms)?$/.exec(s.trim())
  if (!m) {
    console.error(`gpu-soak: ${what} must look like 2h, 90m, 300s or a number of ms, got ${s}`)
    process.exit(2)
  }
  const n = Number(m[1])
  return Math.round(m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n)
}

function show(file: string): void {
  const r = JSON.parse(fs.readFileSync(file, 'utf8')) as { summary: Record<string, unknown> & { resultsRow: string } }
  const { resultsRow, ...summary } = r.summary
  console.log(`\nGPU memory run report: ${path.relative(root, file)}\n\n${JSON.stringify(summary, null, 2)}\n\nDraft results row:\n\n${resultsRow}`)
}

const saved = value('summary')
if (saved) {
  show(saved)
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = path.resolve(value('out') ?? path.join(root, 'test-results', 'perf', `gpu-soak-${stamp}.json`))
const env: Record<string, string | undefined> = { ...process.env, KEA_GPU_SOAK_DURATION_MS: String(duration(value('duration') ?? '2h', '--duration')), KEA_GPU_SOAK_OUT: out }
if (value('sample')) env.KEA_GPU_SOAK_SAMPLE_MS = String(duration(value('sample') as string, '--sample'))

const vitest = path.join(path.dirname(createRequire(path.join(root, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs')
const r = spawnSync(process.execPath, [vitest, 'run', '--project', 'perf', 'tests/perf/app-gpu.test.ts', '-t', 'P-GPU-2 ·'], { cwd: root, env, stdio: 'inherit' })
if (fs.existsSync(out)) show(out)
else console.error(`gpu-soak: no report at ${out}`)
process.exitCode = r.status ?? 1
