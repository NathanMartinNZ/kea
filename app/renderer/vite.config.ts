import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Built into dist/app/renderer by tools/build.ts and served by main from kea://app/; there is no Vite dev server.
// Svelte 5 in runes mode: the compiler options are the repo's svelte.config.js.
/** The commit this build is made from (Settings › About shows it), `-dirty` with uncommitted changes; empty outside a checkout. */
function buildCommit(): string {
  try {
    return execFileSync('git', ['describe', '--always', '--dirty', '--abbrev=7'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/**
 * Svelte without its dev mode in a dev build: tools/build.ts `--svelte-production` (the memory suite's build) sets it.
 * The compiler's `dev: false`, and the `production` export condition (Vite's default for a production build), so
 * Svelte's runtime is its production one too. Vite's mode and NODE_ENV, and what they guard, stay as they are.
 * Otherwise Svelte's mode follows Vite's: dev unless NODE_ENV is `production`.
 */
const svelteProduction = process.env.KEA_SVELTE_PRODUCTION === '1'

/** The day this build is made, `YYYY-MM-DD` in UTC (Settings › About): a day, so builds of one day stay alike. */
const buildDate = (): string => new Date().toISOString().slice(0, 10)

export default defineConfig({
  define: { __KEA_BUILD_COMMIT__: JSON.stringify(buildCommit()), __KEA_BUILD_DATE__: JSON.stringify(buildDate()) },
  root: import.meta.dirname,
  base: '/',
  plugins: [svelte({ configFile: path.join(import.meta.dirname, '../../svelte.config.js'), ...(svelteProduction ? { compilerOptions: { dev: false } } : {}) })],
  ...(svelteProduction ? { resolve: { conditions: ['module', 'browser', 'production'] } } : {}),
  // the highlight worker is a module worker: its grammars and the Oniguruma WASM stay separate chunks, loaded on first use
  worker: { format: 'es' },
  build: { outDir: '../../dist/app/renderer', emptyOutDir: true, target: 'chrome140', sourcemap: true, modulePreload: { polyfill: false } },
})
