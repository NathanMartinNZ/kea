// The licences file's own notices: Kea's licence first, then the syntax highlighter's.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { grammarNotice, installedShiki, KNOWN_GRAMMARS, ONIGURUMA, PINNED, releaseNotices, shippedGrammars } from './notices.ts'

const root = path.resolve(import.meta.dirname, '..', '..', '..')
const LANGS = '../../node_modules/.pnpm/@shikijs+langs@4.5.0/node_modules/@shikijs/langs'

describe('the licences file’s notices', () => {
  // Kea's licence comes first, then Electron's, Oniguruma's BSD-2-Clause notice and vscode-oniguruma's MIT licence (no
  // package of Shiki's quotes them), the grammars that ship under their licences, then the extra notices. The grammars
  // come from the modules' paths; another Shiki than the pinned one, or a grammar the table does not have, fails the
  // build. In this tree the installed Shiki is the pinned one and the table has exactly the grammars the viewer loads.
  it('U-PACK-46 · Kea’s licence first, then Oniguruma’s and every shipped grammar’s; another Shiki fails until the table is updated', () => {
    const electron = { title: 'Electron — MIT', text: 'electron licence' }
    const font = { title: 'A font — OFL-1.1', text: 'font licence' }
    const shiki = { langs: PINNED.langs, vscodeOniguruma: PINNED.vscodeOniguruma }
    const notices = releaseNotices({ licence: 'MIT License\n\nCopyright (c) 2026 The Kea contributors\n', electron, shiki, grammars: ['nginx', 'typescript'], more: [font] })
    expect(notices.map((n) => n.title.split(' ')[0])).toEqual(['Kea', 'Electron', 'Oniguruma', 'vscode-oniguruma', 'TextMate', 'A'])
    expect(notices[0]).toEqual({ title: 'Kea — MIT', text: 'MIT License\n\nCopyright (c) 2026 The Kea contributors\n' })
    expect(ONIGURUMA[0]?.title).toMatch(/— BSD-2-Clause$/)
    expect(ONIGURUMA[0]?.text).toContain('Copyright (c) 2002-2021  K.Kosako')
    expect(ONIGURUMA[0]?.text).toContain('2. Redistributions in binary form must reproduce the above copyright')
    expect(ONIGURUMA[1]?.text).toContain('Copyright (c) Microsoft Corporation.')

    const grammars = notices[4]?.text ?? ''
    expect(grammars).toContain(`https://cdn.jsdelivr.net/npm/tm-grammars@${PINNED.tmGrammars}/NOTICE`)
    expect(grammars.split('\n').slice(-2)).toEqual(['MIT: typescript', 'GPL-3.0: nginx'])
    const all = grammarNotice({ version: PINNED.langs, names: KNOWN_GRAMMARS }).text
    for (const g of KNOWN_GRAMMARS) expect(all, g).toMatch(new RegExp(`[ ,]${g}(,|$)`, 'm'))
    for (const line of all.split('\n')) expect(line.length, line).toBeLessThanOrEqual(78)
    expect(all).toMatch(/^not stated: applescript, elixir/m)
    expect(() => grammarNotice({ version: '4.6.0', names: ['typescript'] })).toThrow(/@shikijs\/langs is 4\.6\.0.*update them/)
    expect(() => grammarNotice({ version: PINNED.langs, names: ['typescript', 'cobol'] })).toThrow(/no licence for the grammar\(s\) cobol/)
    expect(() => releaseNotices({ licence: '', electron, shiki: { ...shiki, vscodeOniguruma: '1.8.0' }, grammars: ['typescript'], more: [] })).toThrow(/vscode-oniguruma 1\.8\.0.*update them/)

    // the grammars a build holds, from its modules' paths as its source maps list them
    const modules = [`${LANGS}/dist/typescript.mjs`, `${LANGS}/dist/css.mjs`, `${LANGS}/dist/css.mjs`, '/r/node_modules/@shikijs/langs/dist/go.mjs', '../../node_modules/shiki/dist/core.mjs', 'src/main.ts']
    expect(shippedGrammars(modules)).toEqual(['css', 'go', 'typescript'])
    expect(() => shippedGrammars(['src/main.ts'])).toThrow(/no grammar of @shikijs\/langs/)

    // this tree: the installed Shiki is the pinned one, and the table is every grammar the viewer loads or embeds
    const installed = installedShiki(root)
    expect({ langs: installed.langs, vscodeOniguruma: installed.vscodeOniguruma }).toEqual(shiki)
    const langs = installed.langsDir
    const viewer = fs.readFileSync(path.join(root, 'app/renderer/src/features/viewer/worker/grammars.ts'), 'utf8')
    const loads = new Set<string>()
    const load = (name: string): void => {
      if (loads.has(name)) return
      loads.add(name)
      for (const m of fs.readFileSync(path.join(langs, 'dist', `${name}.mjs`), 'utf8').matchAll(/^import \w+ from '\.\/([^']+)\.mjs'/gm)) load(m[1] as string)
    }
    for (const m of viewer.matchAll(/import\('shiki\/langs\/([^']+)\.mjs'\)/g)) load(m[1] as string)
    expect([...loads].sort()).toEqual(KNOWN_GRAMMARS)
  })
})
