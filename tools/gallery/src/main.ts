// `pnpm gallery`: drives the app through the gallery's sets and writes dist/gallery/index.html, one static page of
// labelled screens for a person to hold against the design system. Never part of `pnpm verify`.
//
//   node tools/gallery/src/main.ts [--only V-1,V-5,…] [--review]
//     --only     only these sets (the others' screens from an earlier run stay on the page)
//     --review   also the review sets (R-…): states one or two clicks away in the running app, kept as screens for a
//                design review of the whole app
//
// The sets are tools/gallery/src/*.gallery.ts, run by Playwright (tools/gallery/playwright.config.ts) one after
// another: each launches Kea unfocused on a temporary KEA_HOME with the fake agent, never a real agent CLI.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { galleryHtml, SET_ORDER } from './page.ts'
import { GALLERY_DIR, type SetFile } from './shots.ts'

const root = path.resolve(import.meta.dirname, '..', '..', '..')
const argv = process.argv.slice(2)
const usage = 'usage: node tools/gallery/src/main.ts [--only V-1,V-5,…] [--review]'
let only: string[] | null = null
let review = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string
  if (a === '--review') review = true
  else if (a === '--only' && argv[i + 1]) only = (argv[++i] as string).split(',').map((s) => s.trim()).filter(Boolean)
  else {
    console.error(`pnpm gallery: unknown option ${a}\n${usage}`)
    process.exit(2)
  }
}
if (only?.some((id) => !/^[VR]-\d+$/.test(id))) {
  console.error(`pnpm gallery: --only takes set ids (V-1,V-5 or R-1), got ${only.join(',')}\n${usage}`)
  process.exit(2)
}

// a full run starts from nothing; a partial one replaces its own sets only (GallerySet clears a set's files)
if (!only) fs.rmSync(GALLERY_DIR, { recursive: true, force: true })
fs.mkdirSync(GALLERY_DIR, { recursive: true })

const playwright = path.join(path.dirname(createRequire(path.join(root, 'tests/package.json')).resolve('@playwright/test/package.json')), 'cli.js')
const args = [playwright, 'test', '-c', path.join(root, 'tools/gallery/playwright.config.ts')]
// a set's title begins with its id and " · " (Playwright matches the file's name and the title together)
if (only) args.push('-g', `(?:^| )(${only.join('|')}) ·`)
const started = Date.now()
const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...(review || only?.some((id) => id.startsWith('R-')) ? { KEA_GALLERY_REVIEW: '1' } : {}) } })

const sets: SetFile[] = []
for (const f of fs.readdirSync(GALLERY_DIR).sort()) {
  if (!/^[VR]-\d+[a-z]?\.json$/.test(f)) continue
  sets.push(JSON.parse(fs.readFileSync(path.join(GALLERY_DIR, f), 'utf8')) as SetFile)
}
const missing = SET_ORDER.filter((id) => !sets.some((s) => s.id === id))
const page = path.join(GALLERY_DIR, 'index.html')
fs.writeFileSync(page, galleryHtml(sets, { taken: new Date().toISOString().slice(0, 16).replace('T', ' '), missing }))
const screens = sets.reduce((n, s) => n + s.screens.length, 0)
console.log(`\n${path.relative(root, page)}: ${screens} screens in ${sets.length} sets, ${Math.round((Date.now() - started) / 1000)} s${missing.length ? ` (not taken: ${missing.join(', ')})` : ''}`)
process.exit(run.status ?? 1)
